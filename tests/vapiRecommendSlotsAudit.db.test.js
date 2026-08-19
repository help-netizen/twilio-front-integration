'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { Pool } = require('pg');
const auditService = require('../backend/src/services/vapiRecommendSlotsAuditService');
const recoveryService = require('../backend/src/services/inboundVoiceRecoveryService');

function migration(filename) {
    return fs.readFileSync(
        path.join(__dirname, '..', 'backend', 'db', 'migrations', filename),
        'utf8',
    );
}

const FORWARD_285 = migration('285_vapi_inbound_recovery_cases.sql');
const FORWARD_286 = migration('286_vapi_recommend_slots_call_audits.sql');

let pool;
let client;
let companyA;
let companyB;

function call(providerCallId, phone) {
    return {
        id: providerCallId,
        type: 'inboundPhoneCall',
        customer: { number: phone },
        startedAt: '2026-08-19T14:00:00.000Z',
        endedAt: '2026-08-19T14:02:00.000Z',
        durationSeconds: 120,
    };
}

async function record({
    companyId = companyA,
    providerCallId = `call-${randomUUID()}`,
    toolCallId = `tool-${randomUUID()}`,
    phone = '+15085551000',
    result,
    args = { zip: '01721' },
} = {}) {
    return auditService.recordInvocationWithClient({
        companyId,
        providerCallId,
        toolCallId,
        arguments: args,
        result,
        call: call(providerCallId, phone),
        inbound: true,
        observedAt: new Date('2026-08-19T14:01:00.000Z'),
    }, client);
}

beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(FORWARD_285);
    await client.query(FORWARD_286);
    companyA = randomUUID();
    companyB = randomUUID();
    await client.query(
        `INSERT INTO companies (id, name, slug)
         VALUES ($1, 'Audit Tenant A', $2), ($3, 'Audit Tenant B', $4)`,
        [
            companyA,
            `audit-a-${companyA}`,
            companyB,
            `audit-b-${companyB}`,
        ],
    );
});

afterAll(async () => {
    if (client) {
        await client.query('ROLLBACK');
        client.release();
    }
    if (pool) await pool.end();
});

test('stores exact arguments/result once for an idempotently repeated tool call', async () => {
    const providerCallId = `call-${randomUUID()}`;
    const toolCallId = `tool-${randomUUID()}`;
    const args = { zip: '01721', targetDay: '2026-08-21' };
    const result = {
        available: true,
        slots: [{
            key: '2026-08-21|10:00|12:00',
            date: '2026-08-21',
            start: '10:00',
            end: '12:00',
            label: 'Friday, August 21, 10 AM to 12 PM',
        }],
    };

    await record({ providerCallId, toolCallId, result, args });
    await record({ providerCallId, toolCallId, result, args });

    const audit = await client.query(
        `SELECT company_id, invocations, callback_task_id
         FROM vapi_recommend_slots_call_audits
         WHERE company_id = $1 AND provider_call_id = $2`,
        [companyA, providerCallId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].company_id).toBe(companyA);
    expect(audit.rows[0].callback_task_id).toBeNull();
    expect(audit.rows[0].invocations).toHaveLength(1);
    expect(audit.rows[0].invocations[0]).toEqual({
        tool_call_id: toolCallId,
        arguments: args,
        result,
        observed_at: '2026-08-19T14:01:00.000Z',
    });
});

test.each(['out_of_area', 'no_provider_for_area'])(
    '%s is audited but creates no callback task',
    async (reason) => {
        const providerCallId = `call-${randomUUID()}`;
        await record({
            providerCallId,
            phone: reason === 'out_of_area' ? '+15085551001' : '+15085551002',
            result: { available: false, slots: [], fallback: false, reason },
        });

        const audit = await client.query(
            `SELECT callback_task_id
             FROM vapi_recommend_slots_call_audits
             WHERE company_id = $1 AND provider_call_id = $2`,
            [companyA, providerCallId],
        );
        const recovery = await client.query(
            `SELECT task_id
             FROM vapi_inbound_recovery_cases
             WHERE company_id = $1 AND provider_call_id = $2`,
            [companyA, providerCallId],
        );
        expect(audit.rows[0].callback_task_id).toBeNull();
        expect(recovery.rows).toHaveLength(0);
    },
);

test('fallback/ok-empty availability failure creates one real p1 callback and EoC dedupes it', async () => {
    const providerCallId = `call-${randomUUID()}`;
    const toolCallId = `tool-${randomUUID()}`;
    const phone = '+15085551003';
    const result = { available: false, slots: [], fallback: true };
    await client.query(
        `INSERT INTO timelines (company_id, phone_e164) VALUES ($1, $2)`,
        [companyA, phone],
    );

    const first = await record({ providerCallId, toolCallId, phone, result });
    const repeated = await record({ providerCallId, toolCallId, phone, result });
    expect(first).toMatchObject({ callbackCreated: true });
    expect(repeated).toMatchObject({ callbackCreated: false, taskId: first.taskId });

    const rows = await client.query(
        `SELECT audit.callback_task_id, jsonb_array_length(audit.invocations) AS invocation_count,
                task.company_id, task.status, task.priority, task.created_by,
                task.kind, task.agent_type, task.thread_id,
                recovery.state, recovery.decision_reason, recovery.task_id
         FROM vapi_recommend_slots_call_audits audit
         JOIN tasks task ON task.id = audit.callback_task_id
         JOIN vapi_inbound_recovery_cases recovery
           ON recovery.provider_call_id = audit.provider_call_id
          AND recovery.company_id = audit.company_id
         WHERE audit.company_id = $1 AND audit.provider_call_id = $2`,
        [companyA, providerCallId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
        callback_task_id: first.taskId,
        invocation_count: 1,
        company_id: companyA,
        status: 'open',
        priority: 'p1',
        created_by: 'agent',
        kind: 'agent',
        agent_type: 'voice_slot_unavailable',
        state: 'task_created',
        decision_reason: 'slot_unavailable',
        task_id: first.taskId,
    });
    expect(rows.rows[0].thread_id).not.toBeNull();

    const eoc = await recoveryService.processEndOfCallWithClient({
        companyId: companyA,
        message: { call: call(providerCallId, phone) },
        providerDurationSeconds: 120,
    }, client);
    expect(eoc).toMatchObject({
        status: 'task_created',
        taskId: first.taskId,
        created: false,
        idempotent: true,
    });
    const count = await client.query(
        `SELECT COUNT(*)::integer AS count
         FROM tasks
         WHERE company_id = $1
           AND agent_type IN ('voice_slot_unavailable', 'voice_inbound_recovery')`,
        [companyA],
    );
    expect(count.rows[0].count).toBe(1);
});

test('slot callback task failure is non-fatal, durable for retry, and later repairs the audit link', async () => {
    const providerCallId = `call-${randomUUID()}`;
    const toolCallId = `tool-${randomUUID()}`;
    const phone = '+15085551005';
    const result = { available: false, slots: [], fallback: true };
    await client.query(
        `INSERT INTO timelines (company_id, phone_e164) VALUES ($1, $2)`,
        [companyA, phone],
    );
    await client.query(`
        CREATE OR REPLACE FUNCTION pg_temp.reject_voice_slot_callback_task()
        RETURNS trigger AS $$
        BEGIN
            IF NEW.agent_type = 'voice_slot_unavailable' THEN
                RAISE EXCEPTION 'forced slot callback failure' USING ERRCODE = 'P0001';
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
    `);
    await client.query(`
        CREATE TRIGGER trg_test_reject_voice_slot_callback_task
        BEFORE INSERT ON tasks
        FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_voice_slot_callback_task()
    `);
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    const failed = await record({ providerCallId, toolCallId, phone, result });
    expect(failed).toMatchObject({
        recorded: true,
        callbackCreated: false,
        callbackStatus: 'retry_pending',
        taskId: null,
    });
    const pending = await client.query(
        `SELECT audit.callback_task_id, recovery.state, recovery.decision_reason,
                recovery.last_error_code, recovery.next_retry_at IS NOT NULL AS has_retry
         FROM vapi_recommend_slots_call_audits audit
         JOIN vapi_inbound_recovery_cases recovery
           ON recovery.provider_call_id = audit.provider_call_id
          AND recovery.company_id = audit.company_id
         WHERE audit.company_id = $1 AND audit.provider_call_id = $2`,
        [companyA, providerCallId],
    );
    expect(pending.rows[0]).toEqual({
        callback_task_id: null,
        state: 'retry_pending',
        decision_reason: 'slot_unavailable',
        last_error_code: 'P0001',
        has_retry: true,
    });

    await client.query('DROP TRIGGER trg_test_reject_voice_slot_callback_task ON tasks');
    const repaired = await recoveryService.createSlotUnavailableCallbackWithClient({
        companyId: companyA,
        providerCallId,
        message: { call: call(providerCallId, phone) },
        inboundTrusted: true,
    }, client);
    expect(repaired).toMatchObject({ status: 'task_created', created: true });
    const repairedAudit = await client.query(
        `SELECT callback_task_id
         FROM vapi_recommend_slots_call_audits
         WHERE company_id = $1 AND provider_call_id = $2`,
        [companyA, providerCallId],
    );
    expect(repairedAudit.rows[0].callback_task_id).toBe(repaired.taskId);
    error.mockRestore();
});

test('provider call collision cannot cross tenants or alter the owning audit', async () => {
    const providerCallId = `call-${randomUUID()}`;
    const ownerResult = { available: true, slots: [] };
    await record({ providerCallId, result: ownerResult });

    await expect(record({
        companyId: companyB,
        providerCallId,
        toolCallId: 'foreign-tool',
        result: { available: false, slots: [], fallback: true },
        phone: '+15085551999',
    })).rejects.toMatchObject({
        code: 'VAPI_RECOMMEND_AUDIT_PROVIDER_CALL_COLLISION',
    });

    const owner = await client.query(
        `SELECT company_id, invocations, callback_task_id
         FROM vapi_recommend_slots_call_audits
         WHERE company_id = $1 AND provider_call_id = $2`,
        [companyA, providerCallId],
    );
    expect(owner.rows).toHaveLength(1);
    expect(owner.rows[0].company_id).toBe(companyA);
    expect(owner.rows[0].invocations).toHaveLength(1);
    expect(owner.rows[0].invocations[0].result).toEqual(ownerResult);
    expect(owner.rows[0].callback_task_id).toBeNull();
});

test('end-of-call transcript update is tenant-scoped', async () => {
    const providerCallId = `call-${randomUUID()}`;
    await record({ providerCallId, result: { available: true, slots: [] } });
    await auditService.recordEndOfCallWithClient({
        companyId: companyA,
        message: {
            call: call(providerCallId, '+15085551004'),
            artifact: { transcript: 'Sara: Friday at ten. Caller: Yes.' },
        },
    }, client);
    await auditService.recordEndOfCallWithClient({
        companyId: companyB,
        message: {
            call: call(providerCallId, '+15085551999'),
            transcript: 'foreign overwrite',
        },
    }, client);

    const row = await client.query(
        `SELECT transcript
         FROM vapi_recommend_slots_call_audits
         WHERE company_id = $1 AND provider_call_id = $2`,
        [companyA, providerCallId],
    );
    expect(row.rows[0].transcript).toBe('Sara: Friday at ten. Caller: Yes.');
});
