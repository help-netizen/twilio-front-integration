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

const FORWARD_285 = migration('285_vapi_inbound_recovery_cases.sql');
const FORWARD_286 = migration('286_vapi_recommend_slots_call_audits.sql');
const ROLLBACK_286 = migration('rollback_286_vapi_recommend_slots_call_audits.sql');

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

test('migration 286 is repeatable, indexed, and rollback-safe', async () => {
    await client.query(FORWARD_285);
    await client.query(FORWARD_286);
    await client.query(FORWARD_286);

    const shape = await client.query(
        `SELECT
             to_regclass('vapi_recommend_slots_call_audits')::text AS table_name,
             to_regclass('idx_vapi_recommend_slots_audits_company_call_sid')::text AS call_sid_index,
             EXISTS (
                 SELECT 1
                 FROM information_schema.columns
                 WHERE table_name = 'vapi_recommend_slots_call_audits'
                   AND column_name = 'callback_task_id'
             ) AS callback_link,
             pg_get_constraintdef(oid) LIKE '%slot_unavailable%' AS recovery_accepts_slot_reason
         FROM pg_constraint
         WHERE conrelid = 'vapi_inbound_recovery_cases'::regclass
           AND conname = 'chk_vapi_inbound_recovery_terminal_shape'`,
    );
    expect(shape.rows).toEqual([{
        table_name: 'vapi_recommend_slots_call_audits',
        call_sid_index: 'idx_vapi_recommend_slots_audits_company_call_sid',
        callback_link: true,
        recovery_accepts_slot_reason: true,
    }]);

    await client.query(ROLLBACK_286);
    const rolledBack = await client.query(
        `SELECT
             to_regclass('vapi_recommend_slots_call_audits')::text AS table_name,
             pg_get_constraintdef(oid) NOT LIKE '%slot_unavailable%' AS old_recovery_contract
         FROM pg_constraint
         WHERE conrelid = 'vapi_inbound_recovery_cases'::regclass
           AND conname = 'chk_vapi_inbound_recovery_terminal_shape'`,
    );
    expect(rolledBack.rows).toEqual([{
        table_name: null,
        old_recovery_contract: true,
    }]);

    await client.query(FORWARD_286);
    const restored = await client.query(
        `SELECT to_regclass('vapi_recommend_slots_call_audits')::text AS table_name`,
    );
    expect(restored.rows[0].table_name).toBe('vapi_recommend_slots_call_audits');
});
