'use strict';

/**
 * ZBPAY-MIGRATE-001 P1 — vocabulary migration and real-PostgreSQL dedupe.
 *
 * The structural controls always run. The PostgreSQL leg self-skips when the
 * local test database is unavailable and rolls every schema/data change back.
 */

const fs = require('fs');
const path = require('path');
const db = require('../backend/src/db/connection');
const { projectCompanyLedger } = require('../backend/src/services/zenbookerPaymentsSyncService');

jest.setTimeout(30000);

const MIGRATION_FILE = '182_zb_payment_methods.sql';
const ROLLBACK_FILE = 'rollback_182_zb_payment_methods.sql';
const MIGRATIONS_DIR = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const SYNC_SERVICE_FILE = path.join(
    __dirname, '..', 'backend', 'src', 'services', 'zenbookerPaymentsSyncService.js'
);
const METHODS = ['zb_card', 'zb_check', 'zb_cash', 'zb_ach', 'zb_venmo', 'zb_zelle', 'zb_other'];
const TAG = `ZBPAY-${Date.now()}-${process.pid}`;

function readSql(filename) {
    return fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
}

async function withTxn(work) {
    const client = await db.pool.connect();
    let began = false;
    try {
        await client.query('BEGIN');
        began = true;
        return await work(client);
    } finally {
        try {
            if (began) await client.query('ROLLBACK');
        } finally {
            client.release();
        }
    }
}

describe('migration 182 vocabulary controls', () => {
    it('ships the exact mirror vocabulary and a rollback to the legacy method', () => {
        const migration = readSql(MIGRATION_FILE);
        const rollback = readSql(ROLLBACK_FILE);
        const service = fs.readFileSync(SYNC_SERVICE_FILE, 'utf8');

        expect(migration).toContain('payment_transactions_payment_method_check');
        expect(migration).toContain("'zenbooker_sync'");
        for (const method of METHODS) expect(migration).toContain(`'${method}'`);
        expect(rollback).toContain("SET payment_method = 'zenbooker_sync'");
        for (const method of METHODS) expect(rollback).toContain(`'${method}'`);
        expect(service).toContain('ON CONFLICT (company_id, transaction_id) DO UPDATE');
        expect(service).toMatch(/ON CONFLICT \(company_id, external_id\) WHERE external_source = 'zenbooker'/);
    });

    it('CTRL-ZBPAY-RERUN-DEDUPE: double apply + duplicate landing/projector converge to one row', async () => {
        let reachable = true;
        try {
            await db.query('SELECT 1 FROM payment_transactions LIMIT 1');
        } catch (error) {
            reachable = false;
            console.warn(`CTRL-ZBPAY-RERUN-DEDUPE SKIPPED-NEEDS-DB — ${error.message}`);
        }
        if (!reachable) return;

        await withTxn(async client => {
            const migration = readSql(MIGRATION_FILE);
            const rollback = readSql(ROLLBACK_FILE);
            await client.query('LOCK TABLE payment_transactions IN ACCESS EXCLUSIVE MODE');
            await client.query(migration);
            await client.query(migration);

            const companyResult = await client.query('SELECT id FROM companies ORDER BY id LIMIT 1');
            if (!companyResult.rows[0]) {
                console.warn('CTRL-ZBPAY-RERUN-DEDUPE SKIPPED-NEEDS-COMPANY');
                return;
            }
            const companyId = companyResult.rows[0].id;
            const externalId = `${TAG}-tx`;
            const landingUpsert = `
                INSERT INTO zb_payments (
                    company_id, transaction_id, payment_methods,
                    display_payment_method, amount_paid, payment_date,
                    transaction_status, zb_raw_transaction
                ) VALUES ($1, $2, 'stripe (visa)', 'visa', 95, NOW(), 'succeeded',
                          '{"payment_method":"stripe","stripe_card_brand":"visa"}'::jsonb)
                ON CONFLICT (company_id, transaction_id) DO UPDATE
                SET amount_paid = EXCLUDED.amount_paid,
                    zb_raw_transaction = EXCLUDED.zb_raw_transaction`;

            await client.query(landingUpsert, [companyId, externalId]);
            await client.query(landingUpsert, [companyId, externalId]);
            const legacyLedger = await client.query(
                `INSERT INTO payment_transactions (
                    company_id, transaction_type, payment_method, status,
                    amount, external_id, external_source, metadata
                 ) VALUES ($1, 'payment', 'zenbooker_sync', 'pending', 0, $2, 'zenbooker', '{"kept":"yes"}'::jsonb)
                 RETURNING id`,
                [companyId, externalId],
            );
            await projectCompanyLedger(companyId, client);
            const firstLedger = await client.query(
                `SELECT id, metadata FROM payment_transactions
                 WHERE company_id = $1 AND external_source = 'zenbooker' AND external_id = $2`,
                [companyId, externalId],
            );
            await projectCompanyLedger(companyId, client);

            const landing = await client.query(
                'SELECT count(*)::int AS count FROM zb_payments WHERE company_id = $1 AND transaction_id = $2',
                [companyId, externalId],
            );
            const ledger = await client.query(
                `SELECT count(*)::int AS count, min(id)::text AS id, min(payment_method) AS payment_method
                 FROM payment_transactions
                 WHERE company_id = $1 AND external_source = 'zenbooker' AND external_id = $2`,
                [companyId, externalId],
            );
            expect(landing.rows[0].count).toBe(1);
            expect(String(firstLedger.rows[0].id)).toBe(String(legacyLedger.rows[0].id));
            expect(firstLedger.rows[0].metadata).toMatchObject({
                kept: 'yes',
                zb_payment_method: 'stripe',
                zb_card_brand: 'visa',
            });
            expect(ledger.rows[0]).toMatchObject({
                count: 1,
                id: String(firstLedger.rows[0].id),
                payment_method: 'zb_card',
            });

            await client.query(rollback);
            await client.query(rollback);
            const legacy = await client.query(
                `SELECT payment_method FROM payment_transactions
                 WHERE company_id = $1 AND external_source = 'zenbooker' AND external_id = $2`,
                [companyId, externalId],
            );
            expect(legacy.rows[0].payment_method).toBe('zenbooker_sync');
        });
    });
});

afterAll(async () => {
    try { await db.pool.end(); } catch (_) { /* ignore */ }
});
