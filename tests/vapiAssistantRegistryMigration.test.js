'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const identity = require('../backend/src/services/vapiCallIdentityService');

const ABC = '00000000-0000-0000-0000-000000000001';
const FORWARD = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '273_vapi_assistant_registry.sql'),
    'utf8',
);
const ROLLBACK = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', 'rollback_273_vapi_assistant_registry.sql'),
    'utf8',
);
const RETIRE_MARKETPLACE_APP = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '274_retire_tenant_vapi_marketplace_app.sql'),
    'utf8',
);
const ASSISTANTS = Object.freeze({
    inbound: '30e85a87-9d7e-4694-828e-1fea7d10f3ef',
    lead: 'ef874329-1111-4111-8111-111111111111',
    parts: 'c1e2831b-e91f-46a9-86d8-6b40252bd29a',
});

let pool;
let client;

async function seedCredential(surface, scope, suffix) {
    const result = await client.query(
        `INSERT INTO api_integrations (
             client_name, key_id, secret_hash, scopes, company_id, machine_surface
         ) VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         RETURNING id`,
        [
            `Registry ${surface}`,
            `registry-${surface}-${suffix}`,
            `registry-hash-${surface}-${suffix}`,
            JSON.stringify([scope]),
            ABC,
            surface,
        ],
    );
    return String(result.rows[0].id);
}

async function prepareAbc() {
    await client.query(
        `INSERT INTO companies (id, name, slug, status)
         VALUES ($1, 'ABC registry migration', 'abc-registry-migration', 'active')
         ON CONFLICT (id) DO UPDATE SET status = 'active'`,
        [ABC],
    );
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

    await seedCredential('vapi_tools', 'vapi_tools:invoke', 'tools');
    await seedCredential('vapi_call_status', 'vapi_call_status:invoke', 'status');
    await seedCredential(
        'vapi_assistant_request',
        'vapi_assistant_request:invoke',
        'assistant-request',
    );
    await client.query(
        `SELECT set_config('app.vapi_inbound_assistant_id', $1, true),
                set_config('app.vapi_lead_assistant_id', $2, true),
                set_config('app.vapi_parts_assistant_id', $3, true)`,
        [ASSISTANTS.inbound, ASSISTANTS.lead, ASSISTANTS.parts],
    );
}

beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
    await client.query('BEGIN');
    await prepareAbc();
});

afterAll(async () => {
    if (client) {
        await client.query('ROLLBACK');
        client.release();
    }
    if (pool) await pool.end();
});

test('migration derives all ABC purposes, binds the SIP tuple, and is repeatable', async () => {
    await expect(client.query(FORWARD)).resolves.toBeDefined();
    await expect(client.query(FORWARD)).resolves.toBeDefined();
    await expect(client.query(RETIRE_MARKETPLACE_APP)).resolves.toBeDefined();

    const profiles = await client.query(
        `SELECT purpose, environment, vapi_assistant_id, provider_account_key,
                status, base_config_json, tools_credential_id, call_status_credential_id
         FROM vapi_assistant_profiles
         WHERE company_id = $1
         ORDER BY purpose`,
        [ABC],
    );
    expect(profiles.rows).toEqual([
        expect.objectContaining({
            purpose: 'inbound_call',
            vapi_assistant_id: ASSISTANTS.inbound,
            provider_account_key: 'vapi:platform',
            status: 'active',
            base_config_json: null,
        }),
        expect.objectContaining({
            purpose: 'outbound_lead_call',
            vapi_assistant_id: ASSISTANTS.lead,
            provider_account_key: 'vapi:platform',
            status: 'active',
            base_config_json: null,
        }),
        expect.objectContaining({
            purpose: 'outbound_parts_call',
            vapi_assistant_id: ASSISTANTS.parts,
            provider_account_key: 'vapi:platform',
            status: 'active',
            base_config_json: null,
        }),
    ]);
    expect(profiles.rows.every((row) => (
        row.environment === 'prod'
        && row.tools_credential_id != null
        && row.call_status_credential_id != null
    ))).toBe(true);

    const resource = await client.query(
        `SELECT resource.purpose, resource.status, resource.assistant_profile_id,
                resource.server_credential_id, resource.assistant_request_secret,
                connection.encrypted_credentials_json
         FROM vapi_tenant_resources resource
         JOIN provider_connections connection
           ON connection.id = resource.provider_connection_id
          AND connection.company_id = resource.company_id
         WHERE resource.company_id = $1`,
        [ABC],
    );
    expect(resource.rows).toEqual([expect.objectContaining({
        purpose: 'inbound_call',
        status: 'active',
        assistant_profile_id: 'vapi_profile_abc_inbound_prod',
        assistant_request_secret: null,
        encrypted_credentials_json: null,
    })]);
    expect(resource.rows[0].server_credential_id).not.toBeNull();

    const legacyApp = await client.query(
        `SELECT status, metadata->'assistant'->>'what_it_does' AS assistant_description
         FROM marketplace_apps
         WHERE app_key = 'vapi-ai'`,
    );
    expect(legacyApp.rows).toEqual([expect.objectContaining({
        status: 'disabled',
        assistant_description: expect.stringContaining('not a tenant-installable app'),
    })]);
});

test('retired tenant/provider configuration cannot be written back', async () => {
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

    await client.query('SAVEPOINT retired_provider_key');
    await expect(client.query(
        `UPDATE provider_connections
         SET encrypted_credentials_json = '{"api_key":"tenant-key"}'
         WHERE company_id = $1 AND provider = 'vapi'`,
        [ABC],
    )).rejects.toMatchObject({
        code: '23514',
        constraint: 'chk_vapi_connection_platform_key_only',
    });
    await client.query('ROLLBACK TO SAVEPOINT retired_provider_key');
    await client.query('RELEASE SAVEPOINT retired_provider_key');
});

test('ABC inbound reservation succeeds from the migration-populated registry', async () => {
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
    expect(reservation.correlationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await client.query(`DELETE FROM vapi_call_sessions WHERE id = $1`, [reservation.sessionId]);
    await client.query(`DELETE FROM call_flow_executions WHERE id = 'registry-flow-execution'`);
});

test('global assistant id uniqueness cannot fragment by company connection data', async () => {
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

test('missing first-run assistant evidence aborts instead of skipping bootstrap', async () => {
    await client.query(ROLLBACK);
    await client.query(
        `SELECT set_config('app.vapi_inbound_assistant_id', '', true),
                set_config('app.vapi_lead_assistant_id', '', true),
                set_config('app.vapi_parts_assistant_id', '', true)`,
    );
    await client.query('SAVEPOINT missing_assistant_ids');
    await expect(client.query(FORWARD)).rejects.toThrow(
        /VAPI_AGENCY_273_ASSISTANT_IDS_REQUIRED/,
    );
    await client.query('ROLLBACK TO SAVEPOINT missing_assistant_ids');
    await client.query('RELEASE SAVEPOINT missing_assistant_ids');

    await client.query(
        `SELECT set_config('app.vapi_inbound_assistant_id', $1, true),
                set_config('app.vapi_lead_assistant_id', $2, true),
                set_config('app.vapi_parts_assistant_id', $3, true)`,
        [ASSISTANTS.inbound, ASSISTANTS.lead, ASSISTANTS.parts],
    );
    await expect(client.query(FORWARD)).resolves.toBeDefined();
});
