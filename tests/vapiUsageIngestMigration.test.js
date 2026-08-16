'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const FORWARD_266 = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '266_vapi_call_identity_and_usage.sql'),
    'utf8',
);
const FORWARD_267 = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '267_vapi_provisional_usage_ingest.sql'),
    'utf8',
);
const ROLLBACK_267 = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', 'rollback_267_vapi_provisional_usage_ingest.sql'),
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

test('migration 267 is repeatable, rollback-safe before ingest, and restores its evidence schema', async () => {
    await client.query(FORWARD_266);
    await client.query(FORWARD_267);
    await client.query(FORWARD_267);

    const forward = await client.query(
        `SELECT
             EXISTS (
                 SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'vapi_call_usage_observations'
                   AND column_name = 'sanitized_payload'
                   AND data_type = 'jsonb'
             ) AS sanitized_payload,
             EXISTS (
                 SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'vapi_call_usage'
                   AND column_name = 'provisional_observation_id'
             ) AS provisional_observation,
             EXISTS (
                 SELECT 1 FROM pg_constraint
                 WHERE conname = 'fk_vapi_usage_observation_status_credential'
             ) AS status_credential_fk,
             EXISTS (
                 SELECT 1 FROM pg_constraint
                 WHERE conname = 'fk_vapi_call_usage_provisional_observation'
             ) AS provisional_observation_fk`,
    );
    expect(forward.rows[0]).toEqual({
        sanitized_payload: true,
        provisional_observation: true,
        status_credential_fk: true,
        provisional_observation_fk: true,
    });

    await client.query(ROLLBACK_267);
    const rolledBack = await client.query(
        `SELECT
             EXISTS (
                 SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'vapi_call_usage_observations'
                   AND column_name = 'sanitized_payload'
             ) AS sanitized_payload,
             to_regclass('vapi_call_usage_observations')::text AS observations`,
    );
    expect(rolledBack.rows[0]).toEqual({
        sanitized_payload: false,
        observations: 'vapi_call_usage_observations',
    });

    await client.query(FORWARD_267);
    const restored = await client.query(
        `SELECT EXISTS (
             SELECT 1 FROM information_schema.columns
             WHERE table_name = 'vapi_call_usage_observations'
               AND column_name = 'sanitized_payload'
         ) AS sanitized_payload`,
    );
    expect(restored.rows[0].sanitized_payload).toBe(true);
});
