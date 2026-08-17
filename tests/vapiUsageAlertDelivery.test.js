'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const {
    configuration,
    createVapiUsageAlertDeliveryService,
} = require('../backend/src/services/vapiUsageAlertDeliveryService');

const MIGRATIONS = [
    '266_vapi_call_identity_and_usage.sql',
    '267_vapi_provisional_usage_ingest.sql',
    '269_vapi_usage_reconcile_and_finalization.sql',
    '270_vapi_provider_message_quarantine.sql',
    '272_vapi_loss_protection.sql',
].map((filename) => fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', filename),
    'utf8',
));

let pool;
let client;
let sendEmail;
let service;

async function insertAlert({
    kind,
    providerCallId,
    cost,
    basis = cost === null ? 'unknown' : 'supplier',
    createdAt,
    details = {},
}) {
    await client.query(
        `INSERT INTO vapi_usage_alerts (
             provider_call_id, kind, dedupe_key, details,
             supplier_cost_at_risk, cost_basis, created_at, updated_at
         ) VALUES ($1, $2, $3, $4::jsonb, $5::numeric, $6, $7, $7)`,
        [
            providerCallId,
            kind,
            `${kind}:${providerCallId}`,
            JSON.stringify(details),
            cost,
            basis,
            createdAt,
        ],
    );
}

function testConfig(overrides = {}) {
    return {
        ...configuration({
            VAPI_USAGE_ALERT_RECIPIENT: 'support@example.test',
            VAPI_USAGE_ALERT_SENDER_COMPANY_ID: '00000000-0000-0000-0000-000000000001',
            VAPI_USAGE_ALERT_THRESHOLD_USD: '10',
            VAPI_USAGE_ALERT_DIGEST_INTERVAL_MINUTES: '60',
        }),
        ...overrides,
    };
}

beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
    await client.query('BEGIN');
    for (const migration of MIGRATIONS) await client.query(migration);
});

beforeEach(async () => {
    await client.query(
        `TRUNCATE vapi_usage_alert_delivery_items,
                  vapi_usage_alert_delivery_runs, vapi_usage_alerts`,
    );
    sendEmail = jest.fn().mockResolvedValue({ provider_message_id: 'mail-1' });
    service = createVapiUsageAlertDeliveryService({
        withTransaction: (work) => work(client),
        emailService: { sendEmail },
    });
});

afterAll(async () => {
    if (client) {
        await client.query('ROLLBACK');
        client.release();
    }
    if (pool) await pool.end();
});

describe('VAPI-AGENCY-001 monetary-risk alert delivery', () => {
    test('one due digest covers many alerts and unchanged state never spams again', async () => {
        const now = new Date('2026-08-16T12:00:00.000Z');
        const createdAt = new Date('2026-08-16T10:00:00.000Z');
        await insertAlert({
            kind: 'provider_orphan',
            providerCallId: 'provider-orphan-a',
            cost: '1.25',
            createdAt,
            details: { transcript: 'must never be emailed', phone: '+15555550100' },
        });
        await insertAlert({
            kind: 'local_missing',
            providerCallId: 'provider-missing-b',
            cost: '2.50',
            createdAt,
        });

        const first = await service.dispatchAlerts({ now, config: testConfig() });
        const repeated = await service.dispatchAlerts({
            now: new Date('2026-08-16T14:00:00.000Z'),
            config: testConfig(),
        });

        expect(first).toMatchObject({
            sent: true,
            reason: 'digest',
            alertCount: 2,
            supplierCostAtRisk: '3.75',
        });
        expect(repeated).toEqual({ skipped: true, reason: 'unchanged' });
        expect(sendEmail).toHaveBeenCalledTimes(1);
        const message = sendEmail.mock.calls[0][1];
        expect(message.textBody.split('\n')[0]).toBe(
            'At-risk supplier cost: $3.75; $0.00 is fallback-estimated; '
                + '0 call(s) still have unknown cost.',
        );
        expect(message.textBody).toContain('provider_call_id=provider-orphan-a');
        expect(message.textBody).not.toContain('must never be emailed');
        expect(message.textBody).not.toContain('+15555550100');
        const marked = await client.query(
            `SELECT count(*)::int AS count
             FROM vapi_usage_alerts
             WHERE last_delivered_at IS NOT NULL
               AND last_delivery_run_id IS NOT NULL`,
        );
        expect(marked.rows[0].count).toBe(2);
    });

    test('cost above the configured threshold sends before the digest window', async () => {
        const now = new Date('2026-08-16T12:00:00.000Z');
        await insertAlert({
            kind: 'provider_orphan',
            providerCallId: 'provider-expensive',
            cost: '10.000000000001',
            createdAt: now,
        });

        const result = await service.dispatchAlerts({ now, config: testConfig() });

        expect(result).toMatchObject({ sent: true, reason: 'threshold' });
        expect(sendEmail).toHaveBeenCalledTimes(1);
        const run = await client.query(
            `SELECT reason, supplier_cost_at_risk::text, threshold_amount::text
             FROM vapi_usage_alert_delivery_runs`,
        );
        expect(run.rows).toEqual([{
            reason: 'threshold',
            supplier_cost_at_risk: '10.000000000001',
            threshold_amount: '10.000000000000',
        }]);
    });

    test('the same provider call in two alert classes contributes money once', async () => {
        const createdAt = new Date('2026-08-16T10:00:00.000Z');
        await insertAlert({
            kind: 'provider_orphan',
            providerCallId: 'provider-shared',
            cost: '0.40',
            createdAt,
        });
        await insertAlert({
            kind: 'quarantined',
            providerCallId: 'provider-shared',
            cost: '0.40',
            createdAt,
        });

        const result = await service.dispatchAlerts({
            now: new Date('2026-08-16T12:00:00.000Z'),
            config: testConfig(),
        });

        expect(result).toMatchObject({
            sent: true,
            alertCount: 2,
            supplierCostAtRisk: '0.4',
        });
        expect(sendEmail.mock.calls[0][1].textBody.split('\n')[0])
            .toContain('$0.40');
    });

    test('an unseen call with unknown duration stays unknown instead of receiving an estimate', async () => {
        await insertAlert({
            kind: 'provider_orphan',
            providerCallId: 'provider-no-duration',
            cost: null,
            createdAt: new Date('2026-08-16T10:00:00.000Z'),
        });

        await service.dispatchAlerts({
            now: new Date('2026-08-16T12:00:00.000Z'),
            config: testConfig(),
        });

        const run = await client.query(
            `SELECT supplier_cost_at_risk::text, unknown_cost_count
             FROM vapi_usage_alert_delivery_runs`,
        );
        expect(run.rows).toEqual([{
            supplier_cost_at_risk: '0.000000000000',
            unknown_cost_count: 1,
        }]);
    });
});
