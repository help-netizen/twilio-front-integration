'use strict';

process.env.BLANC_SERVER_PEPPER = 'vapi-agency-provisioning-test-pepper';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const cli = require('../backend/scripts/provision-vapi-agency-company');
const provisioning = require('../backend/src/services/vapiAgencyProvisioningService');
const templates = require('../backend/src/services/vapiAgencyAssistantTemplates');

const COMPANY = '40000000-0000-4000-8000-000000000007';
const FOREIGN_COMPANY = '40000000-0000-4000-8000-000000000008';
const readMigration = (name) => fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', name),
    'utf8',
);
const PREREQUISITE_MIGRATIONS = [
    readMigration('275_vapi_assistant_registry.sql'),
    readMigration('277_vapi_outbound_registry_sessions.sql'),
];
const MIGRATION = readMigration('278_vapi_agency_provisioning_state.sql');
const ENVIRONMENT = Object.freeze({
    VAPI_API_KEY: 'platform-key-never-logged',
    VAPI_TENANT_TOOLS_SECRET: 'tools-secret-'.padEnd(48, 't'),
    VAPI_TENANT_CALL_STATUS_SECRET: 'status-secret-'.padEnd(48, 's'),
    VAPI_TENANT_ASSISTANT_REQUEST_SECRET: 'request-secret-'.padEnd(48, 'r'),
    WEBHOOK_BASE_URL: 'https://provisioning.example.test',
    VAPI_SIP_HOST: 'sip.vapi.ai',
});

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function providerId(prefix, sequence) {
    return `${prefix}-${String(sequence).padStart(8, '0')}`;
}

function createFakeProvider(options = {}) {
    const assistants = new Map();
    const phones = new Map();
    let assistantSequence = 0;
    let phoneSequence = 0;
    let loseCreateResponse = Boolean(options.loseFirstAssistantResponse);
    const calls = {
        listAssistants: 0,
        createAssistant: 0,
        updateAssistant: 0,
        getAssistant: 0,
        listPhoneNumbers: 0,
        createPhoneNumber: 0,
        updatePhoneNumber: 0,
        getPhoneNumber: 0,
    };

    function assistantReadback(id, config) {
        const value = clone(config);
        delete value.server.secret;
        return {
            ...value,
            id,
            orgId: 'platform-org-not-persisted',
            createdAt: '2026-08-17T12:00:00.000Z',
            updatedAt: '2026-08-17T12:01:00.000Z',
            isServerUrlSecretSet: options.assistantSecretFlag !== false,
        };
    }

    function phoneReadback(id, config) {
        const value = clone(config);
        delete value.server.secret;
        return {
            ...value,
            id,
            orgId: 'platform-org-not-persisted',
            createdAt: '2026-08-17T12:00:00.000Z',
            updatedAt: '2026-08-17T12:02:00.000Z',
            isServerUrlSecretSet: options.phoneSecretFlag !== false,
        };
    }

    return {
        calls,
        assistants,
        phones,
        setAssistantSecretFlag(value) {
            options.assistantSecretFlag = value;
        },
        async listAssistants() {
            calls.listAssistants += 1;
            return [...assistants.entries()].map(([id, config]) => ({
                id,
                metadata: clone(config.metadata),
            }));
        },
        async createAssistant(config) {
            calls.createAssistant += 1;
            assistantSequence += 1;
            const id = providerId('assistant', assistantSequence);
            assistants.set(id, clone(config));
            if (loseCreateResponse) {
                loseCreateResponse = false;
                const error = new Error('simulated lost response');
                error.name = 'VapiAgencyProviderError';
                error.code = 'VAPI_AGENCY_PROVIDER_REQUEST_FAILED';
                throw error;
            }
            return assistantReadback(id, config);
        },
        async updateAssistant(id, config) {
            calls.updateAssistant += 1;
            if (!assistants.has(id)) throw new Error('assistant missing');
            assistants.set(id, clone(config));
            return assistantReadback(id, config);
        },
        async getAssistant(id) {
            calls.getAssistant += 1;
            return assistantReadback(id, assistants.get(id));
        },
        async listPhoneNumbers() {
            calls.listPhoneNumbers += 1;
            return [...phones.entries()].map(([id, config]) => ({ id, sipUri: config.sipUri }));
        },
        async createPhoneNumber(config) {
            calls.createPhoneNumber += 1;
            phoneSequence += 1;
            const id = providerId('phone', phoneSequence);
            phones.set(id, clone(config));
            return phoneReadback(id, config);
        },
        async updatePhoneNumber(id, config) {
            calls.updatePhoneNumber += 1;
            if (!phones.has(id)) throw new Error('phone missing');
            phones.set(id, clone(config));
            return phoneReadback(id, config);
        },
        async getPhoneNumber(id) {
            calls.getPhoneNumber += 1;
            return phoneReadback(id, phones.get(id));
        },
    };
}

let pool;
let client;

async function cleanCompany(companyId) {
    await client.query(`DELETE FROM vapi_call_sessions WHERE company_id = $1`, [companyId]);
    await client.query(`DELETE FROM vapi_tenant_resources WHERE company_id = $1`, [companyId]);
    await client.query(`DELETE FROM vapi_assistant_profiles WHERE company_id = $1`, [companyId]);
    await client.query(`DELETE FROM vapi_tenant_provisioning_runs WHERE company_id = $1`, [companyId]);
    await client.query(`DELETE FROM vapi_tenant_voice_configs WHERE company_id = $1`, [companyId]);
    await client.query(
        `DELETE FROM provider_connections WHERE company_id = $1 AND provider = 'vapi'`,
        [companyId],
    );
    await client.query(
        `DELETE FROM api_integrations
         WHERE company_id = $1
           AND machine_surface IN ('vapi_tools', 'vapi_call_status', 'vapi_assistant_request')`,
        [companyId],
    );
    await client.query(`DELETE FROM companies WHERE id = $1`, [companyId]);
}

async function seedCompany(companyId, suffix) {
    await client.query(
        `INSERT INTO companies (id, name, slug, status)
         VALUES ($1, $2, $3, 'active')`,
        [companyId, `Agency Repair ${suffix}`, `agency-repair-${suffix}`],
    );
}

async function runApply(provider, overrides = {}) {
    return provisioning.provisionCompany({
        companyId: COMPANY,
        greeting: 'Thanks for calling Agency Repair. How can I help?',
        apply: true,
        ...overrides,
    }, {
        client,
        provider,
        environment: ENVIRONMENT,
        manageTransactions: false,
    });
}

beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
    await client.query('BEGIN');
    for (const migration of PREREQUISITE_MIGRATIONS) await client.query(migration);
    await client.query(MIGRATION);
    await client.query(MIGRATION);
});

beforeEach(async () => {
    await cleanCompany(COMPANY);
    await cleanCompany(FOREIGN_COMPANY);
    await seedCompany(COMPANY, 'a');
    await seedCompany(FOREIGN_COMPANY, 'b');
});

afterAll(async () => {
    if (client) {
        await cleanCompany(COMPANY).catch(() => {});
        await cleanCompany(FOREIGN_COMPANY).catch(() => {});
        await client.query('ROLLBACK').catch(() => {});
        client.release();
    }
    if (pool) await pool.end();
    delete process.env.BLANC_SERVER_PEPPER;
});

test('migration is data-neutral and repeatable', () => {
    expect(MIGRATION).not.toMatch(/^(?:INSERT|UPDATE|DELETE)\b/im);
    expect(MIGRATION).not.toContain('current_setting');
    expect(MIGRATION).not.toContain('RAISE EXCEPTION');
    expect(MIGRATION).not.toContain('VAPI_API_KEY');
});

test('dry-run performs no local or provider writes', async () => {
    const provider = createFakeProvider();
    const result = await provisioning.provisionCompany({
        companyId: COMPANY,
        greeting: 'Thanks for calling Agency Repair. How can I help?',
        apply: false,
    }, {
        client,
        provider,
        environment: ENVIRONMENT,
        manageTransactions: false,
    });
    expect(result).toMatchObject({
        mode: 'dry-run',
        company_id: COMPANY,
        writes: false,
        provider_calls: false,
        purposes: ['inbound_call', 'outbound_lead_call', 'outbound_parts_call'],
    });
    expect(Object.values(provider.calls).every((count) => count === 0)).toBe(true);
    const counts = await client.query(
        `SELECT
             (SELECT COUNT(*)::int FROM vapi_tenant_provisioning_runs WHERE company_id = $1) AS runs,
             (SELECT COUNT(*)::int FROM provider_connections WHERE company_id = $1 AND provider = 'vapi') AS connections,
             (SELECT COUNT(*)::int FROM api_integrations WHERE company_id = $1 AND machine_surface LIKE 'vapi_%') AS credentials`,
        [COMPANY],
    );
    expect(counts.rows[0]).toEqual({ runs: 0, connections: 0, credentials: 0 });
});

test('SAB-T7-IDEMPOTENCE: second apply repairs in place without provider or registry duplicates', async () => {
    const provider = createFakeProvider();
    const logs = [];
    const first = await runApply(provider);
    const second = await runApply(provider);
    expect(first).toMatchObject({ mode: 'apply', state: 'ready', company_id: COMPANY });
    expect(second).toMatchObject({
        state: 'ready',
        run_id: first.run_id,
        profile_ids: first.profile_ids,
        provider_resource_id: first.provider_resource_id,
    });
    expect(provider.calls.createAssistant).toBe(3);
    expect(provider.calls.createPhoneNumber).toBe(1);
    expect(provider.assistants.size).toBe(3);
    expect(provider.phones.size).toBe(1);

    const state = await client.query(
        `SELECT
             (SELECT COUNT(*)::int FROM vapi_assistant_profiles WHERE company_id = $1) AS profiles,
             (SELECT COUNT(*)::int FROM vapi_tenant_resources WHERE company_id = $1 AND purpose = 'inbound_call') AS resources,
             (SELECT COUNT(*)::int FROM api_integrations WHERE company_id = $1 AND machine_surface LIKE 'vapi_%' AND revoked_at IS NULL) AS credentials,
             (SELECT state FROM vapi_tenant_provisioning_runs WHERE company_id = $1) AS run_state,
             (SELECT rollout_state FROM vapi_tenant_voice_configs WHERE company_id = $1) AS rollout_state`,
        [COMPANY],
    );
    expect(state.rows[0]).toEqual({
        profiles: 3,
        resources: 1,
        credentials: 3,
        run_state: 'ready',
        rollout_state: 'ready',
    });

    const inbound = provider.assistants.get(
        [...provider.assistants.keys()].find((id) => (
            provider.assistants.get(id).metadata.albustoPurpose === 'inbound_call'
        )),
    );
    expect(inbound.firstMessage).toBe('Thanks for calling Agency Repair. How can I help?');
    expect(inbound.server.url).toBe('https://provisioning.example.test/api/vapi/call-status');
    expect(inbound.model.tools.every((tool) => (
        tool.server.url === 'https://provisioning.example.test/api/vapi-tools'
        && tool.server.secret === ENVIRONMENT.VAPI_TENANT_TOOLS_SECRET
    ))).toBe(true);
    expect(logs.join('\n')).not.toContain(ENVIRONMENT.VAPI_TENANT_TOOLS_SECRET);
});

test('lost response after provider assistant creation is visible and retry discovers the object', async () => {
    const provider = createFakeProvider({ loseFirstAssistantResponse: true });
    await expect(runApply(provider)).rejects.toMatchObject({
        code: 'VAPI_AGENCY_PROVIDER_REQUEST_FAILED',
    });
    const failed = await client.query(
        `SELECT state, current_step, last_error_code, provider_assistant_ids
         FROM vapi_tenant_provisioning_runs
         WHERE company_id = $1`,
        [COMPANY],
    );
    expect(failed.rows[0]).toMatchObject({
        state: 'failed',
        current_step: 'assistants',
        last_error_code: 'VAPI_AGENCY_PROVIDER_REQUEST_FAILED',
        provider_assistant_ids: {},
    });
    expect(provider.assistants.size).toBe(1);

    await expect(runApply(provider)).resolves.toMatchObject({ state: 'ready' });
    expect(provider.calls.createAssistant).toBe(3);
    expect(provider.assistants.size).toBe(3);
});

test('assistant write-only server secret is verified only by flag and readable tool secrets by value', async () => {
    const provider = createFakeProvider();
    await expect(runApply(provider)).resolves.toMatchObject({ state: 'ready' });
    const assistantId = [...provider.assistants.keys()][0];
    const readback = await provider.getAssistant(assistantId);
    expect(readback.server.secret).toBeUndefined();
    expect(readback.isServerUrlSecretSet).toBe(true);
    expect(readback.model.tools[0].server.secret).toBe(ENVIRONMENT.VAPI_TENANT_TOOLS_SECRET);

    const badProvider = createFakeProvider({ assistantSecretFlag: false });
    await cleanCompany(COMPANY);
    await seedCompany(COMPANY, 'a');
    await expect(runApply(badProvider)).rejects.toMatchObject({
        code: 'VAPI_AGENCY_ASSISTANT_SERVER_SECRET_UNSET',
    });
    const failed = await client.query(
        `SELECT state FROM vapi_tenant_provisioning_runs WHERE company_id = $1`,
        [COMPANY],
    );
    expect(failed.rows[0].state).toBe('failed');
});

test('plaintext credentials are absent from local database projections', async () => {
    const provider = createFakeProvider();
    await runApply(provider);
    const secrets = [
        ENVIRONMENT.VAPI_TENANT_TOOLS_SECRET,
        ENVIRONMENT.VAPI_TENANT_CALL_STATUS_SECRET,
        ENVIRONMENT.VAPI_TENANT_ASSISTANT_REQUEST_SECRET,
    ];
    for (const secret of secrets) {
        const result = await client.query(
            `SELECT EXISTS (
                 SELECT 1 FROM api_integrations
                 WHERE company_id = $1 AND to_jsonb(api_integrations)::text LIKE '%' || $2 || '%'
                 UNION ALL
                 SELECT 1 FROM vapi_tenant_provisioning_runs
                 WHERE company_id = $1 AND to_jsonb(vapi_tenant_provisioning_runs)::text LIKE '%' || $2 || '%'
                 UNION ALL
                 SELECT 1 FROM vapi_assistant_profiles
                 WHERE company_id = $1 AND to_jsonb(vapi_assistant_profiles)::text LIKE '%' || $2 || '%'
                 UNION ALL
                 SELECT 1 FROM vapi_tenant_resources
                 WHERE company_id = $1 AND to_jsonb(vapi_tenant_resources)::text LIKE '%' || $2 || '%'
             ) AS leaked`,
            [COMPANY, secret],
        );
        expect(result.rows[0].leaked).toBe(false);
    }
});

test('SAB-T7-ALLOWLIST: tenant provider overrides are rejected before any operation', async () => {
    for (const argument of ['--prompt', '--model', '--webhook-url', '--assistant-id', '--sip-uri']) {
        expect(() => cli.parseArgs(['--company-id', COMPANY, argument, 'foreign']))
            .toThrow(expect.objectContaining({ code: 'VAPI_AGENCY_CLI_ARGUMENT_FORBIDDEN' }));
    }
    expect(() => templates.normalizeTenantVariables({
        companyName: 'Agency Repair',
        greeting: 'Hello',
        model: 'foreign-model',
    })).toThrow(expect.objectContaining({ code: 'VAPI_AGENCY_TENANT_VARIABLE_FORBIDDEN' }));
});

test('company ownership remains local even when provider list contains a foreign marker', async () => {
    const provider = createFakeProvider();
    provider.assistants.set('assistant-foreign01', {
        name: 'Foreign',
        metadata: {
            albustoProvisioningKey: crypto.randomUUID(),
            albustoCompanyId: FOREIGN_COMPANY,
            albustoPurpose: 'inbound_call',
            albustoEnvironment: 'prod',
        },
    });
    await runApply(provider);
    expect(provider.calls.createAssistant).toBe(3);
    const rows = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM vapi_assistant_profiles
         WHERE company_id = $1
           AND vapi_assistant_id = 'assistant-foreign01'`,
        [COMPANY],
    );
    expect(rows.rows[0].count).toBe(0);
});

test('CLI dry-run is default and forwards only the allowlisted greeting', async () => {
    const provisionCompany = jest.fn().mockResolvedValue({ mode: 'dry-run', writes: false });
    const log = jest.fn();
    await cli.run([
        '--company-id', COMPANY,
        '--greeting', 'Hello from Agency Repair',
    ], { provisionCompany, environment: ENVIRONMENT, log });
    expect(provisionCompany).toHaveBeenCalledWith({
        companyId: COMPANY,
        greeting: 'Hello from Agency Repair',
        apply: false,
    }, expect.objectContaining({ environment: ENVIRONMENT }));
    expect(log).toHaveBeenCalledWith(expect.not.stringContaining('secret-'));
});
