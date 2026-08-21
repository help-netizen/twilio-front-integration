'use strict';

const { Pool } = require('pg');

const mockReserveInboundSession = jest.fn();
jest.mock('../../backend/src/services/vapiCallIdentityService', () => ({
    TOKEN_HEADER: 'x-albusto-call-token',
    reserveInboundSession: (...args) => mockReserveInboundSession(...args),
}));
jest.mock('../../backend/src/services/callAgentExclusionService', () => ({
    isExcludedForAgent: jest.fn().mockResolvedValue(false),
}));
jest.mock('../../backend/src/services/realtimeService', () => ({
    broadcast: jest.fn(),
    publishCallUpdate: jest.fn(),
}));
jest.mock('../../backend/src/services/groupRouting', () => ({
    availableAgentsForGroup: jest.fn(),
    isBusinessHours: jest.fn(),
}));

const {
    renderVapiNode,
    resolveVapiSipUriFallback,
} = require('../../backend/src/services/callFlowRuntime');
const vapiAssistantRegistry = require('../../backend/src/services/vapiAssistantRegistryService');

const COMPANY_ID = '50000000-0000-4000-8000-000000000071';
const CONNECTION_ID = 'vapi-fallback-real-connection';
const RESOURCE_ID = 'vapi-fallback-real-resource';
const SIP_URI = 'sip:real-fallback@sip.vapi.ai';
const FALLBACK_ASSISTANT_ID = 'assistant-real-fallback';
const ALTERNATE_RESOURCE_ID = 'vapi-fallback-alternate-resource';
const ALTERNATE_SIP_URI = 'sip:newer-but-lower-priority@sip.vapi.ai';

let pool;
let client;

async function seedFallbackResource() {
    await client.query(
        `INSERT INTO companies (id, name, slug, status)
         VALUES ($1, 'Fallback Real DB', 'fallback-real-db', 'active')`,
        [COMPANY_ID],
    );
    await client.query(
        `INSERT INTO provider_connections (
             id, tenant_id, company_id, provider, environment, status
         ) VALUES ($1, 'fallback-real-db', $2, 'vapi', 'prod', 'active')`,
        [CONNECTION_ID, COMPANY_ID],
    );
    await client.query(
         `INSERT INTO vapi_tenant_resources (
             id, tenant_id, company_id, provider_connection_id, environment,
             sip_uri, is_active, purpose, status, fallback_vapi_assistant_id,
             created_at
         ) VALUES (
             $1, 'fallback-real-db', $2, $3, 'prod',
             $4, true, 'inbound_call', NULL, NULL,
             '2025-01-01T00:00:00.000Z'
         )`,
        [RESOURCE_ID, COMPANY_ID, CONNECTION_ID, SIP_URI],
    );
}

async function renderAfterReservationFailure() {
    const fallbackAddress = await resolveVapiSipUriFallback(
        COMPANY_ID,
        client.query.bind(client),
    );
    if (fallbackAddress !== SIP_URI) {
        throw new Error(
            `Inbound safety net must resolve the company SIP address; received ${String(fallbackAddress)}`,
        );
    }
    mockReserveInboundSession.mockRejectedValueOnce(Object.assign(
        new Error('tuple unavailable'),
        { code: 'VAPI_IDENTITY_TUPLE_UNAVAILABLE' },
    ));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
        return await renderVapiNode({
            execution: {
                id: 'fallback-real-execution',
                company_id: COMPANY_ID,
                call_sid: 'CA_fallback_real',
            },
            node: { id: 'vapi-real', kind: 'vapi_agent', config: {} },
            context: { baseUrl: 'https://example.test' },
            traceId: 'fallback-real-db',
        }, {
            query: client.query.bind(client),
        });
    } finally {
        errorSpy.mockRestore();
    }
}

beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
    await client.query('BEGIN');
});

beforeEach(async () => {
    jest.clearAllMocks();
    // Make the legacy env assistant constructively tenant-safe for this fixture:
    // exactly one company has an eligible SIP resource in the visible snapshot.
    await client.query('UPDATE vapi_tenant_resources SET is_active = false');
    await client.query('DELETE FROM vapi_tenant_voice_configs WHERE company_id = $1', [COMPANY_ID]);
    await client.query('DELETE FROM vapi_tenant_resources WHERE company_id = $1', [COMPANY_ID]);
    await client.query('DELETE FROM vapi_assistant_profiles WHERE company_id = $1', [COMPANY_ID]);
    await client.query('DELETE FROM provider_connections WHERE company_id = $1', [COMPANY_ID]);
    await client.query('DELETE FROM companies WHERE id = $1', [COMPANY_ID]);
    await seedFallbackResource();
});

afterAll(async () => {
    if (client) {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
    }
    if (pool) await pool.end();
});

test('SAB-FIX1: empty voice config and empty registry still answer through company SIP', async () => {
    const counts = await client.query(
        `SELECT
             (SELECT COUNT(*)::int FROM vapi_tenant_voice_configs WHERE company_id = $1) AS configs,
             (SELECT COUNT(*)::int FROM vapi_assistant_profiles WHERE company_id = $1) AS profiles`,
        [COMPANY_ID],
    );
    expect(counts.rows[0]).toEqual({ configs: 0, profiles: 0 });

    await expect(vapiAssistantRegistry.resolveInboundAssistant({
        companyId: COMPANY_ID,
        client,
        legacyAssistantId: FALLBACK_ASSISTANT_ID,
    })).resolves.toMatchObject({
        company_id: COMPANY_ID,
        expected_vapi_assistant_id: FALLBACK_ASSISTANT_ID,
    });

    const twiml = await renderAfterReservationFailure();

    expect(twiml).toContain('<Sip');
    expect(twiml).toContain(`>${SIP_URI}</Sip>`);
    expect(twiml).not.toContain('x-albusto-call-token');
});

test('SAB-FIX17: empty fallback column plus a minimal live resource still selects the company assistant', async () => {
    const resource = await client.query(
        `SELECT fallback_vapi_assistant_id, status, assistant_profile_id
         FROM vapi_tenant_resources
         WHERE id = $1`,
        [RESOURCE_ID],
    );
    expect(resource.rows).toEqual([{
        fallback_vapi_assistant_id: null,
        status: null,
        assistant_profile_id: null,
    }]);

    await expect(vapiAssistantRegistry.resolveInboundAssistant({
        companyId: COMPANY_ID,
        client,
        legacyAssistantId: FALLBACK_ASSISTANT_ID,
    })).resolves.toMatchObject({
        company_id: COMPANY_ID,
        expected_vapi_assistant_id: FALLBACK_ASSISTANT_ID,
    });
});

test('SAB-FIX24: preferred inbound/prod SIP row wins over a newer alternative', async () => {
    await client.query(
        `INSERT INTO vapi_tenant_resources (
             id, tenant_id, company_id, provider_connection_id, environment,
             sip_uri, is_active, purpose, status, created_at
         ) VALUES (
             $1, 'fallback-real-db', $2, $3, 'staging',
             $4, true, 'legacy_sip', 'active', '2026-08-17T00:00:00.000Z'
         )`,
        [ALTERNATE_RESOURCE_ID, COMPANY_ID, CONNECTION_ID, ALTERNATE_SIP_URI],
    );

    await expect(resolveVapiSipUriFallback(
        COMPANY_ID,
        client.query.bind(client),
    )).resolves.toBe(SIP_URI);
});

test.each([
    'legacy_canary',
    'provisioning',
    'ready',
    'enabled',
    'suspended',
])('%s rollout state cannot disable the reservation-failure safety net', async (rolloutState) => {
    await client.query(
        `INSERT INTO vapi_tenant_voice_configs (
             company_id, environment, rollout_state, readiness_evidence
         ) VALUES ($1, 'prod', $2, '{}'::jsonb)`,
        [COMPANY_ID, rolloutState],
    );

    const twiml = await renderAfterReservationFailure();

    expect(twiml).toContain('<Sip');
    expect(twiml).toContain(`>${SIP_URI}</Sip>`);
    expect(twiml).not.toContain('x-albusto-call-token');
});
