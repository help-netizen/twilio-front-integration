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

const FORWARD_266 = migration('266_vapi_call_identity_and_usage.sql');
const FORWARD_267 = migration('267_vapi_provisional_usage_ingest.sql');
const FORWARD_269 = migration('269_vapi_usage_reconcile_and_finalization.sql');
const ROLLBACK_269 = migration('rollback_269_vapi_usage_reconcile_and_finalization.sql');

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

test('migration 269 is repeatable, rollback-safe before evidence, and restores T4 schema', async () => {
    await client.query(FORWARD_266);
    await client.query(FORWARD_267);
    await client.query(FORWARD_269);
    await client.query(FORWARD_269);

    const forward = await client.query(
        `SELECT
             to_regclass('vapi_call_usage_final_snapshots')::text AS snapshots,
             to_regclass('vapi_call_usage_adjustments')::text AS adjustments,
             to_regclass('vapi_usage_audit_runs')::text AS audits,
             to_regclass('vapi_usage_alerts')::text AS alerts,
             EXISTS (
                 SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'vapi_call_usage'
                   AND column_name = 'reconcile_claim_token'
             ) AS claim_token,
             EXISTS (
                 SELECT 1 FROM pg_constraint
                 WHERE conname = 'fk_vapi_usage_adjustment_to_snapshot'
             ) AS adjustment_snapshot_fk,
             EXISTS (
                 SELECT 1 FROM pg_trigger
                 WHERE tgname = 'trg_vapi_final_snapshot_immutable'
                   AND NOT tgisinternal
             ) AS immutable_trigger`,
    );
    expect(forward.rows[0]).toEqual({
        snapshots: 'vapi_call_usage_final_snapshots',
        adjustments: 'vapi_call_usage_adjustments',
        audits: 'vapi_usage_audit_runs',
        alerts: 'vapi_usage_alerts',
        claim_token: true,
        adjustment_snapshot_fk: true,
        immutable_trigger: true,
    });

    await client.query(ROLLBACK_269);
    const rolledBack = await client.query(
        `SELECT
             to_regclass('vapi_call_usage_final_snapshots')::text AS snapshots,
             NOT EXISTS (
                 SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'vapi_call_usage'
                   AND column_name = 'reconcile_claim_token'
             ) AS claim_removed`,
    );
    expect(rolledBack.rows[0]).toEqual({ snapshots: null, claim_removed: true });

    await client.query(FORWARD_269);
    const restored = await client.query(
        `SELECT to_regclass('vapi_call_usage_final_snapshots')::text AS snapshots`,
    );
    expect(restored.rows[0].snapshots).toBe('vapi_call_usage_final_snapshots');
});
