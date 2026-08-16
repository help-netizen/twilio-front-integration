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
].map(migration);
const ROLLBACK_270 = migration('rollback_270_vapi_provider_message_quarantine.sql');

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

test('migration 270 is repeatable and restores the pre-quarantine alert contract', async () => {
    for (const sql of FORWARD) await client.query(sql);
    await client.query(FORWARD[FORWARD.length - 1]);

    const forward = await client.query(
        `SELECT
             to_regclass('vapi_provider_message_quarantine')::text AS quarantine,
             EXISTS (
                 SELECT 1 FROM pg_constraint
                 WHERE conname = 'fk_vapi_provider_quarantine_credential'
             ) AS credential_fk,
             pg_get_constraintdef(oid) LIKE '%provider_message_quarantined%'
                 AS alert_kind_extended
         FROM pg_constraint
         WHERE conname = 'chk_vapi_usage_alert_kind'`,
    );
    expect(forward.rows).toEqual([{
        quarantine: 'vapi_provider_message_quarantine',
        credential_fk: true,
        alert_kind_extended: true,
    }]);

    await client.query(ROLLBACK_270);
    const rolledBack = await client.query(
        `SELECT
             to_regclass('vapi_provider_message_quarantine')::text AS quarantine,
             pg_get_constraintdef(oid) NOT LIKE '%provider_message_quarantined%'
                 AS alert_kind_restored
         FROM pg_constraint
         WHERE conname = 'chk_vapi_usage_alert_kind'`,
    );
    expect(rolledBack.rows).toEqual([{
        quarantine: null,
        alert_kind_restored: true,
    }]);

    await client.query(FORWARD[FORWARD.length - 1]);
    const restored = await client.query(
        `SELECT to_regclass('vapi_provider_message_quarantine')::text AS quarantine`,
    );
    expect(restored.rows).toEqual([{
        quarantine: 'vapi_provider_message_quarantine',
    }]);
});
