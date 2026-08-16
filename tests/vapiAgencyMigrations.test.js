'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const FORWARD = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '266_vapi_call_identity_and_usage.sql'),
    'utf8',
);
const ROLLBACK = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', 'rollback_266_vapi_call_identity_and_usage.sql'),
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

test('migration 266 is repeatable, rollback-safe before use, and restores forward schema', async () => {
    await client.query(FORWARD);
    await client.query(FORWARD);

    const forward = await client.query(
        `SELECT
             to_regclass('vapi_call_sessions')::text AS sessions,
             to_regclass('vapi_call_usage_observations')::text AS observations,
             to_regclass('vapi_call_usage')::text AS usage,
             EXISTS (
                 SELECT 1 FROM pg_constraint
                 WHERE conname = 'fk_vapi_call_sessions_resource_tuple'
             ) AS resource_tuple_fk,
             EXISTS (
                 SELECT 1 FROM pg_constraint
                 WHERE conname = 'fk_vapi_resource_connection_same_company'
             ) AS resource_connection_fk,
             EXISTS (
                 SELECT 1 FROM pg_indexes
                 WHERE indexname = 'uq_vapi_call_sessions_provider_call'
             ) AS provider_call_unique,
             (
                 SELECT to_json(array_agg(attribute.attname ORDER BY indexed.ordinality))
                 FROM pg_index definition
                 CROSS JOIN LATERAL unnest(definition.indkey)
                     WITH ORDINALITY AS indexed(attnum, ordinality)
                 JOIN pg_attribute attribute
                   ON attribute.attrelid = definition.indrelid
                  AND attribute.attnum = indexed.attnum
                 WHERE definition.indexrelid =
                     'uq_vapi_call_sessions_provider_call'::regclass
             ) AS provider_call_index_columns,
             EXISTS (
                 SELECT 1
                 FROM pg_constraint
                 WHERE conname = 'vapi_call_sessions_flow_execution_id_fkey'
                   AND confdeltype = 'n'
             ) AS flow_execution_set_null,
             NOT EXISTS (
                 SELECT 1 FROM pg_indexes
                 WHERE indexname = 'uq_provider_connections_provider_org'
             ) AS shared_provider_org_supported,
             EXISTS (
                 SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'vapi_assistant_profiles'
                   AND column_name = 'environment'
             ) AS profile_environment`,
    );
    expect(forward.rows[0]).toEqual({
        sessions: 'vapi_call_sessions',
        observations: 'vapi_call_usage_observations',
        usage: 'vapi_call_usage',
        resource_tuple_fk: true,
        resource_connection_fk: true,
        provider_call_unique: true,
        provider_call_index_columns: ['vapi_call_id'],
        flow_execution_set_null: true,
        shared_provider_org_supported: true,
        profile_environment: true,
    });

    await client.query(ROLLBACK);
    const rolledBack = await client.query(
        `SELECT
             to_regclass('vapi_call_sessions')::text AS sessions,
             EXISTS (
                 SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'vapi_assistant_profiles'
                   AND column_name = 'environment'
             ) AS profile_environment`,
    );
    expect(rolledBack.rows[0]).toEqual({
        sessions: null,
        profile_environment: false,
    });

    await client.query(FORWARD);
    const restored = await client.query(
        `SELECT to_regclass('vapi_call_sessions')::text AS sessions`,
    );
    expect(restored.rows[0].sessions).toBe('vapi_call_sessions');
});
