'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const identity = require('../backend/src/services/vapiCallIdentityService');

const COMPANY_A = '10000000-0000-4000-8000-00000000000a';
const COMPANY_B = '10000000-0000-4000-8000-00000000000b';
const MIGRATION = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '266_vapi_call_identity_and_usage.sql'),
    'utf8',
);
const RECOVERY_MIGRATION = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '280_vapi_agency_provisioning_recovery.sql'),
    'utf8',
);

let pool;
let client;
let credentialA;
let credentialAOther;
let credentialB;
let toolsCredentialA;
let statusCredentialA;
let toolsCredentialB;
let statusCredentialB;

async function seedCompany(companyId, suffix) {
    await client.query(
        `INSERT INTO companies (id, name, slug, status)
         VALUES ($1, $2, $3, 'active')
         ON CONFLICT (id) DO UPDATE SET status = 'active'`,
        [companyId, `Vapi identity ${suffix}`, `vapi-identity-${suffix}`],
    );
}

async function seedCredential(
    companyId,
    suffix,
    surface = 'vapi_assistant_request',
    scope = 'vapi_assistant_request:invoke',
) {
    const result = await client.query(
        `INSERT INTO api_integrations (
             client_name, key_id, secret_hash, scopes, company_id, machine_surface
         ) VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         RETURNING id`,
        [
            `Vapi ${surface} ${suffix}`,
            `vapi_identity_${surface}_${suffix}`,
            `secret_hash_${surface}_${suffix}`,
            JSON.stringify([scope]),
            companyId,
            surface,
        ],
    );
    return String(result.rows[0].id);
}

async function seedRuntimeTuple(
    companyId,
    suffix,
    credentialId,
    toolsCredentialId,
    statusCredentialId,
) {
    const connectionId = `vapi-identity-connection-${suffix}`;
    const profileId = `vapi-identity-profile-${suffix}`;
    const resourceId = `vapi-identity-resource-${suffix}`;
    await client.query(
         `INSERT INTO provider_connections (
             id, tenant_id, provider, environment, status, company_id,
             provider_org_id
         ) VALUES ($1, $2, 'vapi', 'prod', 'active', $3, $4)`,
        [
            connectionId,
            `tenant-${suffix}`,
            companyId,
            suffix === 'a' ? '' : 'org-fixture-platform',
        ],
    );
    await client.query(
        `INSERT INTO vapi_assistant_profiles (
             id, tenant_id, provider_connection_id, slug, purpose,
             vapi_assistant_id, is_active, company_id, environment,
             provider_account_key, status, tools_credential_id,
             call_status_credential_id
         ) VALUES (
             $1, $2, $3, $4, 'inbound_call', $5, true, $6, 'prod',
             'vapi:platform', 'active', $7, $8
         )`,
        [
            profileId,
            `tenant-${suffix}`,
            connectionId,
            `inbound-${suffix}`,
            `assistant-registry-${suffix}`,
            companyId,
            toolsCredentialId,
            statusCredentialId,
        ],
    );
    await client.query(
        `INSERT INTO vapi_tenant_resources (
             id, tenant_id, provider_connection_id, environment, sip_uri,
             is_active, company_id, purpose, assistant_profile_id,
             server_credential_id, status
         ) VALUES ($1, $2, $3, 'prod', $4, true, $5, 'inbound_call', $6, $7, 'active')`,
        [
            resourceId,
            `tenant-${suffix}`,
            connectionId,
            `sip:identity-${suffix}@sip.vapi.ai`,
            companyId,
            profileId,
            credentialId,
        ],
    );
}

async function seedExecution(companyId, suffix, callSid = 'CA_parent_shared') {
    await client.query(
        `INSERT INTO call_flow_executions (
             id, company_id, call_sid, current_node_id, context_json, status
         ) VALUES ($1, $2, $3, 'vapi', '{}', 'active')`,
        [`flow-execution-${suffix}`, companyId, callSid],
    );
}

function reserve(companyId, suffix, flowNodeId = 'vapi-node-1') {
    return identity.reserveInboundSessionWithClient({
        companyId,
        twilioParentCallSid: 'CA_parent_shared',
        flowExecutionId: `flow-execution-${suffix}`,
        flowNodeId,
        purpose: 'inbound_call',
        environment: 'prod',
    }, client);
}

function bind(companyId, credentialId, correlationToken, providerCallId) {
    return identity.bindInboundCallWithClient({
        companyId,
        credentialId,
        correlationToken,
        providerCallId,
        source: 'assistant_request',
    }, client);
}

async function sessionSnapshot(companyId) {
    const result = await client.query(
        `SELECT company_id, vapi_call_id, state, quarantine_reason,
                twilio_parent_call_sid, flow_node_id
         FROM vapi_call_sessions
         WHERE company_id = $1
         ORDER BY created_at, id`,
        [companyId],
    );
    return result.rows;
}

async function fullSessionSnapshot(companyId) {
    const result = await client.query(
        `SELECT to_jsonb(session) AS snapshot
         FROM vapi_call_sessions session
         WHERE company_id = $1
         ORDER BY created_at, id`,
        [companyId],
    );
    return result.rows.map((row) => row.snapshot);
}

async function expectConstraintViolation(sql, params, constraint) {
    await client.query('SAVEPOINT expected_constraint_violation');
    try {
        await expect(client.query(sql, params)).rejects.toMatchObject({
            code: '23503',
            constraint,
        });
    } finally {
        await client.query('ROLLBACK TO SAVEPOINT expected_constraint_violation');
        await client.query('RELEASE SAVEPOINT expected_constraint_violation');
    }
}

async function expectUniqueViolation(sql, params, constraint) {
    await client.query('SAVEPOINT expected_unique_violation');
    try {
        await expect(client.query(sql, params)).rejects.toMatchObject({
            code: '23505',
            constraint,
        });
    } finally {
        await client.query('ROLLBACK TO SAVEPOINT expected_unique_violation');
        await client.query('RELEASE SAVEPOINT expected_unique_violation');
    }
}

beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(MIGRATION);
    await client.query(RECOVERY_MIGRATION);
    // T5 columns are exercised here without running the ABC-specific bootstrap;
    // the migration itself has a dedicated integration suite.
    await client.query(`
        ALTER TABLE vapi_assistant_profiles
            ADD COLUMN IF NOT EXISTS provider_account_key TEXT NOT NULL DEFAULT 'vapi:platform',
            ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
            ADD COLUMN IF NOT EXISTS tools_credential_id BIGINT,
            ADD COLUMN IF NOT EXISTS call_status_credential_id BIGINT;
        ALTER TABLE vapi_tenant_resources
            ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
        ALTER TABLE vapi_usage_alerts
            ADD COLUMN IF NOT EXISTS provider_call_id TEXT;
    `);
    await seedCompany(COMPANY_A, 'a');
    await seedCompany(COMPANY_B, 'b');
    credentialA = await seedCredential(COMPANY_A, 'a');
    credentialAOther = await seedCredential(COMPANY_A, 'a_other');
    credentialB = await seedCredential(COMPANY_B, 'b');
    toolsCredentialA = await seedCredential(
        COMPANY_A, 'a_tools', 'vapi_tools', 'vapi_tools:invoke',
    );
    statusCredentialA = await seedCredential(
        COMPANY_A, 'a_status', 'vapi_call_status', 'vapi_call_status:invoke',
    );
    toolsCredentialB = await seedCredential(
        COMPANY_B, 'b_tools', 'vapi_tools', 'vapi_tools:invoke',
    );
    statusCredentialB = await seedCredential(
        COMPANY_B, 'b_status', 'vapi_call_status', 'vapi_call_status:invoke',
    );
    await seedRuntimeTuple(
        COMPANY_A, 'a', credentialA, toolsCredentialA, statusCredentialA,
    );
    await seedRuntimeTuple(
        COMPANY_B, 'b', credentialB, toolsCredentialB, statusCredentialB,
    );
    await seedExecution(COMPANY_A, 'a');
    await seedExecution(COMPANY_B, 'b');
});

beforeEach(async () => {
    await client.query(
        `DELETE FROM vapi_usage_alerts
         WHERE company_id = ANY($1::uuid[])`,
        [[COMPANY_A, COMPANY_B]],
    );
    await client.query('DELETE FROM vapi_call_sessions');
    await client.query(
        `DELETE FROM vapi_company_credential_acceptance
         WHERE company_id = ANY($1::uuid[])`,
        [[COMPANY_A, COMPANY_B]],
    );
    await client.query(
        `UPDATE api_integrations
         SET revoked_at = NULL,
             expires_at = NULL,
             scopes = '["vapi_assistant_request:invoke"]'::jsonb
         WHERE id = ANY($1::bigint[])`,
        [[credentialA, credentialAOther, credentialB]],
    );
    await client.query(
        `UPDATE api_integrations
         SET revoked_at = NULL,
             expires_at = NULL
         WHERE id = ANY($1::bigint[])`,
        [[toolsCredentialA, statusCredentialA, toolsCredentialB, statusCredentialB]],
    );
    await client.query(
        `UPDATE vapi_assistant_profiles
         SET is_active = true,
             vapi_assistant_id = CASE id
                 WHEN 'vapi-identity-profile-a' THEN 'assistant-registry-a'
                 WHEN 'vapi-identity-profile-b' THEN 'assistant-registry-b'
                 ELSE vapi_assistant_id
             END
         WHERE id IN ('vapi-identity-profile-a', 'vapi-identity-profile-b')`,
    );
});

afterAll(async () => {
    if (client) {
        await client.query('ROLLBACK');
        client.release();
    }
    if (pool) await pool.end();
});

describe('VAPI-AGENCY-001 T2 durable inbound identity', () => {
    test('DB rejects cross-company provider/profile/credential links in the execution tuple', async () => {
        await expectConstraintViolation(
            `UPDATE vapi_tenant_resources
             SET provider_connection_id = 'vapi-identity-connection-b'
             WHERE id = 'vapi-identity-resource-a'`,
            [],
            'fk_vapi_resource_connection_same_company',
        );
        await expectConstraintViolation(
            `UPDATE vapi_tenant_resources
             SET assistant_profile_id = 'vapi-identity-profile-b'
             WHERE id = 'vapi-identity-resource-a'`,
            [],
            'fk_vapi_resource_assistant_same_company',
        );
        await expectConstraintViolation(
            `UPDATE vapi_tenant_resources
             SET server_credential_id = $1
             WHERE id = 'vapi-identity-resource-a'`,
            [credentialB],
            'fk_vapi_resource_credential_same_company',
        );
    });

    test('T-own creates the session before provider id and binds the exact stored tuple', async () => {
        const reservation = await reserve(COMPANY_A, 'a');
        const before = await sessionSnapshot(COMPANY_A);

        expect(reservation.correlationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(before).toEqual([expect.objectContaining({
            company_id: COMPANY_A,
            vapi_call_id: null,
            state: 'admitted',
            twilio_parent_call_sid: 'CA_parent_shared',
        })]);
        const bound = await bind(
            COMPANY_A,
            credentialA,
            reservation.correlationToken,
            'provider-call-own',
        );

        expect(bound).toMatchObject({
            ok: true,
            idempotent: false,
            companyId: COMPANY_A,
            assistantId: 'assistant-registry-a',
            providerCallId: 'provider-call-own',
        });
        expect(await sessionSnapshot(COMPANY_A)).toEqual([expect.objectContaining({
            vapi_call_id: 'provider-call-own',
            state: 'active',
            quarantine_reason: null,
        })]);
    });

    test('SAB-FIX5: revoked call-status credential does not deny inbound reservation', async () => {
        await client.query(
            `UPDATE api_integrations SET revoked_at = now() WHERE id = $1`,
            [statusCredentialA],
        );
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        const reservation = await reserve(COMPANY_A, 'a');

        expect(reservation).toMatchObject({ companyId: COMPANY_A });
        expect(await sessionSnapshot(COMPANY_A)).toEqual([expect.objectContaining({
            state: 'admitted',
        })]);
        const alert = await client.query(
            `SELECT kind, details
             FROM vapi_usage_alerts
             WHERE company_id = $1
               AND vapi_call_session_id = $2`,
            [COMPANY_A, reservation.sessionId],
        );
        expect(alert.rows).toEqual([{
            kind: 'local_missing',
            details: { reason: 'call_status_credential_unavailable' },
        }]);
        errorSpy.mockRestore();
    });

    test('revoked tools credential is also an alert, never inbound admission', async () => {
        await client.query(
            `UPDATE api_integrations SET revoked_at = now() WHERE id = $1`,
            [toolsCredentialA],
        );
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        const reservation = await reserve(COMPANY_A, 'a');

        expect(reservation).toMatchObject({ companyId: COMPANY_A });
        const alert = await client.query(
            `SELECT kind, details
             FROM vapi_usage_alerts
             WHERE company_id = $1
               AND vapi_call_session_id = $2`,
            [COMPANY_A, reservation.sessionId],
        );
        expect(alert.rows).toEqual([{
            kind: 'local_missing',
            details: { reason: 'vapi_tools_credential_unavailable' },
        }]);
        errorSpy.mockRestore();
    });

    test('duplicate exact bind is idempotent and creates no second session', async () => {
        const reservation = await reserve(COMPANY_A, 'a');
        const first = await bind(
            COMPANY_A,
            credentialA,
            reservation.correlationToken,
            'provider-call-duplicate',
        );
        const duplicate = await bind(
            COMPANY_A,
            credentialA,
            reservation.correlationToken,
            'provider-call-duplicate',
        );

        expect(first.idempotent).toBe(false);
        expect(duplicate).toMatchObject({ ok: true, idempotent: true });
        expect(await sessionSnapshot(COMPANY_A)).toHaveLength(1);
    });

    test('duplicate exact bind stays idempotent after profile drift and leaves the session unchanged', async () => {
        const reservation = await reserve(COMPANY_A, 'a');
        await bind(
            COMPANY_A,
            credentialA,
            reservation.correlationToken,
            'provider-call-drifted-retry',
        );
        const before = await fullSessionSnapshot(COMPANY_A);
        await client.query(
            `UPDATE vapi_assistant_profiles
             SET is_active = false
             WHERE id = 'vapi-identity-profile-a'`,
        );

        const duplicate = await bind(
            COMPANY_A,
            credentialA,
            reservation.correlationToken,
            'provider-call-drifted-retry',
        );

        expect(duplicate).toMatchObject({
            ok: true,
            idempotent: true,
            providerCallId: 'provider-call-drifted-retry',
        });
        expect(await fullSessionSnapshot(COMPANY_A)).toEqual(before);
    });

    test('re-entering the same flow node preserves an unbound reservation already in flight', async () => {
        await reserve(COMPANY_A, 'a');
        const before = await fullSessionSnapshot(COMPANY_A);

        await expect(reserve(COMPANY_A, 'a')).rejects.toMatchObject({
            code: 'VAPI_IDENTITY_RESERVATION_IN_FLIGHT',
            status: 409,
        });

        expect(await fullSessionSnapshot(COMPANY_A)).toEqual(before);
    });

    test('T-foreign token lookup is 404 and both tenant snapshots are unchanged', async () => {
        const reservationA = await reserve(COMPANY_A, 'a');
        await reserve(COMPANY_B, 'b');
        const beforeA = await sessionSnapshot(COMPANY_A);
        const beforeB = await sessionSnapshot(COMPANY_B);

        await expect(bind(
            COMPANY_B,
            credentialB,
            reservationA.correlationToken,
            'provider-call-foreign',
        )).rejects.toMatchObject({ code: 'VAPI_IDENTITY_TOKEN_NOT_FOUND', status: 404 });

        expect(await sessionSnapshot(COMPANY_A)).toEqual(beforeA);
        expect(await sessionSnapshot(COMPANY_B)).toEqual(beforeB);
    });

    test('T-blast same operation binds only the addressed tenant and leaves the other byte-unchanged', async () => {
        const reservationA = await reserve(COMPANY_A, 'a');
        await reserve(COMPANY_B, 'b');
        const beforeB = await sessionSnapshot(COMPANY_B);

        await bind(
            COMPANY_A,
            credentialA,
            reservationA.correlationToken,
            'provider-call-blast-a',
        );

        expect(await sessionSnapshot(COMPANY_B)).toEqual(beforeB);
        expect(await sessionSnapshot(COMPANY_A)).toEqual([expect.objectContaining({
            vapi_call_id: 'provider-call-blast-a',
            state: 'active',
        })]);
    });

    test('credential rotation overlap accepts only an explicitly admitted same-company credential', async () => {
        const reservation = await reserve(COMPANY_A, 'a');
        await client.query(
            `INSERT INTO vapi_company_credential_acceptance (
                 company_id, environment, machine_surface, credential_id,
                 acceptance_state, expires_at
             ) VALUES ($1, 'prod', 'vapi_assistant_request', $2, 'rotating', NULL)`,
            [COMPANY_A, credentialAOther],
        );
        const outcome = await bind(
            COMPANY_A,
            credentialAOther,
            reservation.correlationToken,
            'provider-call-wrong-credential',
        );

        expect(outcome).toMatchObject({ ok: true, providerCallId: 'provider-call-wrong-credential' });
        expect(await sessionSnapshot(COMPANY_A)).toEqual([expect.objectContaining({
            vapi_call_id: 'provider-call-wrong-credential',
            state: 'active',
            quarantine_reason: null,
        })]);
    });

    test('arbitrary active same-company credential is not a substitute for the session pin', async () => {
        const reservation = await reserve(COMPANY_A, 'a');

        const outcome = await bind(
            COMPANY_A,
            credentialAOther,
            reservation.correlationToken,
            'provider-call-unadmitted-credential',
        );

        expect(outcome).toMatchObject({ ok: false, code: 'execution_tuple_drift' });
        expect(await sessionSnapshot(COMPANY_A)).toEqual([expect.objectContaining({
            vapi_call_id: null,
            state: 'quarantined',
        })]);
    });

    test('credential revoked after admission quarantines rather than using stale authority', async () => {
        const reservation = await reserve(COMPANY_A, 'a');
        await client.query('UPDATE api_integrations SET revoked_at = now() WHERE id = $1', [credentialA]);

        const outcome = await bind(
            COMPANY_A,
            credentialA,
            reservation.correlationToken,
            'provider-call-revoked',
        );

        expect(outcome).toMatchObject({ ok: false, code: 'execution_tuple_drift' });
        expect(await sessionSnapshot(COMPANY_A)).toEqual([expect.objectContaining({
            state: 'quarantined',
            quarantine_reason: 'execution_tuple_drift',
        })]);
    });

    test('provider call id collision spans empty and populated per-company provider org ids', async () => {
        const providerOrgs = await client.query(
            `SELECT company_id, provider_org_id
             FROM provider_connections
             WHERE id IN ('vapi-identity-connection-a', 'vapi-identity-connection-b')
             ORDER BY company_id`,
        );
        expect(providerOrgs.rows).toEqual([
            { company_id: COMPANY_A, provider_org_id: '' },
            { company_id: COMPANY_B, provider_org_id: 'org-fixture-platform' },
        ]);

        const reservationA = await reserve(COMPANY_A, 'a');
        const reservationB = await reserve(COMPANY_B, 'b');
        await bind(
            COMPANY_A,
            credentialA,
            reservationA.correlationToken,
            'provider-call-collision',
        );
        const beforeA = await sessionSnapshot(COMPANY_A);

        const outcome = await bind(
            COMPANY_B,
            credentialB,
            reservationB.correlationToken,
            'provider-call-collision',
        );

        expect(outcome).toMatchObject({
            ok: false,
            code: 'provider_call_collision',
            companyId: COMPANY_B,
        });
        expect(await sessionSnapshot(COMPANY_A)).toEqual(beforeA);
        expect(await sessionSnapshot(COMPANY_B)).toEqual([expect.objectContaining({
            vapi_call_id: null,
            state: 'quarantined',
            quarantine_reason: 'provider_call_collision',
        })]);
    });

    test('DB rejects one provider call id across fragmented provider account labels', async () => {
        await client.query(
            `INSERT INTO vapi_call_sessions (
                 company_id, direction, purpose, environment,
                 provider_account_key, vapi_call_id, bound_at, state
             ) VALUES ($1, 'outbound', 'outbound_lead_call', 'prod',
                       'vapi:platform', 'provider-call-global-unique', now(), 'active')`,
            [COMPANY_A],
        );

        await expectUniqueViolation(
            `INSERT INTO vapi_call_sessions (
                 company_id, direction, purpose, environment,
                 provider_account_key, vapi_call_id, bound_at, state
             ) VALUES ($1, 'outbound', 'outbound_lead_call', 'prod',
                       'org-fixture-platform', 'provider-call-global-unique', now(), 'active')`,
            [COMPANY_B],
            'uq_vapi_call_sessions_provider_call',
        );
    });

    test('one-time token reused for a different provider id is quarantined', async () => {
        const reservation = await reserve(COMPANY_A, 'a');
        await bind(
            COMPANY_A,
            credentialA,
            reservation.correlationToken,
            'provider-call-original',
        );

        const outcome = await bind(
            COMPANY_A,
            credentialA,
            reservation.correlationToken,
            'provider-call-substitute',
        );

        expect(outcome).toMatchObject({ ok: false, code: 'correlation_token_reused' });
        expect(await sessionSnapshot(COMPANY_A)).toEqual([expect.objectContaining({
            vapi_call_id: 'provider-call-original',
            state: 'quarantined',
            quarantine_reason: 'correlation_token_reused',
        })]);
    });

    test('two AI legs retain distinct sessions/provider ids under one Twilio parent', async () => {
        const first = await reserve(COMPANY_A, 'a', 'vapi-node-1');
        await bind(COMPANY_A, credentialA, first.correlationToken, 'provider-call-leg-1');
        const second = await reserve(COMPANY_A, 'a', 'vapi-node-2');
        await bind(COMPANY_A, credentialA, second.correlationToken, 'provider-call-leg-2');

        const sessions = await sessionSnapshot(COMPANY_A);
        expect(sessions).toHaveLength(2);
        expect(sessions.map((row) => row.vapi_call_id).sort()).toEqual([
            'provider-call-leg-1',
            'provider-call-leg-2',
        ]);
        expect(new Set(sessions.map((row) => row.twilio_parent_call_sid)))
            .toEqual(new Set(['CA_parent_shared']));
    });

    test('deleting retained flow execution preserves the call session and nulls its origin link', async () => {
        await seedExecution(COMPANY_A, 'retention', 'CA_parent_retention');
        const reservation = await identity.reserveInboundSessionWithClient({
            companyId: COMPANY_A,
            twilioParentCallSid: 'CA_parent_retention',
            flowExecutionId: 'flow-execution-retention',
            flowNodeId: 'vapi-node-retention',
            purpose: 'inbound_call',
            environment: 'prod',
        }, client);

        await client.query(
            `DELETE FROM call_flow_executions
             WHERE id = 'flow-execution-retention'
               AND company_id = $1`,
            [COMPANY_A],
        );
        const retained = await client.query(
            `SELECT id, company_id, flow_execution_id, flow_node_id, state
             FROM vapi_call_sessions
             WHERE id = $1
               AND company_id = $2`,
            [reservation.sessionId, COMPANY_A],
        );

        expect(retained.rows).toEqual([expect.objectContaining({
            id: reservation.sessionId,
            company_id: COMPANY_A,
            flow_execution_id: null,
            flow_node_id: 'vapi-node-retention',
            state: 'admitted',
        })]);
    });

    test('FIX-20 unattributed alert persists provider identity and deduplicates on the live table', async () => {
        const input = {
            companyId: COMPANY_A,
            providerCallId: 'provider-call-unattributed-real-table',
            reason: 'assistant_request_bind_failed',
        };
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        await identity.recordUnattributedInboundCall(input, client);
        await identity.recordUnattributedInboundCall(input, client);

        const alerts = await client.query(
            `SELECT company_id, provider_call_id, kind, dedupe_key, details
             FROM vapi_usage_alerts
             WHERE company_id = $1
               AND provider_call_id = $2`,
            [COMPANY_A, input.providerCallId],
        );
        expect(alerts.rows).toEqual([{
            company_id: COMPANY_A,
            provider_call_id: input.providerCallId,
            kind: 'provider_orphan',
            dedupe_key: `provider_orphan:${input.providerCallId}:assistant_request_unattributed`,
            details: {
                providerCallId: input.providerCallId,
                reason: input.reason,
            },
        }]);
        errorSpy.mockRestore();
    });
});
