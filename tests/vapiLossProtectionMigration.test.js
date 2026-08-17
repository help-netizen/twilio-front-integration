'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

function migration(filename) {
    return fs.readFileSync(
        path.join(__dirname, '..', 'backend', 'db', 'migrations', filename),
        'utf8',
    );
}

const FORWARD = [
    '266_vapi_call_identity_and_usage.sql',
    '267_vapi_provisional_usage_ingest.sql',
    '269_vapi_usage_reconcile_and_finalization.sql',
    '270_vapi_provider_message_quarantine.sql',
    '272_vapi_loss_protection.sql',
].map(migration);
const ROLLBACK_272 = migration('rollback_272_vapi_loss_protection.sql');

let pool;
let client;

beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
    await client.query('BEGIN');
});

afterAll(async () => {
    if (client) {
        await client.query('ROLLBACK');
        client.release();
    }
    if (pool) await pool.end();
});

test('migration 272 is repeatable and restores the pre-loss-protection schema', async () => {
    for (const sql of FORWARD) await client.query(sql);
    await client.query(FORWARD[FORWARD.length - 1]);

    const forward = await client.query(
        `SELECT
             to_regclass('vapi_call_cost_input_events')::text AS cost_events,
             to_regclass('vapi_usage_alert_delivery_runs')::text AS delivery_runs,
             to_regclass('vapi_usage_alert_delivery_items')::text AS delivery_items,
             (SELECT rate_per_started_minute::text
              FROM vapi_fallback_rate_policies
              WHERE effective_to IS NULL) AS default_rate,
             pg_get_constraintdef(oid) LIKE '%provider_call_collision%'
                AND pg_get_constraintdef(oid) NOT LIKE '%audit_failed%'
                AS exact_alert_contract
         FROM pg_constraint
         WHERE conname = 'chk_vapi_usage_alert_kind'`,
    );
    expect(forward.rows).toEqual([{
        cost_events: 'vapi_call_cost_input_events',
        delivery_runs: 'vapi_usage_alert_delivery_runs',
        delivery_items: 'vapi_usage_alert_delivery_items',
        default_rate: '0.250000000000',
        exact_alert_contract: true,
    }]);

    await client.query(ROLLBACK_272);
    const rolledBack = await client.query(
        `SELECT
             to_regclass('vapi_call_cost_input_events')::text AS cost_events,
             to_regclass('vapi_usage_alert_delivery_runs')::text AS delivery_runs,
             NOT EXISTS (
                 SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'vapi_usage_alerts'
                   AND column_name = 'last_delivered_at'
             ) AS delivery_columns_removed`,
    );
    expect(rolledBack.rows).toEqual([{
        cost_events: null,
        delivery_runs: null,
        delivery_columns_removed: true,
    }]);

    await client.query(FORWARD[FORWARD.length - 1]);
    const restored = await client.query(
        `SELECT to_regclass('vapi_call_cost_input_events')::text AS cost_events`,
    );
    expect(restored.rows[0].cost_events).toBe('vapi_call_cost_input_events');
});
