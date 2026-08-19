'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { Pool } = require('pg');
const recovery = require('../backend/src/services/inboundVoiceRecoveryService');

const FORWARD_285 = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '285_vapi_inbound_recovery_cases.sql'),
    'utf8',
);
const FORWARD_286 = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '286_vapi_recommend_slots_call_audits.sql'),
    'utf8',
);

let pool;
let client;
let companyId;

function inboundMessage(callId, phone, seconds) {
    const startedAt = new Date('2026-08-18T14:00:00.000Z');
    const endedAt = new Date(startedAt.getTime() + seconds * 1000);
    return {
        call: {
            id: callId,
            type: 'inboundPhoneCall',
            customer: { number: phone },
            startedAt: startedAt.toISOString(),
            endedAt: endedAt.toISOString(),
        },
    };
}

beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(FORWARD_285);
    await client.query(FORWARD_286);
    companyId = randomUUID();
    await client.query(
        `INSERT INTO companies (id, name, slug)
         VALUES ($1, 'Voice Recovery Test', $2)`,
        [companyId, `voice-recovery-${companyId}`],
    );
});

afterAll(async () => {
    if (client) {
        await client.query('ROLLBACK');
        client.release();
    }
    if (pool) await pool.end();
});

test('substantive inbound conversation creates exactly one dispatcher task across repeated EoC', async () => {
    const providerCallId = `call-${randomUUID()}`;
    const phone = '+15085550101';
    const input = { companyId, message: inboundMessage(providerCallId, phone, 184) };
    const callSid = `CA${randomUUID().replace(/-/g, '')}`;
    const before = await client.query(
        `SELECT COUNT(*)::integer AS count
         FROM tasks
         WHERE company_id = $1 AND agent_type = 'voice_inbound_recovery'`,
        [companyId],
    );
    const timeline = await client.query(
        `INSERT INTO timelines (company_id, phone_e164) VALUES ($1, $2) RETURNING id`,
        [companyId, phone],
    );
    await client.query(
        `INSERT INTO calls (
             company_id, timeline_id, call_sid, direction, from_number,
             status, is_final, started_at, ended_at, duration_sec,
             last_event_time, answered_by
         ) VALUES (
             $1, $2, $3, 'inbound', $4,
             'completed', true, $5, $6, 0,
             $6, 'ai'
         )`,
        [
            companyId,
            timeline.rows[0].id,
            callSid,
            phone,
            '2026-08-18T14:00:00.000Z',
            '2026-08-18T14:03:04.000Z',
        ],
    );

    const first = await recovery.processEndOfCallWithClient(input, client);
    const repeated = await recovery.processEndOfCallWithClient(input, client);

    expect(first).toMatchObject({ status: 'task_created', created: true });
    expect(repeated).toMatchObject({
        status: 'task_created',
        created: false,
        idempotent: true,
        taskId: first.taskId,
    });
    const tasks = await client.query(
        `SELECT task.id, task.thread_id, task.title, task.description,
                recovery_case.state, recovery_case.task_id, recovery_case.call_sid,
                recovery_case.observed_duration_seconds
         FROM tasks task
         JOIN vapi_inbound_recovery_cases recovery_case
           ON recovery_case.task_id = task.id
         WHERE task.company_id = $1
           AND recovery_case.provider_call_id = $2`,
        [companyId, providerCallId],
    );
    expect(tasks.rows).toHaveLength(1);
    expect(tasks.rows[0]).toMatchObject({
        state: 'task_created',
        task_id: first.taskId,
        call_sid: callSid,
        observed_duration_seconds: 184,
    });
    expect(tasks.rows[0].thread_id).not.toBeNull();
    expect(tasks.rows[0].title).toContain(phone);
    expect(tasks.rows[0].description).toContain('recording and transcript');
    expect(tasks.rows[0].description).not.toContain(providerCallId);
    const after = await client.query(
        `SELECT COUNT(*)::integer AS count
         FROM tasks
         WHERE company_id = $1 AND agent_type = 'voice_inbound_recovery'`,
        [companyId],
    );
    expect(after.rows[0].count - before.rows[0].count).toBe(1);
});

test('short accidental inbound call is durably skipped and creates no task', async () => {
    const providerCallId = `call-${randomUUID()}`;
    const result = await recovery.processEndOfCallWithClient({
        companyId,
        message: inboundMessage(providerCallId, '+15085550102', 3),
    }, client);

    expect(result).toEqual({ status: 'skipped', reason: 'short_call', created: false });
    const rows = await client.query(
        `SELECT recovery_case.state, recovery_case.decision_reason, task.id AS task_id
         FROM vapi_inbound_recovery_cases recovery_case
         LEFT JOIN tasks task ON task.id = recovery_case.task_id
         WHERE recovery_case.provider_call_id = $1`,
        [providerCallId],
    );
    expect(rows.rows[0]).toEqual({
        state: 'skipped',
        decision_reason: 'short_call',
        task_id: null,
    });
});

test('an existing open lead for the caller suppresses the recovery task', async () => {
    const providerCallId = `call-${randomUUID()}`;
    const phone = '+15085550103';
    const contact = await client.query(
        `INSERT INTO contacts (company_id, full_name, phone_e164)
         VALUES ($1, 'Existing Caller', $2)
         RETURNING id`,
        [companyId, phone],
    );
    await client.query(
        `INSERT INTO timelines (company_id, contact_id) VALUES ($1, $2)`,
        [companyId, contact.rows[0].id],
    );
    await client.query(
        `INSERT INTO leads (company_id, uuid, status, phone, contact_id)
         VALUES ($1, $2, 'Review', $3, $4)`,
        [companyId, randomUUID().replace(/-/g, '').slice(0, 20), phone, contact.rows[0].id],
    );

    const before = await client.query(
        `SELECT COUNT(*)::integer AS count
         FROM tasks
         WHERE company_id = $1 AND agent_type = 'voice_inbound_recovery'`,
        [companyId],
    );
    const result = await recovery.processEndOfCallWithClient({
        companyId,
        message: inboundMessage(providerCallId, phone, 90),
    }, client);

    expect(result).toEqual({
        status: 'skipped',
        reason: 'existing_open_lead',
        created: false,
    });
    const taskCount = await client.query(
        `SELECT COUNT(*)::integer AS count
         FROM tasks
         WHERE company_id = $1
           AND agent_type = 'voice_inbound_recovery'`,
        [companyId],
    );
    expect(taskCount.rows[0].count).toBe(before.rows[0].count);
});

test('task-write failure is retained for retry and the next attempt repairs it', async () => {
    const providerCallId = `call-${randomUUID()}`;
    const phone = '+15085550104';
    await client.query(
        `INSERT INTO timelines (company_id, phone_e164) VALUES ($1, $2)`,
        [companyId, phone],
    );
    await client.query(`
        CREATE OR REPLACE FUNCTION pg_temp.reject_voice_recovery_task()
        RETURNS trigger AS $$
        BEGIN
            IF NEW.agent_type = 'voice_inbound_recovery' THEN
                RAISE EXCEPTION 'forced recovery task failure' USING ERRCODE = 'P0001';
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
    `);
    await client.query(`
        CREATE TRIGGER trg_test_reject_voice_recovery_task
        BEFORE INSERT ON tasks
        FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_voice_recovery_task()
    `);
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const input = { companyId, message: inboundMessage(providerCallId, phone, 75) };

    const failed = await recovery.processEndOfCallWithClient(input, client);
    expect(failed).toEqual({
        status: 'retry_pending',
        reason: 'P0001',
        created: false,
    });
    const pending = await client.query(
        `SELECT state, task_id, last_error_code, next_retry_at IS NOT NULL AS has_retry
         FROM vapi_inbound_recovery_cases
         WHERE provider_call_id = $1`,
        [providerCallId],
    );
    expect(pending.rows[0]).toEqual({
        state: 'retry_pending',
        task_id: null,
        last_error_code: 'P0001',
        has_retry: true,
    });

    await client.query('DROP TRIGGER trg_test_reject_voice_recovery_task ON tasks');
    const repaired = await recovery.processEndOfCallWithClient(input, client);
    expect(repaired).toMatchObject({ status: 'task_created', created: true });
    error.mockRestore();
});
