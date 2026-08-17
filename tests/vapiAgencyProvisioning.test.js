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
const CONCURRENT_COMPANY = '40000000-0000-4000-8000-000000000009';
const readMigration = (name) => fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', name),
    'utf8',
);
const PREREQUISITE_MIGRATIONS = [
    readMigration('275_vapi_assistant_registry.sql'),
    readMigration('277_vapi_outbound_registry_sessions.sql'),
];
const MIGRATION = readMigration('278_vapi_agency_provisioning_state.sql');
const RECOVERY_MIGRATION = readMigration('280_vapi_agency_provisioning_recovery.sql');
const ENVIRONMENT = Object.freeze({
    VAPI_API_KEY: 'platform-key-never-logged',
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
            const id = providerId(options.assistantIdPrefix || 'assistant', assistantSequence);
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
            const id = providerId(options.phoneIdPrefix || 'phone', phoneSequence);
            phones.set(id, clone(config));
            return phoneReadback(id, config);
        },
        async updatePhoneNumber(id, config) {
            calls.updatePhoneNumber += 1;
            if (!phones.has(id)) throw new Error('phone missing');
            if (options.beforeUpdatePhone) await options.beforeUpdatePhone({ id, config });
            phones.set(id, clone(config));
            return phoneReadback(id, config);
        },
        async getPhoneNumber(id) {
            calls.getPhoneNumber += 1;
            return phoneReadback(id, phones.get(id));
        },
    };
}

function providerSecretsForCompany(provider, companyId) {
    const assistants = [...provider.assistants.values()].filter((config) => (
        config.metadata?.albustoCompanyId === companyId
    ));
    expect(assistants).toHaveLength(3);
    const tools = new Set(assistants.flatMap((config) => (
        config.model.tools.map((tool) => tool.server.secret)
    )));
    const callStatus = new Set(assistants.map((config) => config.server.secret));
    const phone = [...provider.phones.values()].find((config) => (
        config.sipUri.includes(companyId.replaceAll('-', ''))
    ));
    expect(tools.size).toBe(1);
    expect(callStatus.size).toBe(1);
    expect(phone).toBeDefined();
    return {
        tools: [...tools][0],
        callStatus: [...callStatus][0],
        assistantRequest: phone.server.secret,
    };
}

let pool;
let client;

async function cleanCompanyWithQuery(query, companyId) {
    await query(`DELETE FROM vapi_call_sessions WHERE company_id = $1`, [companyId]);
    await query(`DELETE FROM vapi_company_credential_acceptance WHERE company_id = $1`, [companyId]);
    await query(`DELETE FROM vapi_tenant_resources WHERE company_id = $1`, [companyId]);
    await query(`DELETE FROM vapi_assistant_profiles WHERE company_id = $1`, [companyId]);
    await query(`DELETE FROM vapi_tenant_provisioning_runs WHERE company_id = $1`, [companyId]);
    await query(`DELETE FROM vapi_tenant_voice_configs WHERE company_id = $1`, [companyId]);
    await query(
        `DELETE FROM provider_connections WHERE company_id = $1 AND provider = 'vapi'`,
        [companyId],
    );
    await query(
        `DELETE FROM api_integrations
         WHERE company_id = $1
           AND machine_surface IN ('vapi_tools', 'vapi_call_status', 'vapi_assistant_request')`,
        [companyId],
    );
    await query(`DELETE FROM companies WHERE id = $1`, [companyId]);
}

async function cleanCompany(companyId) {
    return cleanCompanyWithQuery(client.query.bind(client), companyId);
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
    for (const migration of PREREQUISITE_MIGRATIONS) await pool.query(migration);
    await pool.query(MIGRATION);
    await pool.query(MIGRATION);
    await pool.query(RECOVERY_MIGRATION);
    await pool.query(RECOVERY_MIGRATION);
    await cleanCompanyWithQuery(pool.query.bind(pool), CONCURRENT_COMPANY);
    client = await pool.connect();
    await client.query('BEGIN');
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
    for (const migration of [MIGRATION, RECOVERY_MIGRATION]) {
        expect(migration).not.toMatch(/^(?:INSERT|UPDATE|DELETE)\b/im);
        expect(migration).not.toContain('current_setting');
        expect(migration).not.toContain('RAISE EXCEPTION');
        expect(migration).not.toContain('VAPI_API_KEY');
    }
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
        provider_calls: true,
        purposes: ['inbound_call', 'outbound_lead_call', 'outbound_parts_call'],
    });
    expect(provider.calls.listAssistants).toBe(1);
    expect(provider.calls.createAssistant).toBe(0);
    expect(provider.calls.updateAssistant).toBe(0);
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
             (SELECT rollout_state FROM vapi_tenant_voice_configs WHERE company_id = $1) AS rollout_state,
             (SELECT fallback_vapi_assistant_id FROM vapi_tenant_resources
              WHERE company_id = $1 AND purpose = 'inbound_call') AS fallback_assistant_id`,
        [COMPANY],
    );
    expect(state.rows[0]).toEqual({
        profiles: 3,
        resources: 1,
        credentials: 3,
        run_state: 'ready',
        rollout_state: 'ready',
        fallback_assistant_id: expect.any(String),
    });

    const inbound = provider.assistants.get(
        [...provider.assistants.keys()].find((id) => (
            provider.assistants.get(id).metadata.albustoPurpose === 'inbound_call'
        )),
    );
    expect(inbound.firstMessage).toBe('Thanks for calling Agency Repair. How can I help?');
    expect(inbound.server.url).toBe('https://provisioning.example.test/api/vapi/call-status');
    const secrets = providerSecretsForCompany(provider, COMPANY);
    expect(new Set(Object.values(secrets)).size).toBe(3);
    expect(inbound.model.tools.every((tool) => (
        tool.server.url === 'https://provisioning.example.test/api/vapi-tools'
        && tool.server.secret === secrets.tools
    ))).toBe(true);
    for (const secret of Object.values(secrets)) {
        expect(logs.join('\n')).not.toContain(secret);
    }
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

test('failed apply restores the prior rollout state instead of leaving provisioning', async () => {
    const provider = createFakeProvider({ assistantSecretFlag: false });
    await client.query(
        `INSERT INTO vapi_tenant_voice_configs (
             company_id, environment, rollout_state, readiness_evidence
         ) VALUES ($1, 'prod', 'enabled', '{}'::jsonb)`,
        [COMPANY],
    );

    await expect(runApply(provider)).rejects.toMatchObject({
        code: 'VAPI_AGENCY_ASSISTANT_SERVER_SECRET_UNSET',
    });

    const state = await client.query(
        `SELECT rollout_state
         FROM vapi_tenant_voice_configs
         WHERE company_id = $1 AND environment = 'prod'`,
        [COMPANY],
    );
    expect(state.rows).toEqual([{ rollout_state: 'enabled' }]);
});

test('FIX-22 repeated begin while already provisioning preserves the original rollout state', async () => {
    await client.query(
        `INSERT INTO vapi_tenant_voice_configs (
             company_id, environment, rollout_state, readiness_evidence
         ) VALUES ($1, 'prod', 'enabled', '{}'::jsonb)`,
        [COMPANY],
    );
    const company = await provisioning.loadCompany(client, COMPANY);
    const variables = templates.normalizeTenantVariables({ companyName: company.name });
    const first = await provisioning.beginRun(client, {
        company,
        variables,
        inputHash: 'first-interrupted-run',
    }, { manageTransaction: false });
    expect(first.run.previous_rollout_state).toBe('enabled');

    const second = await provisioning.beginRun(client, {
        company,
        variables,
        inputHash: 'second-repair-run',
    }, { manageTransaction: false });
    expect(second.run.previous_rollout_state).toBe('enabled');
    await provisioning.recordFailure(client, {
        runId: second.run.id,
        companyId: COMPANY,
        step: 'assistants',
        error: Object.assign(new Error('provider down'), { code: 'PROVIDER_DOWN' }),
    });

    const state = await client.query(
        `SELECT rollout_state
         FROM vapi_tenant_voice_configs
         WHERE company_id = $1 AND environment = 'prod'`,
        [COMPANY],
    );
    expect(state.rows).toEqual([{ rollout_state: 'enabled' }]);
});

test('existing assistant drift requires explicit adoption and dry-run reports field paths', async () => {
    const provider = createFakeProvider();
    await runApply(provider);
    const assistantId = [...provider.assistants.keys()][0];
    provider.assistants.get(assistantId).model.model = 'human-edited-model';
    const updatesBefore = provider.calls.updateAssistant;

    const dryRun = await provisioning.provisionCompany({
        companyId: COMPANY,
        apply: false,
    }, {
        client,
        provider,
        environment: ENVIRONMENT,
        manageTransactions: false,
    });
    expect(dryRun.requires_adopt_existing).toBe(true);
    expect(dryRun.assistant_changes).toEqual(expect.arrayContaining([
        expect.objectContaining({
            assistant_id: assistantId,
            action: 'adopt_required',
            differing_fields: expect.arrayContaining(['$.model.model']),
        }),
    ]));
    expect(provider.calls.updateAssistant).toBe(updatesBefore);

    await expect(runApply(provider, { greeting: undefined })).rejects.toMatchObject({
        code: 'VAPI_AGENCY_EXISTING_ASSISTANT_DRIFT',
        details: expect.objectContaining({
            differingFields: expect.arrayContaining(['inbound_call:$.model.model']),
        }),
    });
    expect(provider.calls.updateAssistant).toBe(updatesBefore);
    expect(provider.assistants.get(assistantId).model.model).toBe('human-edited-model');

    await expect(runApply(provider, {
        greeting: undefined,
        adoptExisting: true,
    })).resolves.toMatchObject({ state: 'ready' });
    expect(provider.assistants.get(assistantId).model.model).not.toBe('human-edited-model');
    expect(provider.calls.updateAssistant).toBeGreaterThan(updatesBefore);
});

test('repeat apply without greeting inherits the last successful greeting', async () => {
    const provider = createFakeProvider();
    await runApply(provider, { greeting: 'A durable custom greeting' });

    await runApply(provider, { greeting: undefined });

    const inbound = [...provider.assistants.values()].find((config) => (
        config.metadata.albustoPurpose === 'inbound_call'
    ));
    expect(inbound.firstMessage).toBe('A durable custom greeting');
    const run = await client.query(
        `SELECT template_variables, last_successful_template_variables
         FROM vapi_tenant_provisioning_runs
         WHERE company_id = $1`,
        [COMPANY],
    );
    expect(run.rows[0].template_variables.greeting).toBe('A durable custom greeting');
    expect(run.rows[0].last_successful_template_variables.greeting)
        .toBe('A durable custom greeting');
});

test('credential rotation is accepted locally before provider update and old credential retires last', async () => {
    const provider = createFakeProvider();
    await runApply(provider);
    let overlapSnapshot = null;
    const observingProvider = createFakeProvider({
        beforeUpdatePhone: async () => {
            overlapSnapshot = (await client.query(
                `SELECT
                     COUNT(*) FILTER (WHERE revoked_at IS NULL)::int AS active_credentials,
                     COUNT(*) FILTER (
                         WHERE id = (
                             SELECT assistant_request_credential_id
                             FROM vapi_tenant_provisioning_runs
                             WHERE company_id = $1
                         ) AND revoked_at IS NULL
                     )::int AS new_credential_active,
                     (SELECT acceptance_state
                      FROM vapi_company_credential_acceptance acceptance
                      WHERE acceptance.company_id = $1
                        AND acceptance.credential_id = (
                            SELECT assistant_request_credential_id
                            FROM vapi_tenant_provisioning_runs
                            WHERE company_id = $1
                        )) AS new_acceptance_state
                 FROM api_integrations
                 WHERE company_id = $1
                   AND machine_surface = 'vapi_assistant_request'`,
                [COMPANY],
            )).rows[0];
        },
    });
    observingProvider.assistants.clear();
    observingProvider.phones.clear();
    for (const [id, config] of provider.assistants) {
        observingProvider.assistants.set(id, clone(config));
    }
    for (const [id, config] of provider.phones) {
        observingProvider.phones.set(id, clone(config));
    }

    await runApply(observingProvider, {
        greeting: undefined,
        adoptExisting: true,
    });

    expect(overlapSnapshot).toEqual({
        active_credentials: 2,
        new_credential_active: 1,
        new_acceptance_state: 'rotating',
    });
    const final = await client.query(
        `SELECT acceptance.acceptance_state,
                acceptance.expires_at,
                credential.revoked_at,
                credential.expires_at AS credential_expires_at
         FROM vapi_company_credential_acceptance acceptance
         JOIN api_integrations credential
           ON credential.id = acceptance.credential_id
          AND credential.company_id = acceptance.company_id
         WHERE acceptance.company_id = $1
         ORDER BY acceptance.acceptance_state`,
        [COMPANY],
    );
    expect(final.rows).toEqual([
        expect.objectContaining({
            acceptance_state: 'current',
            expires_at: null,
            revoked_at: null,
            credential_expires_at: expect.any(Date),
        }),
        expect.objectContaining({
            acceptance_state: 'retiring',
            expires_at: expect.any(Date),
            revoked_at: null,
            credential_expires_at: expect.any(Date),
        }),
    ]);
    expect(final.rows[1].expires_at.getTime()).toBeLessThanOrEqual(
        final.rows[1].credential_expires_at.getTime() + 1000,
    );
});

test('two concurrent apply operations serialize by company and cannot create duplicate assistants', async () => {
    const provider = createFakeProvider({
        assistantIdPrefix: 'concurrent-assistant',
        phoneIdPrefix: 'concurrent-phone',
    });
    const query = pool.query.bind(pool);
    const cleanup = () => cleanCompanyWithQuery(query, CONCURRENT_COMPANY);
    await cleanup();
    await query(
        `INSERT INTO companies (id, name, slug, status)
         VALUES ($1, 'Concurrent Voice Co', 'concurrent-voice-co', 'active')`,
        [CONCURRENT_COMPANY],
    );
    try {
        const dependencies = {
            db: { getClient: () => pool.connect() },
            provider,
            environment: ENVIRONMENT,
        };
        const input = {
            companyId: CONCURRENT_COMPANY,
            greeting: 'One company, one assistant set',
            apply: true,
        };

        const results = await Promise.all([
            provisioning.provisionCompany(input, dependencies),
            provisioning.provisionCompany(input, dependencies),
        ]);

        expect(results.every(({ state }) => state === 'ready')).toBe(true);
        expect(provider.calls.createAssistant).toBe(3);
        expect(provider.calls.createPhoneNumber).toBe(1);
        expect(provider.assistants.size).toBe(3);
        expect(provider.phones.size).toBe(1);
    } finally {
        await cleanup();
    }
}, 30000);

test('assistant write-only server secret is verified only by flag and readable tool secrets by value', async () => {
    const provider = createFakeProvider();
    await expect(runApply(provider)).resolves.toMatchObject({ state: 'ready' });
    const assistantId = [...provider.assistants.keys()][0];
    const readback = await provider.getAssistant(assistantId);
    const secrets = providerSecretsForCompany(provider, COMPANY);
    expect(readback.server.secret).toBeUndefined();
    expect(readback.isServerUrlSecretSet).toBe(true);
    expect(readback.model.tools[0].server.secret).toBe(secrets.tools);

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
    const secrets = providerSecretsForCompany(provider, COMPANY);
    for (const secret of Object.values(secrets)) {
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

test('SAB-FIX3: two companies receive distinct machine credentials and both reach ready', async () => {
    const provider = createFakeProvider();
    const first = await runApply(provider);
    const second = await runApply(provider, {
        companyId: FOREIGN_COMPANY,
        greeting: 'Thanks for calling Agency Repair B. How can I help?',
    });
    expect(first).toMatchObject({ company_id: COMPANY, state: 'ready' });
    expect(second).toMatchObject({ company_id: FOREIGN_COMPANY, state: 'ready' });
    expect(provider.assistants.size).toBe(6);
    expect(provider.phones.size).toBe(2);

    const firstSecrets = providerSecretsForCompany(provider, COMPANY);
    const secondSecrets = providerSecretsForCompany(provider, FOREIGN_COMPANY);
    expect(new Set([
        ...Object.values(firstSecrets),
        ...Object.values(secondSecrets),
    ]).size).toBe(6);

    const active = await client.query(
        `SELECT company_id, COUNT(*)::int AS count,
                COUNT(DISTINCT secret_hash)::int AS distinct_hashes
         FROM api_integrations
         WHERE company_id = ANY($1::uuid[])
           AND machine_surface IN (
               'vapi_tools', 'vapi_call_status', 'vapi_assistant_request'
           )
           AND revoked_at IS NULL
         GROUP BY company_id
         ORDER BY company_id`,
        [[COMPANY, FOREIGN_COMPANY]],
    );
    expect(active.rows).toEqual([
        { company_id: COMPANY, count: 3, distinct_hashes: 3 },
        { company_id: FOREIGN_COMPANY, count: 3, distinct_hashes: 3 },
    ]);
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
        adoptExisting: false,
    }, expect.objectContaining({ environment: ENVIRONMENT }));
    expect(log).toHaveBeenCalledWith(expect.not.stringContaining('secret-'));

    expect(cli.parseArgs([
        '--company-id', COMPANY,
        '--apply',
        '--adopt-existing',
    ])).toEqual({
        companyId: COMPANY,
        apply: true,
        adoptExisting: true,
    });
});
