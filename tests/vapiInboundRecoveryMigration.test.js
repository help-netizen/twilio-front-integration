'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const FORWARD = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '285_vapi_inbound_recovery_cases.sql'),
    'utf8',
);
const ROLLBACK = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', 'rollback_285_vapi_inbound_recovery_cases.sql'),
    'utf8',
);

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

test('migration 285 is structural, repeatable, and rollback-safe', async () => {
    await client.query(FORWARD);
    await client.query(FORWARD);

    const shape = await client.query(
        `SELECT
             to_regclass('vapi_inbound_recovery_cases')::text AS table_name,
             EXISTS (
                 SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'vapi_inbound_recovery_cases'::regclass
                   AND contype = 'p'
             ) AS global_provider_call_key,
             EXISTS (
                 SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'vapi_inbound_recovery_cases'
                   AND column_name = 'next_retry_at'
             ) AS retry_state,
             to_regclass('idx_vapi_inbound_recovery_retry')::text AS retry_index`,
    );
    expect(shape.rows[0]).toEqual({
        table_name: 'vapi_inbound_recovery_cases',
        global_provider_call_key: true,
        retry_state: true,
        retry_index: 'idx_vapi_inbound_recovery_retry',
    });

    await client.query(ROLLBACK);
    const removed = await client.query(
        `SELECT to_regclass('vapi_inbound_recovery_cases')::text AS table_name`,
    );
    expect(removed.rows[0].table_name).toBeNull();

    await client.query(FORWARD);
    const restored = await client.query(
        `SELECT to_regclass('vapi_inbound_recovery_cases')::text AS table_name`,
    );
    expect(restored.rows[0].table_name).toBe('vapi_inbound_recovery_cases');
});
