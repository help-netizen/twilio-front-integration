'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { Pool } = require('pg');

const ingestService = require('../backend/src/services/vapiUsageIngestService');

const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
const TAG = `${Date.now()}-${process.pid}`;
const MIGRATION_266 = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '266_vapi_call_identity_and_usage.sql'),
    'utf8',
);
const MIGRATION_267 = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '267_vapi_provisional_usage_ingest.sql'),
    'utf8',
);

let pool;
let client;
let statusCredentialA;
let statusCredentialB;
let assistantRequestCredentialA;
let jobA;
let jobB;

function exactNumber(value) {
    return `__EXACT_NUMBER_${value}__`;
}

function exactJson(value) {
    return JSON.stringify(value).replace(
        /"__EXACT_NUMBER_([^"_]+)__"/g,
        (_match, lexeme) => lexeme,
    );
}

function costBreakdown(cost) {
    return {
        transport: exactNumber(cost),
        stt: exactNumber('0'),
        llm: exactNumber('0'),
        tts: exactNumber('0'),
        vapi: exactNumber('0'),
        chat: exactNumber('0'),
        total: exactNumber(cost),
        llmPromptTokens: exactNumber('0'),
        llmCompletionTokens: exactNumber('0'),
        llmCachedPromptTokens: exactNumber('0'),
        ttsCharacters: exactNumber('0'),
        analysisCostBreakdown: {
            summary: exactNumber('0'),
            structuredData: exactNumber('0'),
            structuredOutput: exactNumber('0'),
            successEvaluation: exactNumber('0'),
            summaryPromptTokens: exactNumber('0'),
            summaryCompletionTokens: exactNumber('0'),
            summaryCachedPromptTokens: exactNumber('0'),
            structuredDataPromptTokens: exactNumber('0'),
            structuredDataCompletionTokens: exactNumber('0'),
            structuredDataCachedPromptTokens: exactNumber('0'),
            structuredOutputPromptTokens: exactNumber('0'),
            structuredOutputCompletionTokens: exactNumber('0'),
            structuredOutputCachedPromptTokens: exactNumber('0'),
            successEvaluationPromptTokens: exactNumber('0'),
            successEvaluationCompletionTokens: exactNumber('0'),
            successEvaluationCachedPromptTokens: exactNumber('0'),
        },
    };
}

function endOfCallRaw({
    callId,
    assistantId,
    type,
    cost = '0.0107',
    updatedAt = '2026-08-16T05:55:02.208Z',
    costPlacement = 'call',
    extra = {},
}) {
    const call = {
        id: callId,
        orgId: 'org-fixture-platform',
        type,
        assistantId,
        status: 'ended',
        endedReason: 'customer-ended-call',
        createdAt: '2026-08-16T05:53:54.153Z',
        updatedAt,
        startedAt: '2026-08-16T05:53:56.852Z',
        endedAt: '2026-08-16T05:54:57.246Z',
    };
    const message = {
        type: 'end-of-call-report',
        endedReason: 'customer-ended-call',
        call,
        ...extra,
    };
    const costFields = {
        cost: exactNumber(cost),
        costBreakdown: costBreakdown(cost),
    };
    Object.assign(costPlacement === 'message' ? message : call, costFields);
    return exactJson({ message });
}

function statusRaw({ callId, assistantId, type, status = 'in-progress' }) {
    return JSON.stringify({
        message: {
            type: 'status-update',
            status,
            call: {
                id: callId,
                orgId: 'org-fixture-platform',
                type,
                assistantId,
                status,
                createdAt: '2026-08-16T05:53:54.153Z',
                startedAt: '2026-08-16T05:53:56.852Z',
            },
        },
    });
}

async function seedCredential(companyId, surface, scope, suffix) {
    const result = await client.query(
        `INSERT INTO api_integrations (
             client_name, key_id, secret_hash, scopes, company_id, machine_surface
         ) VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         RETURNING id`,
        [
            `Vapi ingest ${suffix}`,
            `vapi_ingest_${suffix}_${TAG}`,
            `secret_hash_${suffix}_${TAG}`,
            JSON.stringify([scope]),
            companyId,
            surface,
        ],
    );
    return String(result.rows[0].id);
}

async function seedConnection(companyId, suffix) {
    const connectionId = `vapi-ingest-connection-${suffix}-${TAG}`;
    await client.query(
        `INSERT INTO provider_connections (
             id, tenant_id, provider, environment, status, company_id, provider_org_id
         ) VALUES ($1, $2, 'vapi', 'prod', 'active', $3, $4)`,
        [connectionId, `tenant-${suffix}-${TAG}`, companyId, `org-${suffix}`],
    );
    return connectionId;
}

async function seedProfile(companyId, connectionId, suffix, purpose, assistantId) {
    const profileId = `vapi-ingest-profile-${suffix}-${TAG}`;
    await client.query(
        `INSERT INTO vapi_assistant_profiles (
             id, tenant_id, provider_connection_id, slug, purpose,
             vapi_assistant_id, is_active, company_id, environment
         ) VALUES ($1, $2, $3, $4, $5, $6, true, $7, 'prod')`,
        [
            profileId,
            `tenant-${suffix}-${TAG}`,
            connectionId,
            `profile-${suffix}-${TAG}`,
            purpose,
            assistantId,
            companyId,
        ],
    );
    return { connectionId, profileId };
}

async function seedBaseData() {
    await client.query(
        `INSERT INTO companies (id, name, slug, status)
         VALUES ($1, $2, $3, 'active'), ($4, $5, $6, 'active')`,
        [
            COMPANY_A,
            `Vapi ingest A ${TAG}`,
            `vapi-ingest-a-${TAG}`,
            COMPANY_B,
            `Vapi ingest B ${TAG}`,
            `vapi-ingest-b-${TAG}`,
        ],
    );
    statusCredentialA = await seedCredential(
        COMPANY_A,
        'vapi_call_status',
        'vapi_call_status:invoke',
        'status-a',
    );
    statusCredentialB = await seedCredential(
        COMPANY_B,
        'vapi_call_status',
        'vapi_call_status:invoke',
        'status-b',
    );
    assistantRequestCredentialA = await seedCredential(
        COMPANY_A,
        'vapi_assistant_request',
        'vapi_assistant_request:invoke',
        'assistant-a',
    );

    const connectionA = await seedConnection(COMPANY_A, 'a');
    const connectionB = await seedConnection(COMPANY_B, 'b');
    const inbound = await seedProfile(
        COMPANY_A,
        connectionA,
        'inbound-a',
        'inbound_call',
        'assistant-inbound-a',
    );
    await seedProfile(
        COMPANY_A,
        connectionA,
        'outbound-a',
        'outbound_parts_call',
        'assistant-outbound-a',
    );
    await seedProfile(
        COMPANY_B,
        connectionB,
        'outbound-b',
        'outbound_parts_call',
        'assistant-outbound-b',
    );
    await client.query(
        `INSERT INTO vapi_tenant_resources (
             id, tenant_id, provider_connection_id, environment, sip_uri,
             is_active, company_id, purpose, assistant_profile_id,
             server_credential_id
         ) VALUES ($1, $2, $3, 'prod', $4, true, $5, 'inbound_call', $6, $7)`,
        [
            `vapi-ingest-resource-a-${TAG}`,
            `tenant-inbound-a-${TAG}`,
            inbound.connectionId,
            `sip:ingest-${TAG}@sip.vapi.ai`,
            COMPANY_A,
            inbound.profileId,
            assistantRequestCredentialA,
        ],
    );

    const jobs = await client.query(
        `INSERT INTO jobs (company_id, job_number, customer_name, blanc_status)
         VALUES ($1, $3, 'Fixture A', 'Part arrived'),
                ($2, $4, 'Fixture B', 'Part arrived')
         RETURNING id, company_id`,
        [COMPANY_A, COMPANY_B, `VI-A-${TAG}`, `VI-B-${TAG}`],
    );
    jobA = jobs.rows.find((row) => row.company_id === COMPANY_A).id;
    jobB = jobs.rows.find((row) => row.company_id === COMPANY_B).id;
}

async function resetCallFixtures() {
    await client.query('DELETE FROM vapi_call_usage');
    await client.query('DELETE FROM vapi_call_usage_observations');
    await client.query('DELETE FROM vapi_call_sessions');
    await client.query(
        `DELETE FROM outbound_call_attempts
         WHERE company_id = ANY($1::uuid[])`,
        [[COMPANY_A, COMPANY_B]],
    );
    await client.query(
        `INSERT INTO vapi_call_sessions (
             company_id, direction, purpose, environment,
             provider_connection_id, assistant_profile_id, tenant_resource_id,
             assistant_request_credential_id, provider_account_key,
             expected_vapi_assistant_id, vapi_call_id, twilio_parent_call_sid,
             flow_node_id, correlation_token_hash, correlation_expires_at,
             correlation_consumed_at, bind_source, bound_at, state
         )
         SELECT $1, 'inbound', 'inbound_call', 'prod',
                profile.provider_connection_id, profile.id, resource.id,
                resource.server_credential_id, 'vapi:platform',
                profile.vapi_assistant_id, 'provider-inbound-a', 'CA_parent_fixture',
                'vapi-node', $2, now() + interval '5 minutes', now(),
                'assistant_request', now(), 'active'
         FROM vapi_assistant_profiles profile
         JOIN vapi_tenant_resources resource
           ON resource.assistant_profile_id = profile.id
          AND resource.company_id = profile.company_id
         WHERE profile.company_id = $1
           AND profile.purpose = 'inbound_call'`,
        [COMPANY_A, 'a'.repeat(64)],
    );
    await client.query(
        `INSERT INTO outbound_call_attempts (
             company_id, job_id, scenario, attempt_no, status, scheduled_at, vapi_call_id
         ) VALUES
             ($1, $3, 'parts_visit', 1, 'dialing', now(), 'provider-outbound-a'),
             ($2, $4, 'parts_visit', 1, 'dialing', now(), 'provider-outbound-b')`,
        [COMPANY_A, COMPANY_B, jobA, jobB],
    );
}

async function ingest({ companyId = COMPANY_A, credentialId = statusCredentialA, rawJson }) {
    return ingestService.ingestServerMessageWithClient({
        companyId,
        credentialId,
        rawJson,
    }, client);
}

async function counts(companyId = COMPANY_A) {
    const result = await client.query(
        `SELECT
             (SELECT count(*)::int FROM vapi_call_usage_observations WHERE company_id = $1)
                 AS observations,
             (SELECT count(*)::int FROM vapi_call_usage WHERE company_id = $1)
                 AS usage,
             (SELECT count(*)::int FROM billing_wallet_ledger WHERE company_id = $1)
                 AS wallet_entries`,
        [companyId],
    );
    return result.rows[0];
}

beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(MIGRATION_266);
    await client.query(MIGRATION_267);
    await seedBaseData();
});

beforeEach(async () => {
    await resetCallFixtures();
});

afterAll(async () => {
    if (client) {
        await client.query('ROLLBACK');
        client.release();
    }
    if (pool) await pool.end();
});

describe('VAPI-AGENCY-001 T3 provisional supplier usage ingest', () => {
    test('duplicate inbound EoC creates one append-only observation and one provisional row', async () => {
        const rawJson = endOfCallRaw({
            callId: 'provider-inbound-a',
            assistantId: 'assistant-inbound-a',
            type: 'inboundPhoneCall',
        });

        const [first, duplicate] = await Promise.all([
            ingest({ rawJson }),
            ingest({ rawJson }),
        ]);
        const repeated = await ingest({ rawJson });

        expect([first.observationCreated, duplicate.observationCreated].sort()).toEqual([
            false,
            true,
        ]);
        expect(first).toMatchObject({ correlated: true, validationState: 'accepted' });
        expect(duplicate).toMatchObject({ correlated: true, validationState: 'accepted' });
        expect(repeated).toMatchObject({
            correlated: true,
            observationCreated: false,
            validationState: 'accepted',
        });
        expect(await counts()).toEqual({
            observations: 1,
            usage: 1,
            wallet_entries: 0,
        });
        const stored = await client.query(
            `SELECT observation.supplier_cost::text,
                    observation.breakdown_total::text,
                    usage.state
             FROM vapi_call_usage_observations observation
             JOIN vapi_call_usage usage
               ON usage.vapi_call_session_id = observation.vapi_call_session_id
              AND usage.company_id = observation.company_id
             WHERE observation.company_id = $1`,
            [COMPANY_A],
        );
        expect(stored.rows).toEqual([{
            supplier_cost: '0.010700000000',
            breakdown_total: '0.010700000000',
            state: 'provisional',
        }]);
    });

    test('unknown and foreign provider ids create no session, observation, usage or wallet row', async () => {
        const unknown = await ingest({
            rawJson: endOfCallRaw({
                callId: 'provider-unknown',
                assistantId: 'assistant-inbound-a',
                type: 'inboundPhoneCall',
            }),
        });
        const foreign = await ingest({
            rawJson: endOfCallRaw({
                callId: 'provider-outbound-b',
                assistantId: 'assistant-outbound-b',
                type: 'outboundPhoneCall',
            }),
        });

        expect(unknown.correlated).toBe(false);
        expect(foreign.correlated).toBe(false);
        expect(await counts(COMPANY_A)).toEqual({ observations: 0, usage: 0, wallet_entries: 0 });
        expect(await counts(COMPANY_B)).toEqual({ observations: 0, usage: 0, wallet_entries: 0 });
        const foreignAttempt = await client.query(
            `SELECT status FROM outbound_call_attempts
             WHERE company_id = $1 AND vapi_call_id = 'provider-outbound-b'`,
            [COMPANY_B],
        );
        expect(foreignAttempt.rows).toEqual([{ status: 'dialing' }]);
    });

    test('inbound session and outbound attempt produce the same typed observation shape', async () => {
        await ingest({
            rawJson: endOfCallRaw({
                callId: 'provider-inbound-a',
                assistantId: 'assistant-inbound-a',
                type: 'inboundPhoneCall',
            }),
        });
        const outbound = await ingest({
            rawJson: endOfCallRaw({
                callId: 'provider-outbound-a',
                assistantId: 'assistant-outbound-a',
                type: 'outboundPhoneCall',
            }),
        });

        expect(outbound).toMatchObject({ correlated: true, observationCreated: true });
        expect(outbound.attempt).toMatchObject({ company_id: COMPANY_A, id: expect.any(String) });
        const rows = await client.query(
            `SELECT session.direction, observation.source,
                    observation.supplier_cost::text,
                    observation.breakdown_total::text,
                    observation.transport_cost::text,
                    observation.analysis_cost::text,
                    observation.prompt_tokens::text,
                    observation.completion_tokens::text,
                    observation.total_tokens::text,
                    observation.validation_state,
                    usage.state
             FROM vapi_call_usage_observations observation
             JOIN vapi_call_sessions session
               ON session.id = observation.vapi_call_session_id
              AND session.company_id = observation.company_id
             JOIN vapi_call_usage usage
               ON usage.vapi_call_session_id = observation.vapi_call_session_id
              AND usage.company_id = observation.company_id
             WHERE observation.company_id = $1
             ORDER BY session.direction`,
            [COMPANY_A],
        );
        expect(rows.rows).toHaveLength(2);
        const [{ direction: inboundDirection, ...inbound }, { direction: outboundDirection, ...outboundRow }]
            = rows.rows;
        expect(inboundDirection).toBe('inbound');
        expect(outboundDirection).toBe('outbound');
        expect(outboundRow).toEqual(inbound);
    });

    test('changed EoC amount appends evidence but updates one provisional projection only', async () => {
        const base = {
            callId: 'provider-inbound-a',
            assistantId: 'assistant-inbound-a',
            type: 'inboundPhoneCall',
        };
        await ingest({ rawJson: endOfCallRaw({ ...base, cost: '0.10' }) });
        await ingest({
            rawJson: endOfCallRaw({
                ...base,
                cost: '0.12',
                updatedAt: '2026-08-16T05:56:02.208Z',
            }),
        });

        expect(await counts()).toEqual({ observations: 2, usage: 1, wallet_entries: 0 });
        const projection = await client.query(
            `SELECT supplier_cost::text, state, final_snapshot_version,
                    provisional_observation_id IS NOT NULL AS linked
             FROM vapi_call_usage
             WHERE company_id = $1`,
            [COMPANY_A],
        );
        expect(projection.rows).toEqual([{
            supplier_cost: '0.120000000000',
            state: 'provisional',
            final_snapshot_version: 0,
            linked: true,
        }]);
    });

    test('large exact-decimal set stays NUMERIC-safe without per-observation float drift', async () => {
        const base = {
            callId: 'provider-inbound-a',
            assistantId: 'assistant-inbound-a',
            type: 'inboundPhoneCall',
        };
        for (let value = 1n; value <= 256n; value += 1n) {
            const cost = `0.${value.toString().padStart(12, '0')}`;
            await ingest({ rawJson: endOfCallRaw({ ...base, cost }) });
        }

        const exact = await client.query(
            `SELECT count(*)::int AS count,
                    sum(supplier_cost)::text AS exact_sum
             FROM vapi_call_usage_observations
             WHERE company_id = $1`,
            [COMPANY_A],
        );
        expect(exact.rows).toEqual([{
            count: 256,
            exact_sum: '0.000000032896',
        }]);
        const current = await client.query(
            `SELECT supplier_cost::text
             FROM vapi_call_usage
             WHERE company_id = $1`,
            [COMPANY_A],
        );
        expect(current.rows).toEqual([{ supplier_cost: '0.000000000256' }]);
    });

    test('sanitized raw evidence excludes PII and quarantines unproven cost placement', async () => {
        const rawJson = endOfCallRaw({
            callId: 'provider-inbound-a',
            assistantId: 'assistant-inbound-a',
            type: 'inboundPhoneCall',
            costPlacement: 'message',
            extra: {
                transcript: 'Alice called +1 617 555 0101',
                recordingUrl: 'https://recording.invalid/private',
                artifact: { messages: [{ role: 'user', message: 'secret name' }] },
                customer: { name: 'Alice', number: '+16175550101' },
            },
        });

        const result = await ingest({ rawJson });

        expect(result).toMatchObject({
            correlated: true,
            observationCreated: true,
            validationState: 'quarantined',
            validationError: 'required_object:$.message.call.costBreakdown',
        });
        const stored = await client.query(
            `SELECT sanitized_payload, validation_state, supplier_cost, validation_error
             FROM vapi_call_usage_observations
             WHERE company_id = $1`,
            [COMPANY_A],
        );
        expect(stored.rows[0]).toMatchObject({
            validation_state: 'quarantined',
            supplier_cost: null,
            validation_error: 'required_object:$.message.call.costBreakdown',
        });
        expect(stored.rows[0].sanitized_payload.message.cost).toBe('0.0107');
        const evidence = JSON.stringify(stored.rows[0].sanitized_payload);
        expect(evidence).not.toMatch(/Alice|617|recording\.invalid|transcript|artifact|secret name/i);
        expect(stored.rows[0].sanitized_payload.message).not.toHaveProperty('customer');
        expect(await counts()).toEqual({ observations: 1, usage: 1, wallet_entries: 0 });
    });

    test('assistant id must match the pinned registry identity before evidence is written', async () => {
        const result = await ingest({
            rawJson: endOfCallRaw({
                callId: 'provider-inbound-a',
                assistantId: 'assistant-outbound-a',
                type: 'inboundPhoneCall',
            }),
        });

        expect(result).toMatchObject({ correlated: false, reason: 'assistant_mismatch' });
        expect(await counts()).toEqual({ observations: 0, usage: 0, wallet_entries: 0 });
    });

    test('status update uses the same identity but creates no cost observation', async () => {
        const result = await ingest({
            rawJson: statusRaw({
                callId: 'provider-inbound-a',
                assistantId: 'assistant-inbound-a',
                type: 'inboundPhoneCall',
            }),
        });

        expect(result).toMatchObject({ correlated: true, observationCreated: false });
        expect(await counts()).toEqual({ observations: 0, usage: 0, wallet_entries: 0 });
        const session = await client.query(
            `SELECT state, started_at IS NOT NULL AS started
             FROM vapi_call_sessions
             WHERE company_id = $1 AND vapi_call_id = 'provider-inbound-a'`,
            [COMPANY_A],
        );
        expect(session.rows).toEqual([{ state: 'active', started: true }]);
    });

    test('credential company and local identity must agree; body company claims are irrelevant', async () => {
        const rawJson = endOfCallRaw({
            callId: 'provider-outbound-a',
            assistantId: 'assistant-outbound-a',
            type: 'outboundPhoneCall',
            extra: { companyId: COMPANY_B },
        });
        const result = await ingest({
            companyId: COMPANY_B,
            credentialId: statusCredentialB,
            rawJson,
        });

        expect(result.correlated).toBe(false);
        expect(await counts(COMPANY_A)).toEqual({ observations: 0, usage: 0, wallet_entries: 0 });
        expect(await counts(COMPANY_B)).toEqual({ observations: 0, usage: 0, wallet_entries: 0 });
    });

    test('credential from another company cannot be paired with a local company session', async () => {
        const rawJson = endOfCallRaw({
            callId: 'provider-inbound-a',
            assistantId: 'assistant-inbound-a',
            type: 'inboundPhoneCall',
        });

        await expect(ingest({
            companyId: COMPANY_A,
            credentialId: statusCredentialB,
            rawJson,
        })).rejects.toMatchObject({
            code: 'VAPI_USAGE_STATUS_CREDENTIAL_INVALID',
            status: 403,
        });
        expect(await counts(COMPANY_A)).toEqual({ observations: 0, usage: 0, wallet_entries: 0 });
        expect(await counts(COMPANY_B)).toEqual({ observations: 0, usage: 0, wallet_entries: 0 });
    });
});
