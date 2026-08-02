'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const paymentsService = require('../backend/src/services/zenbookerPaymentsSyncService');

jest.setTimeout(60000);

const TAG = `PAYLEDGER-${Date.now()}-${process.pid}`;
const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const migrationSql = fs.readFileSync(path.join(MIGRATIONS, '227_unify_payments_ledger.sql'), 'utf8');
const rollbackSql = fs.readFileSync(path.join(MIGRATIONS, 'rollback_227_unify_payments_ledger.sql'), 'utf8');

let client;
let originalQuery;
let companyA;
let companyB;
let zbPaymentA;
let foreignPayment;
let nativeCheck;

async function insertPayment(companyId, {
    method,
    status = 'completed',
    amount,
    source,
    externalId = null,
    metadata = {},
    reference = null,
    memo = null,
}) {
    const { rows } = await client.query(
        `INSERT INTO payment_transactions (
            company_id, transaction_type, payment_method, status,
            amount, currency, reference_number, external_id, external_source,
            memo, metadata, processed_at
         ) VALUES (
            $1, 'payment', $2, $3,
            $4, 'USD', $5, $6, $7,
            $8, $9::jsonb, now()
         )
         RETURNING *`,
        [
            companyId, method, status, amount, reference, externalId,
            source, memo, JSON.stringify(metadata),
        ]
    );
    return rows[0];
}

beforeAll(async () => {
    originalQuery = db.query;
    client = await db.pool.connect();
    await client.query('BEGIN');
    db.query = (text, params) => client.query(text, params);

    companyA = randomUUID();
    companyB = randomUUID();
    await client.query(
        `INSERT INTO companies (id, name, slug)
         VALUES ($1, $2, $3), ($4, $5, $6)`,
        [
            companyA, `${TAG} A`, `${TAG.toLowerCase()}-a`,
            companyB, `${TAG} B`, `${TAG.toLowerCase()}-b`,
        ]
    );

    const sharedExternalId = `${TAG}-shared-zb`;
    zbPaymentA = await insertPayment(companyA, {
        // The shared local test DB may predate migration 182; the presentation
        // row below still proves legacy zenbooker_sync checks are recognized.
        method: 'zenbooker_sync', amount: 100, source: 'zenbooker',
        externalId: sharedExternalId,
        metadata: { zb_job_id: `${TAG}-missing-job` },
        reference: `${TAG}-invoice`,
    });
    foreignPayment = await insertPayment(companyB, {
        method: 'zenbooker_sync', amount: 900, source: 'zenbooker',
        externalId: sharedExternalId,
        metadata: { check_deposited: false },
    });
    nativeCheck = await insertPayment(companyA, {
        method: 'check', status: 'pending', amount: 5,
        source: null, reference: `${TAG}-check`, memo: 'Native check',
    });
    await insertPayment(companyA, {
        method: 'credit_card', amount: 25, source: 'stripe',
        externalId: `${TAG}-stripe`,
    });
    await insertPayment(companyA, {
        method: 'cash', amount: 10, source: 'manual', memo: 'Manual cash',
    });
    await insertPayment(companyA, {
        method: 'cash', status: 'voided', amount: 7, source: 'manual',
        memo: 'Voided cash',
    });

    await client.query(
        `INSERT INTO zb_payments (
            company_id, transaction_id, invoice_id, job_id,
            client, payment_methods, display_payment_method, amount_paid,
            payment_date, transaction_status, check_deposited,
            invoice_detail, attachments, metadata
         ) VALUES
            ($1, $3, $4, $5, 'ZB Customer', 'check', 'check', 999,
             now(), 'failed', true,
             '{"status":"paid","total":"100.00","amount_paid":"100.00","amount_due":"0.00","paid_in_full":true}'::jsonb,
             '[{"url":"https://example.test/check.jpg","kind":"image","source":"job_note","note_id":null,"filename":"check.jpg"}]'::jsonb,
             '{"transaction_id":"presentation-only"}'::jsonb),
            ($2, $3, NULL, NULL, 'Foreign ZB Customer', 'check', 'check', 900,
             now(), 'succeeded', true, NULL, '[]'::jsonb, '{}'::jsonb)`,
        [companyA, companyB, sharedExternalId, `${TAG}-invoice`, `${TAG}-missing-job`]
    );
});

afterAll(async () => {
    db.query = originalQuery;
    if (client) {
        try {
            await client.query('ROLLBACK');
        } finally {
            client.release();
        }
    }
    await db.pool.end();
});

describe('PAY-LEDGER-UNIFY-001 real PostgreSQL controls', () => {
    test('CTRL-PAY-LEDGER-BACKFILL-WINS: migration is idempotent and preserves canonical decisions', async () => {
        await client.query(migrationSql);
        await client.query(migrationSql);

        const { rows } = await client.query(
            `SELECT company_id, metadata
             FROM payment_transactions
             WHERE external_id = $1
             ORDER BY company_id`,
            [`${TAG}-shared-zb`]
        );
        const own = rows.find(row => row.company_id === companyA);
        const foreign = rows.find(row => row.company_id === companyB);
        expect(own.metadata).toMatchObject({
            check_deposited: true,
            pay_ledger_unify_001_check_deposited_backfill: true,
        });
        expect(foreign.metadata).toEqual({ check_deposited: false });
    });

    test('CTRL-PAY-LEDGER-NO-UNION and CTRL-PAY-LEDGER-MONEY: every canonical source appears once', async () => {
        const page = await paymentsService.listPayments(companyA, { limit: 50 });

        expect(page.rows).toHaveLength(5);
        expect(page.aggregates).toEqual({ transaction_count: 5, total_amount: '147.00' });
        expect(page.rows.filter(row => row.transaction_id === `${TAG}-shared-zb`)).toHaveLength(1);
        expect(page.rows.map(row => row.external_source)).toEqual(expect.arrayContaining([
            'zenbooker', 'stripe', 'manual', null,
        ]));
        expect(page.rows.find(row => String(row.id) === String(zbPaymentA.id))).toMatchObject({
            amount_paid: '100.00',
            payment_status: 'completed',
            transaction_status: 'succeeded',
            check_deposited: true,
        });
        expect(page.facets).toMatchObject({ undeposited_check_count: 1 });
    });

    test('canonical export and rich ZB detail retain all sources without trusting ZB money/status', async () => {
        const exported = await paymentsService.listPaymentsForExport(companyA);
        expect(exported).toHaveLength(5);
        expect(exported.map(row => row.external_source)).toEqual(expect.arrayContaining([
            'zenbooker', 'stripe', 'manual', null,
        ]));

        const detail = await paymentsService.getPaymentDetail(companyA, zbPaymentA.id);
        expect(detail).toMatchObject({
            id: zbPaymentA.id,
            amount_paid: '100.00',
            payment_status: 'completed',
            transaction_status: 'succeeded',
            external_source: 'zenbooker',
            check_deposited: true,
        });
        expect(detail.invoice).toMatchObject({ total: '100.00', paid_in_full: true });
        expect(detail.attachments).toHaveLength(1);
        expect(detail.metadata).not.toHaveProperty('pay_ledger_unify_001_check_deposited_backfill');

        await expect(paymentsService.getPaymentDetail(companyB, zbPaymentA.id)).resolves.toBeNull();
    });

    test('CTRL-PAY-LEDGER-NATIVE-CHECK and CTRL-PAY-LEDGER-T-BLAST: PATCH is canonical and tenant-isolated', async () => {
        const beforeForeign = await client.query(
            `SELECT metadata::text AS metadata
             FROM payment_transactions
             WHERE company_id = $1 AND id = $2`,
            [companyB, foreignPayment.id]
        );

        const before = await paymentsService.listPayments(companyA, {
            quickFilter: 'new_checks', limit: 50,
        });
        expect(before.rows.map(row => String(row.id))).toContain(String(nativeCheck.id));

        await expect(paymentsService.updateCheckDeposited(
            companyA, nativeCheck.id, true, client
        )).resolves.toEqual({ check_deposited: true });

        const after = await paymentsService.listPayments(companyA, {
            quickFilter: 'new_checks', limit: 50,
        });
        expect(after.rows.map(row => String(row.id))).not.toContain(String(nativeCheck.id));

        await expect(paymentsService.updateCheckDeposited(
            companyA, foreignPayment.id, true, client
        )).resolves.toBeNull();

        await expect(paymentsService.updateCheckDeposited(
            companyA, zbPaymentA.id, false, client
        )).resolves.toEqual({ check_deposited: false });
        const explicitDecision = await client.query(
            `SELECT metadata
             FROM payment_transactions
             WHERE company_id = $1 AND id = $2`,
            [companyA, zbPaymentA.id]
        );
        expect(explicitDecision.rows[0].metadata).toEqual({
            zb_job_id: `${TAG}-missing-job`,
            check_deposited: false,
        });

        const afterForeign = await client.query(
            `SELECT metadata::text AS metadata
             FROM payment_transactions
             WHERE company_id = $1 AND id = $2`,
            [companyB, foreignPayment.id]
        );
        expect(afterForeign.rows).toEqual(beforeForeign.rows);
    });

    test('rollback removes only migration-owned deposited metadata', async () => {
        await client.query(rollbackSql);
        const { rows } = await client.query(
            `SELECT company_id, metadata
             FROM payment_transactions
             WHERE external_id = $1
             ORDER BY company_id`,
            [`${TAG}-shared-zb`]
        );
        expect(rows.find(row => row.company_id === companyA).metadata).toEqual({
            zb_job_id: `${TAG}-missing-job`,
            check_deposited: false,
        });
        expect(rows.find(row => row.company_id === companyB).metadata).toEqual({
            check_deposited: false,
        });
    });
});
