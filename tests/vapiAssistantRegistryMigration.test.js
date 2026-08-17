'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const bootstrap = require('../backend/scripts/bootstrap-vapi-assistant-registry');
const identity = require('../backend/src/services/vapiCallIdentityService');
const registry = require('../backend/src/services/vapiAssistantRegistryService');

const ABC = '00000000-0000-0000-0000-000000000001';
const FORWARD = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '275_vapi_assistant_registry.sql'),
    'utf8',
);
const ROLLBACK = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', 'rollback_275_vapi_assistant_registry.sql'),
    'utf8',
);
const ASSISTANTS = Object.freeze({
    inbound: '30e85a87-9d7e-4694-828e-1fea7d10f3ef',
    lead: 'ef874329-1111-4111-8111-111111111111',
    parts: 'c1e2831b-e91f-46a9-86d8-6b40252bd29a',
});
const ENVIRONMENT = Object.freeze({
    VAPI_INBOUND_ASSISTANT_ID: ASSISTANTS.inbound,
    VAPI_LEAD_CALL_ASSISTANT_ID: ASSISTANTS.lead,
    VAPI_OUTBOUND_ASSISTANT_ID: ASSISTANTS.parts,
});

let pool;
let client;

async function cleanAbcData() {
    await client.query(`DELETE FROM vapi_call_sessions WHERE company_id = $1`, [ABC]);
    await client.query(`DELETE FROM vapi_tenant_resources WHERE company_id = $1`, [ABC]);
    await client.query(`DELETE FROM vapi_assistant_profiles WHERE company_id = $1`, [ABC]);
    await client.query(
        `DELETE FROM provider_connections WHERE company_id = $1 AND provider = 'vapi'`,
        [ABC],
    );
    await client.query(
        `DELETE FROM api_integrations
         WHERE company_id = $1
           AND machine_surface IN ('vapi_tools', 'vapi_call_status', 'vapi_assistant_request')`,
        [ABC],
    );
    await client.query(
        `INSERT INTO companies (id, name, slug, status)
         VALUES ($1, 'ABC registry bootstrap', 'abc-registry-bootstrap', 'active')
         ON CONFLICT (id) DO UPDATE SET status = 'active'`,
        [ABC],
    );
}

async function seedCredential(surface, scope) {
    await client.query(
        `INSERT INTO api_integrations (
             client_name, key_id, secret_hash, scopes, company_id, machine_surface
         ) VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
        [
            `Registry ${surface}`,
            `registry-${surface}`,
            `registry-hash-${surface}`,
            JSON.stringify([scope]),
            ABC,
            surface,
        ],
    );
}

async function prepareLegacyAbc({ credentials = true } = {}) {
    await client.query(
        `INSERT INTO provider_connections (
             id, tenant_id, company_id, provider, environment, status,
             encrypted_credentials_json, display_name
         ) VALUES (
             'registry-connection-abc', $1::text, $1::uuid, 'vapi', 'prod', 'active',
             '{"api_key":"legacy-must-be-erased"}', 'legacy provider'
         )`,
        [ABC],
    );
    await client.query(
        `INSERT INTO vapi_tenant_resources (
             id, tenant_id, company_id, provider_connection_id, environment,
             vapi_phone_number_id, sip_uri, assistant_request_secret, is_active,
             purpose
         ) VALUES (
             'registry-resource-abc', $1::text, $1::uuid, 'registry-connection-abc', 'prod',
             'res_registry_abc', 'sip:registry-abc@sip.vapi.ai',
             'legacy-plaintext-secret', true, 'inbound_call'
         )`,
        [ABC],
    );
    if (credentials) {
        await seedCredential('vapi_tools', 'vapi_tools:invoke');
        await seedCredential('vapi_call_status', 'vapi_call_status:invoke');
        await seedCredential('vapi_assistant_request', 'vapi_assistant_request:invoke');
    }
}

async function registrySnapshot() {
    const result = await client.query(
        `SELECT jsonb_build_object(
             'connection', (
                 SELECT jsonb_build_object(
                     'encrypted', encrypted_credentials_json,
                     'updated_at', updated_at
                 )
                 FROM provider_connections
                 WHERE id = 'registry-connection-abc' AND company_id = $1
             ),
             'resource', (
                 SELECT jsonb_build_object(
                     'profile', assistant_profile_id,
                     'credential', server_credential_id,
                     'secret', assistant_request_secret,
                     'status', status,
                     'updated_at', updated_at
                 )
                 FROM vapi_tenant_resources
                 WHERE id = 'registry-resource-abc' AND company_id = $1
             ),
             'profiles', (
                 SELECT COALESCE(jsonb_agg(to_jsonb(profile) ORDER BY profile.purpose), '[]'::jsonb)
                 FROM (
                     SELECT purpose, vapi_assistant_id, tools_credential_id,
                            call_status_credential_id, status, updated_at
                     FROM vapi_assistant_profiles
                     WHERE company_id = $1 AND environment = 'prod'
                 ) profile
             ),
             'config', (
                 SELECT jsonb_build_object(
                     'state', rollout_state,
                     'evidence', readiness_evidence,
                     'updated_at', updated_at
                 )
                 FROM vapi_tenant_voice_configs
                 WHERE company_id = $1 AND environment = 'prod'
             )
         ) AS snapshot`,
        [ABC],
    );
    return result.rows[0].snapshot;
}

beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(ROLLBACK);
    await cleanAbcData();
});

beforeEach(async () => {
    await client.query('SAVEPOINT registry_test');
    await cleanAbcData();
});

afterEach(async () => {
    await client.query('ROLLBACK TO SAVEPOINT registry_test');
    await client.query('RELEASE SAVEPOINT registry_test');
});

afterAll(async () => {
    if (client) {
        await client.query('ROLLBACK');
        client.release();
    }
    if (pool) await pool.end();
});

test('schema-only migration applies twice with no Vapi rows or session settings', async () => {
    await expect(client.query(FORWARD)).resolves.toBeDefined();
    await expect(client.query(FORWARD)).resolves.toBeDefined();

    expect(FORWARD).not.toMatch(/^(?:INSERT|UPDATE|DELETE)\b/im);
    expect(FORWARD).not.toContain('current_setting');
    expect(FORWARD).not.toContain('RAISE EXCEPTION');
    expect(FORWARD).not.toContain('VAPI_INBOUND_ASSISTANT_ID');

    const data = await client.query(
        `SELECT
             (SELECT COUNT(*)::int FROM provider_connections
              WHERE company_id = $1 AND provider = 'vapi') AS connections,
             (SELECT COUNT(*)::int FROM vapi_tenant_resources
              WHERE company_id = $1) AS resources,
             (SELECT COUNT(*)::int FROM vapi_assistant_profiles
              WHERE company_id = $1) AS profiles,
             (SELECT COUNT(*)::int FROM vapi_tenant_voice_configs
              WHERE company_id = $1) AS configs`,
        [ABC],
    );
    expect(data.rows[0]).toEqual({ connections: 0, resources: 0, profiles: 0, configs: 0 });

    await expect(registry.resolveInboundTuple({ companyId: ABC, client }))
        .rejects.toMatchObject({ code: 'VAPI_REGISTRY_INBOUND_TUPLE_UNAVAILABLE' });
});

test('operational connection and SIP prerequisites belong to the CLI, not migration', async () => {
    await client.query(FORWARD);
    await expect(bootstrap.run(['--company-id', ABC, '--apply'], {
        client,
        environment: ENVIRONMENT,
        log: () => {},
    })).rejects.toMatchObject({ code: 'VAPI_REGISTRY_BOOTSTRAP_CONNECTION_REQUIRED' });

    await client.query(
        `INSERT INTO provider_connections (
             id, tenant_id, company_id, provider, environment, status
         ) VALUES (
             'registry-connection-abc', $1::text, $1::uuid, 'vapi', 'prod', 'active'
         )`,
        [ABC],
    );
    await expect(bootstrap.run(['--company-id', ABC, '--apply'], {
        client,
        environment: ENVIRONMENT,
        log: () => {},
    })).rejects.toMatchObject({ code: 'VAPI_REGISTRY_BOOTSTRAP_SIP_RESOURCE_REQUIRED' });

    const rows = await client.query(
        `SELECT COUNT(*)::int AS profiles
         FROM vapi_assistant_profiles
         WHERE company_id = $1`,
        [ABC],
    );
    expect(rows.rows[0].profiles).toBe(0);
});

test('prod-like migration is data-neutral; dry-run writes nothing; apply is idempotent', async () => {
    await prepareLegacyAbc();

    await expect(client.query(FORWARD)).resolves.toBeDefined();
    await expect(client.query(FORWARD)).resolves.toBeDefined();

    const beforeCli = await registrySnapshot();
    expect(beforeCli).toMatchObject({
        connection: { encrypted: '{"api_key":"legacy-must-be-erased"}' },
        resource: { secret: 'legacy-plaintext-secret', profile: null, credential: null },
        profiles: [],
        config: null,
    });

    const dryRun = await bootstrap.run(['--company-id', ABC], {
        client,
        environment: ENVIRONMENT,
        log: () => {},
    });
    expect(dryRun).toMatchObject({
        mode: 'dry-run',
        company_id: ABC,
        writes: false,
        credentials_complete: true,
    });
    expect(await registrySnapshot()).toEqual(beforeCli);

    const first = await bootstrap.run(['--company-id', ABC, '--apply'], {
        client,
        environment: ENVIRONMENT,
        log: () => {},
    });
    expect(first).toMatchObject({
        mode: 'apply',
        company_id: ABC,
        credentials_complete: true,
    });
    const firstSnapshot = await registrySnapshot();
    expect(firstSnapshot).toMatchObject({
        connection: { encrypted: null },
        resource: {
            profile: expect.any(String),
            credential: expect.anything(),
            secret: null,
            status: 'active',
        },
        profiles: [
            expect.objectContaining({ purpose: 'inbound_call', vapi_assistant_id: ASSISTANTS.inbound }),
            expect.objectContaining({ purpose: 'outbound_lead_call', vapi_assistant_id: ASSISTANTS.lead }),
            expect.objectContaining({ purpose: 'outbound_parts_call', vapi_assistant_id: ASSISTANTS.parts }),
        ],
        config: {
            state: 'legacy_canary',
            evidence: expect.objectContaining({
                machine_credentials: expect.objectContaining({ complete: true }),
            }),
        },
    });

    await bootstrap.run(['--company-id', ABC, '--apply'], {
        client,
        environment: ENVIRONMENT,
        log: () => {},
    });
    expect(await registrySnapshot()).toEqual(firstSnapshot);

    await expect(bootstrap.run(['--company-id', ABC, '--apply'], {
        client,
        environment: {
            ...ENVIRONMENT,
            VAPI_LEAD_CALL_ASSISTANT_ID: '11111111-1111-1111-1111-111111111111',
        },
        log: () => {},
    })).rejects.toMatchObject({ code: 'VAPI_REGISTRY_BOOTSTRAP_ASSISTANT_ID_CONFLICT' });
    expect(await registrySnapshot()).toEqual(firstSnapshot);

    await client.query(
        `INSERT INTO call_flow_executions (
             id, company_id, call_sid, current_node_id, context_json, status
         ) VALUES (
             'registry-flow-execution', $1, 'CA_registry_parent', 'ai', '{}', 'active'
         )`,
        [ABC],
    );
    const reservation = await identity.reserveInboundSessionWithClient({
        companyId: ABC,
        twilioParentCallSid: 'CA_registry_parent',
        flowExecutionId: 'registry-flow-execution',
        flowNodeId: 'ai',
        purpose: 'inbound_call',
        environment: 'prod',
    }, client);
    expect(reservation).toMatchObject({
        companyId: ABC,
        sipUri: 'sip:registry-abc@sip.vapi.ai',
    });
    await client.query(`DELETE FROM vapi_call_sessions WHERE id = $1`, [reservation.sessionId]);
    await client.query(`DELETE FROM call_flow_executions WHERE id = 'registry-flow-execution'`);

    await client.query('SAVEPOINT retired_provider_config');
    await expect(client.query(
        `UPDATE vapi_assistant_profiles
         SET base_config_json = '{"assistantOverrides":{"assistantId":"foreign"}}'
         WHERE company_id = $1 AND purpose = 'inbound_call'`,
        [ABC],
    )).rejects.toMatchObject({
        code: '23514',
        constraint: 'chk_vapi_profile_no_tenant_base_config',
    });
    await client.query('ROLLBACK TO SAVEPOINT retired_provider_config');
    await client.query('RELEASE SAVEPOINT retired_provider_config');
});

test('CLI may populate without credentials but runtime remains fail-closed', async () => {
    await prepareLegacyAbc({ credentials: false });
    await client.query(FORWARD);

    await expect(bootstrap.run(['--company-id', ABC, '--apply'], {
        client,
        environment: ENVIRONMENT,
        log: () => {},
    })).resolves.toMatchObject({ credentials_complete: false });

    const snapshot = await registrySnapshot();
    expect(snapshot.profiles).toHaveLength(3);
    expect(snapshot.profiles.every((profile) => (
        profile.tools_credential_id === null
        && profile.call_status_credential_id === null
    ))).toBe(true);
    expect(snapshot.resource.credential).toBeNull();
    expect(snapshot.config.evidence.machine_credentials.complete).toBe(false);
    await expect(registry.resolveInboundTuple({ companyId: ABC, client }))
        .rejects.toMatchObject({ code: 'VAPI_REGISTRY_INBOUND_TUPLE_UNAVAILABLE' });
});

test('global assistant uniqueness cannot fragment by company connection data', async () => {
    await prepareLegacyAbc();
    await client.query(FORWARD);
    await bootstrap.run(['--company-id', ABC, '--apply'], {
        client,
        environment: ENVIRONMENT,
        log: () => {},
    });

    const companyB = '00000000-0000-4000-8000-00000000000b';
    await client.query(
        `INSERT INTO companies (id, name, slug, status)
         VALUES ($1, 'Registry B', 'registry-b', 'active')
         ON CONFLICT (id) DO UPDATE SET status = 'active'`,
        [companyB],
    );
    await client.query(
        `INSERT INTO provider_connections (
             id, tenant_id, company_id, provider, environment, status, provider_org_id
         ) VALUES ('registry-connection-b', $1::text, $1::uuid, 'vapi', 'prod', 'active', 'tenant-fragment')`,
        [companyB],
    );

    await client.query('SAVEPOINT duplicate_assistant');
    await expect(client.query(
        `INSERT INTO vapi_assistant_profiles (
             id, tenant_id, company_id, provider_connection_id, slug, purpose,
             vapi_assistant_id, version, is_active, environment,
             provider_account_key, status
         ) VALUES (
             'registry-profile-b', $1::text, $1::uuid, 'registry-connection-b', 'foreign',
             'outbound_parts_call', $2, '1', false, 'prod', 'vapi:platform', 'disabled'
         )`,
        [companyB, ASSISTANTS.parts],
    )).rejects.toMatchObject({
        code: '23505',
        constraint: 'uq_vapi_profiles_platform_assistant',
    });
    await client.query('ROLLBACK TO SAVEPOINT duplicate_assistant');
    await client.query('RELEASE SAVEPOINT duplicate_assistant');
});
