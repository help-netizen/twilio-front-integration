'use strict';

const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const db = require('../backend/src/db/connection');
const readService = require('../backend/src/services/chatgptMcpReadService');

const ORDER_LIST_SCHEMA = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '207_estimate_invoice_order_list.sql'),
    'utf8'
);

jest.setTimeout(30000);

function probeDatabase() {
    const probeEnv = { ...process.env };
    delete probeEnv.NODE_USE_SYSTEM_CA;
    const pgModule = require.resolve('pg');
    const script = `
        const { Client } = require(${JSON.stringify(pgModule)});
        const client = new Client({
            connectionString: process.env.DATABASE_URL || 'postgresql://localhost/twilio_calls',
            connectionTimeoutMillis: 2000,
        });
        (async () => {
            try { await client.connect(); await client.query('SELECT 1'); await client.end(); process.exit(0); }
            catch (error) { process.stderr.write(String(error.message || error)); try { await client.end(); } catch {} process.exit(2); }
        })();`;
    const result = spawnSync(process.execPath, ['--use-bundled-ca', '-e', script], {
        env: probeEnv,
        encoding: 'utf8',
        timeout: 6000,
    });
    return {
        ready: result.status === 0,
        reason: String(result.stderr || result.error?.message || `probe exit ${result.status}`).trim(),
    };
}

const DATABASE = probeDatabase();
const databaseTest = DATABASE.ready ? test : test.skip;
if (!DATABASE.ready) {
    test('APP-DATA-001 Phase C DB release blocker: PostgreSQL must be available', () => {
        throw new Error(`APP-DATA-001 Phase C DB tests are pending: ${DATABASE.reason}`);
    });
}

function authority(companyId) {
    return {
        companyId,
        companyTimezone: 'America/New_York',
        ownerUserId: randomUUID(),
        ownerRoleKey: 'manager',
        ownerPermissions: ['estimates.view'],
        ownerScopes: {},
    };
}

async function snapshotEstimatePartition(client, companyId) {
    const { rows } = await client.query(
        `SELECT jsonb_build_object(
            'estimates', (
                SELECT COALESCE(jsonb_agg(to_jsonb(estimate_row) ORDER BY estimate_row.id), '[]'::jsonb)
                FROM estimates estimate_row
                WHERE estimate_row.company_id = $1
            ),
            'items', (
                SELECT COALESCE(jsonb_agg(to_jsonb(item_row) ORDER BY item_row.id), '[]'::jsonb)
                FROM estimate_items item_row
                JOIN estimates estimate_owner
                  ON estimate_owner.id = item_row.estimate_id
                 AND estimate_owner.company_id = $1
            )
        ) AS snapshot`,
        [companyId]
    );
    return rows[0].snapshot;
}

describe('APP-DATA-001 Phase C Estimate read tools', () => {
    databaseTest('T-own/T-foreign/T-blast and company-day accepted bounds hold for list/get', async () => {
        const client = await db.pool.connect();
        let dbSpy;
        try {
            await client.query('BEGIN');
            await client.query(ORDER_LIST_SCHEMA);
            const companyA = randomUUID();
            const companyB = randomUUID();
            const marker = `phase-c-${randomUUID()}`;
            await client.query(
                `INSERT INTO companies (id, name, slug, status, timezone)
                 VALUES ($1, 'APP DATA A', $3, 'active', 'America/New_York'),
                        ($2, 'APP DATA B', $4, 'active', 'America/New_York')`,
                [
                    companyA,
                    companyB,
                    `app-data-a-${randomUUID()}`,
                    `app-data-b-${randomUUID()}`,
                ]
            );
            const { rows: estimates } = await client.query(
                `INSERT INTO estimates
                    (company_id, estimate_number, status, summary, subtotal,
                     tax_amount, total, accepted_at, order_list)
                 VALUES
                    ($1, $3::varchar, 'approved', $3::text, 289.00, 18.06, 307.06,
                     '2026-08-02T03:30:00.000Z', $4::jsonb),
                    ($2, $3::varchar, 'approved', $3::text, 999.00, 62.44, 1061.44,
                     '2026-08-02T03:30:00.000Z', $5::jsonb)
                 RETURNING id, company_id`,
                [
                    companyA,
                    companyB,
                    marker,
                    JSON.stringify([{
                        part_number: 'WD19X25700',
                        part_name: 'Dishwasher Drain Pump',
                        quantity: 1,
                    }]),
                    JSON.stringify([{
                        part_number: 'DA97-07603B',
                        part_name: 'Foreign Ice Maker',
                        quantity: 9,
                    }]),
                ]
            );
            const estimateA = estimates.find(row => row.company_id === companyA).id;
            const estimateB = estimates.find(row => row.company_id === companyB).id;
            await client.query(
                `INSERT INTO estimate_items
                    (estimate_id, sort_order, name, description, quantity, unit,
                     unit_price, amount, item_type)
                 VALUES
                    ($1, 0, 'Dishwasher drain pump', 'Owned A item', 1, 'each', 289, 289, 'part'),
                    ($2, 0, 'Foreign ice maker', 'Foreign B item', 1, 'each', 999, 999, 'part')`,
                [estimateA, estimateB]
            );

            const beforeB = await snapshotEstimatePartition(client, companyB);
            dbSpy = jest.spyOn(db, 'query').mockImplementation((text, params) => (
                client.query(text, params)
            ));

            const listed = await readService.execute('listEstimates', authority(companyA), {
                status: 'approved',
                accepted_from: '2026-08-01',
                accepted_to: '2026-08-01',
                search: marker,
                limit: 100,
                offset: 0,
            });
            expect(listed.results.map(row => row.id)).toEqual([estimateA]);
            expect(listed.results[0]).toEqual(expect.objectContaining({
                accepted_at: '2026-08-02T03:30:00.000Z',
                items_count: 1,
                order_list_count: 1,
            }));
            const nextDay = await readService.execute('listEstimates', authority(companyA), {
                accepted_from: '2026-08-02',
                accepted_to: '2026-08-02',
                search: marker,
                limit: 100,
                offset: 0,
            });
            expect(nextDay.results).toEqual([]);

            const detail = await readService.execute('getEstimate', authority(companyA), {
                estimate_id: Number(estimateA),
            });
            expect(detail.items).toEqual([
                expect.objectContaining({ name: 'Dishwasher drain pump', item_type: 'part' }),
            ]);
            expect(detail.order_list).toEqual([{
                part_number: 'WD19X25700',
                part_name: 'Dishwasher Drain Pump',
                quantity: 1,
            }]);
            await expect(readService.execute('getEstimate', authority(companyA), {
                estimate_id: Number(estimateB),
            })).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
            expect(await snapshotEstimatePartition(client, companyB)).toEqual(beforeB);
        } finally {
            dbSpy?.mockRestore();
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });
});
