'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const identity = require('../backend/src/services/vapiCallIdentityService');
const audit = require('../backend/src/services/vapiUsageAuditService');
const outboundBootstrap = require('../backend/scripts/bootstrap-vapi-outbound-resource');

const COMPANY_A = '20000000-0000-4000-8000-00000000000a';
const COMPANY_B = '20000000-0000-4000-8000-00000000000b';
const MIGRATIONS = [275, 277].map((number) => fs.readFileSync(
    path.join(
        __dirname,
        '..',
        'backend',
        'db',
        'migrations',
        number === 275
            ? '275_vapi_assistant_registry.sql'
            : '277_vapi_outbound_registry_sessions.sql',
    ),
    'utf8',
));

let pool;
let client;
let attemptA;
let attemptB;

async function seedCompany(companyId, suffix) {
    await client.query(
        `INSERT INTO companies (id, name, slug, status)
         VALUES ($1, $2, $3, 'active')
         ON CONFLICT (id) DO UPDATE SET status = 'active'`,
        [companyId, `Outbound identity ${suffix}`, `outbound-identity-${suffix}`],
    );
}

async function seedCredential(companyId, suffix, surface, scope) {
    const result = await client.query(
        `INSERT INTO api_integrations (
             client_name, key_id, secret_hash, scopes, company_id, machine_surface
         ) VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         RETURNING id`,
        [
            `Outbound ${surface} ${suffix}`,
            `outbound_${surface}_${suffix}`,
            `hash_${surface}_${suffix}`,
            JSON.stringify([scope]),
            companyId,
            surface,
        ],
    );
    return result.rows[0].id;
}

async function seedTuple(companyId, suffix) {
    const connectionId = `outbound-connection-${suffix}`;
    const profileId = `outbound-profile-${suffix}`;
    const resourceId = `outbound-resource-${suffix}`;
    const toolsId = await seedCredential(companyId, `${suffix}-tools`, 'vapi_tools', 'vapi_tools:invoke');
    const statusId = await seedCredential(
        companyId,
        `${suffix}-status`,
        'vapi_call_status',
        'vapi_call_status:invoke',
    );
    await client.query(
        `INSERT INTO provider_connections (
             id, tenant_id, provider, environment, status, company_id
         ) VALUES ($1, $2, 'vapi', 'prod', 'active', $3)`,
        [connectionId, `outbound-tenant-${suffix}`, companyId],
    );
    await client.query(
        `INSERT INTO vapi_assistant_profiles (
             id, tenant_id, provider_connection_id, slug, purpose,
             vapi_assistant_id, is_active, company_id, environment,
             provider_account_key, status, tools_credential_id,
             call_status_credential_id
         ) VALUES (
             $1, $2, $3, $4, 'outbound_parts_call', $5, true, $6,
             'prod', 'vapi:platform', 'active', $7, $8
         )`,
        [
            profileId,
            `outbound-tenant-${suffix}`,
            connectionId,
            `outbound-parts-${suffix}`,
            `outbound-assistant-${suffix}`,
            companyId,
            toolsId,
            statusId,
        ],
    );
    await client.query(
        `INSERT INTO vapi_tenant_resources (
             id, tenant_id, provider_connection_id, environment,
             vapi_phone_number_id, is_active, company_id, purpose,
             status, resource_type
         ) VALUES (
             $1, $2, $3, 'prod', $4, true, $5, 'outbound_call',
             'active', 'vapi_phone_number'
         )`,
        [
            resourceId,
            `outbound-tenant-${suffix}`,
            connectionId,
            `outbound-phone-${suffix}`,
            companyId,
        ],
    );
}

async function seedAttempt(companyId) {
    const job = await client.query(
        `INSERT INTO jobs (company_id, blanc_status)
         VALUES ($1, 'Part arrived')
         RETURNING id`,
        [companyId],
    );
    const attempt = await client.query(
        `INSERT INTO outbound_call_attempts (
             company_id, job_id, attempt_no, status, scheduled_at, scenario
         ) VALUES ($1, $2, 1, 'dialing', now(), 'parts_visit')
         RETURNING id`,
        [companyId, job.rows[0].id],
    );
    return String(attempt.rows[0].id);
}

function reserve(companyId, attemptId) {
    return identity.reserveOutboundSessionWithClient({
        companyId,
        outboundCallAttemptId: attemptId,
        environment: 'prod',
    }, client);
}

beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
    await client.query('BEGIN');
    for (const migration of MIGRATIONS) await client.query(migration);
    await client.query(MIGRATIONS[1]);
    await seedCompany(COMPANY_A, 'a');
    await seedCompany(COMPANY_B, 'b');
    await seedTuple(COMPANY_A, 'a');
    await seedTuple(COMPANY_B, 'b');
});

beforeEach(async () => {
    await client.query('DELETE FROM vapi_call_sessions WHERE company_id IN ($1, $2)', [COMPANY_A, COMPANY_B]);
    await client.query('DELETE FROM outbound_call_attempts WHERE company_id IN ($1, $2)', [COMPANY_A, COMPANY_B]);
    await client.query('DELETE FROM jobs WHERE company_id IN ($1, $2)', [COMPANY_A, COMPANY_B]);
    attemptA = await seedAttempt(COMPANY_A);
    attemptB = await seedAttempt(COMPANY_B);
});

afterAll(async () => {
    if (client) {
        await client.query('ROLLBACK');
        client.release();
    }
    if (pool) await pool.end();
});

test('reservation precedes provider placement and pins one company-owned assistant/caller tuple', async () => {
    const reserved = await reserve(COMPANY_A, attemptA);
    expect(reserved).toMatchObject({
        companyId: COMPANY_A,
        purpose: 'outbound_parts_call',
        assistantId: 'outbound-assistant-a',
        resourceType: 'vapi_phone_number',
        phoneNumberId: 'outbound-phone-a',
    });
    const session = await client.query(
        `SELECT company_id, state, vapi_call_id, outbound_call_attempt_id,
                expected_vapi_assistant_id
         FROM vapi_call_sessions
         WHERE id = $1`,
        [reserved.sessionId],
    );
    expect(session.rows[0]).toMatchObject({
        company_id: COMPANY_A,
        state: 'provider_pending',
        vapi_call_id: null,
        expected_vapi_assistant_id: 'outbound-assistant-a',
    });
    expect(String(session.rows[0].outbound_call_attempt_id)).toBe(attemptA);
});

test('one transition atomically binds provider id to session and attempt and stores limits as telemetry', async () => {
    const reserved = await reserve(COMPANY_A, attemptA);
    await identity.bindOutboundPlacementWithClient({
        companyId: COMPANY_A,
        sessionId: reserved.sessionId,
        outboundCallAttemptId: attemptA,
        providerCallId: 'outbound-call-a',
        subscriptionLimits: {
            concurrencyLimit: 10,
            concurrencyLimitUsed: 4,
            unsafeText: 'customer-data-is-dropped',
        },
        slotJson: { key: 'slot-a' },
    }, client);

    const result = await client.query(
        `SELECT session.vapi_call_id AS session_call_id,
                session.state,
                session.provider_subscription_limits,
                attempt.vapi_call_id AS attempt_call_id,
                attempt.slot_json
         FROM vapi_call_sessions session
         JOIN outbound_call_attempts attempt
           ON attempt.id = session.outbound_call_attempt_id
          AND attempt.company_id = session.company_id
         WHERE session.id = $1`,
        [reserved.sessionId],
    );
    expect(result.rows[0]).toMatchObject({
        session_call_id: 'outbound-call-a',
        attempt_call_id: 'outbound-call-a',
        state: 'active',
        provider_subscription_limits: {
            concurrencyLimit: 10,
            concurrencyLimitUsed: 4,
        },
        slot_json: { key: 'slot-a' },
    });
});

test('T-foreign company cannot reserve another company attempt', async () => {
    await expect(reserve(COMPANY_B, attemptA)).rejects.toMatchObject({
        code: 'VAPI_IDENTITY_OUTBOUND_ATTEMPT_SCOPE_MISMATCH',
    });
    const rows = await client.query(
        `SELECT id FROM vapi_call_sessions WHERE outbound_call_attempt_id = $1`,
        [attemptA],
    );
    expect(rows.rows).toHaveLength(0);
});

test('global provider call collision rejects the second company without changing either identity', async () => {
    const first = await reserve(COMPANY_A, attemptA);
    await identity.bindOutboundPlacementWithClient({
        companyId: COMPANY_A,
        sessionId: first.sessionId,
        outboundCallAttemptId: attemptA,
        providerCallId: 'shared-provider-call',
    }, client);
    const second = await reserve(COMPANY_B, attemptB);
    await expect(identity.bindOutboundPlacementWithClient({
        companyId: COMPANY_B,
        sessionId: second.sessionId,
        outboundCallAttemptId: attemptB,
        providerCallId: 'shared-provider-call',
    }, client)).rejects.toMatchObject({ code: 'VAPI_IDENTITY_PROVIDER_CALL_COLLISION' });

    const snapshots = await client.query(
        `SELECT company_id, state, vapi_call_id
         FROM vapi_call_sessions
         WHERE id = ANY($1::uuid[])
         ORDER BY company_id`,
        [[first.sessionId, second.sessionId]],
    );
    expect(snapshots.rows).toEqual([
        expect.objectContaining({ company_id: COMPANY_A, state: 'active', vapi_call_id: 'shared-provider-call' }),
        expect.objectContaining({ company_id: COMPANY_B, state: 'provider_pending', vapi_call_id: null }),
    ]);
});

test('duplicate reservation never creates a second session or another provider opportunity', async () => {
    const first = await reserve(COMPANY_A, attemptA);
    const duplicate = await reserve(COMPANY_A, attemptA);
    expect(duplicate).toMatchObject({
        sessionId: first.sessionId,
        providerPending: true,
    });
    const count = await client.query(
        `SELECT COUNT(*)::integer AS count
         FROM vapi_call_sessions
         WHERE company_id = $1 AND outbound_call_attempt_id = $2`,
        [COMPANY_A, attemptA],
    );
    expect(count.rows[0].count).toBe(1);
});

test('ambiguous POST is repaired from server-owned call metadata before any retry', async () => {
    const reserved = await reserve(COMPANY_A, attemptA);
    const repaired = await audit.repairPendingOutboundIdentities(client, new Map([
        ['provider-repaired', {
            id: 'provider-repaired',
            albustoCallSessionId: reserved.sessionId,
            assistantId: 'outbound-assistant-a',
        }],
    ]));
    expect(repaired).toBe(1);
    const result = await client.query(
        `SELECT session.state, session.vapi_call_id AS session_call_id,
                attempt.vapi_call_id AS attempt_call_id
         FROM vapi_call_sessions session
         JOIN outbound_call_attempts attempt
           ON attempt.id = session.outbound_call_attempt_id
          AND attempt.company_id = session.company_id
         WHERE session.id = $1`,
        [reserved.sessionId],
    );
    expect(result.rows[0]).toEqual({
        state: 'active',
        session_call_id: 'provider-repaired',
        attempt_call_id: 'provider-repaired',
    });
});

test('repair rejects metadata when provider assistant is not the pinned company assistant', async () => {
    const reserved = await reserve(COMPANY_A, attemptA);
    const repaired = await audit.repairPendingOutboundIdentities(client, new Map([
        ['provider-foreign-assistant', {
            id: 'provider-foreign-assistant',
            albustoCallSessionId: reserved.sessionId,
            assistantId: 'outbound-assistant-b',
        }],
    ]));
    expect(repaired).toBe(0);
    const result = await client.query(
        `SELECT state, vapi_call_id
         FROM vapi_call_sessions
         WHERE id = $1`,
        [reserved.sessionId],
    );
    expect(result.rows[0]).toEqual({ state: 'provider_pending', vapi_call_id: null });
});

test('outbound caller operational apply is idempotent and retains the actual existing resource id', async () => {
    const plan = {
        companyId: COMPANY_A,
        connection: {
            id: 'outbound-connection-a',
            tenant_id: 'outbound-tenant-a',
        },
        caller: {
            resourceType: 'vapi_phone_number',
            vapiPhoneNumberId: 'outbound-phone-a',
            twilioPhoneNumber: null,
        },
    };
    const first = await outboundBootstrap.applyPlan(client, plan);
    const second = await outboundBootstrap.applyPlan(client, plan);
    expect(first.resource_id).toBe('outbound-resource-a');
    expect(second).toEqual(first);
    const count = await client.query(
        `SELECT COUNT(*)::integer AS count
         FROM vapi_tenant_resources
         WHERE company_id = $1
           AND purpose = 'outbound_call'
           AND environment = 'prod'`,
        [COMPANY_A],
    );
    expect(count.rows[0].count).toBe(1);
});
