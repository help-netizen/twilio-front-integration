'use strict';

const crypto = require('crypto');
const db = require('../db/connection');
const machineCredentials = require('./machineCredentialService');
const templates = require('./vapiAgencyAssistantTemplates');
const { createVapiAgencyProviderClient } = require('./vapiAgencyProviderClient');

const ENVIRONMENT = 'prod';
const CREDENTIALS = Object.freeze([
    {
        key: 'tools',
        column: 'tools_credential_id',
        surface: machineCredentials.SURFACES.VAPI_TOOLS,
        scope: machineCredentials.ACCESS_SCOPES.VAPI_TOOLS,
    },
    {
        key: 'callStatus',
        column: 'call_status_credential_id',
        surface: machineCredentials.SURFACES.VAPI_CALL_STATUS,
        scope: machineCredentials.ACCESS_SCOPES.VAPI_CALL_STATUS,
    },
    {
        key: 'assistantRequest',
        column: 'assistant_request_credential_id',
        surface: machineCredentials.SURFACES.VAPI_ASSISTANT_REQUEST,
        scope: machineCredentials.ACCESS_SCOPES.VAPI_ASSISTANT_REQUEST,
    },
]);

class VapiAgencyProvisioningError extends Error {
    constructor(code, options = {}) {
        super(code);
        this.name = 'VapiAgencyProvisioningError';
        this.code = code;
        this.step = options.step || null;
    }
}

function requireExactlyOne(rows, code) {
    if (rows.length !== 1) throw new VapiAgencyProvisioningError(code);
    return rows[0];
}

function connectionIdFor(companyId) {
    return `vapi_connection_${companyId.replaceAll('-', '')}_${ENVIRONMENT}`;
}

function profileIdFor(companyId, purpose) {
    return `vapi_profile_${companyId.replaceAll('-', '')}_${purpose}_${ENVIRONMENT}`;
}

function resourceIdFor(companyId) {
    return `vapi_resource_${companyId.replaceAll('-', '')}_inbound_${ENVIRONMENT}`;
}

function safeErrorCode(error) {
    const value = typeof error?.code === 'string' ? error.code : 'VAPI_AGENCY_PROVISIONING_FAILED';
    return /^[A-Z0-9_]{3,120}$/.test(value) ? value : 'VAPI_AGENCY_PROVISIONING_FAILED';
}

function resolveRuntimeConfig(environment = process.env) {
    const baseUrl = environment.WEBHOOK_BASE_URL
        || environment.CALLBACK_HOSTNAME
        || 'https://api.albusto.com';
    let origin;
    try {
        const parsed = new URL(baseUrl);
        if (
            parsed.protocol !== 'https:'
            || parsed.username
            || parsed.password
            || parsed.search
            || parsed.hash
        ) throw new Error('invalid');
        origin = parsed.toString().replace(/\/$/, '');
    } catch (_error) {
        throw new VapiAgencyProvisioningError('VAPI_AGENCY_WEBHOOK_BASE_URL_INVALID');
    }
    const secrets = templates.validateSecrets({
        tools: environment.VAPI_TENANT_TOOLS_SECRET,
        callStatus: environment.VAPI_TENANT_CALL_STATUS_SECRET,
        assistantRequest: environment.VAPI_TENANT_ASSISTANT_REQUEST_SECRET,
    });
    return {
        endpoints: {
            toolsUrl: `${origin}/api/vapi-tools`,
            callStatusUrl: `${origin}/api/vapi/call-status`,
            assistantRequestUrl: `${origin}/api/vapi/call-status/assistant-request`,
        },
        secrets,
        sipHost: environment.VAPI_SIP_HOST || 'sip.vapi.ai',
    };
}

async function loadCompany(client, companyId) {
    const result = await client.query(
        `SELECT id, name, slug
         FROM companies
         WHERE id = $1
           AND status = 'active'`,
        [companyId],
    );
    return requireExactlyOne(result.rows, 'VAPI_AGENCY_COMPANY_REQUIRED');
}

function buildInputHash({ variables, runtime }) {
    return templates.hashCanonical({
        templateBundleVersion: templates.BUNDLE_VERSION,
        variables,
        endpoints: runtime.endpoints,
        sipHost: runtime.sipHost,
    });
}

async function inspectDryRun(client, { company, variables, runtime }) {
    const existing = await client.query(
        `SELECT state, current_step, attempt_count
         FROM vapi_tenant_provisioning_runs
         WHERE company_id = $1
           AND environment = $2`,
        [company.id, ENVIRONMENT],
    );
    const operationKey = `dry-run-${company.id}`;
    const rendered = templates.renderBundle({
        companyId: company.id,
        operationKey,
        variables,
        endpoints: runtime.endpoints,
        secrets: runtime.secrets,
    });
    const sip = templates.buildSipResource({
        companyId: company.id,
        companyName: variables.companyName,
        sipHost: runtime.sipHost,
        endpoints: runtime.endpoints,
        secrets: runtime.secrets,
    });
    return {
        mode: 'dry-run',
        company_id: company.id,
        environment: ENVIRONMENT,
        template_bundle_version: templates.BUNDLE_VERSION,
        purposes: rendered.map((entry) => entry.purpose),
        sip_uri: sip.sipUri,
        existing_state: existing.rows[0]?.state || null,
        writes: false,
        provider_calls: false,
    };
}

async function beginRun(client, { company, variables, inputHash }, options = {}) {
    const manageTransaction = options.manageTransaction !== false;
    if (manageTransaction) await client.query('BEGIN');
    try {
        const connection = await client.query(
            `INSERT INTO provider_connections (
                 id, tenant_id, company_id, provider, environment, status,
                 encrypted_credentials_json, display_name
             ) VALUES ($1, $2, $3, 'vapi', $4, 'active', NULL, $5)
             ON CONFLICT (company_id, provider, environment) DO UPDATE
             SET tenant_id = EXCLUDED.tenant_id,
                 status = 'active',
                 encrypted_credentials_json = NULL,
                 display_name = EXCLUDED.display_name,
                 updated_at = now()
             RETURNING id, tenant_id, company_id`,
            [
                connectionIdFor(company.id),
                company.slug,
                company.id,
                ENVIRONMENT,
                `${company.name} voice execution`,
            ],
        );
        await client.query(
            `INSERT INTO vapi_tenant_voice_configs (
                 company_id, environment, rollout_state, readiness_evidence
             ) VALUES ($1, $2, 'provisioning', '{}'::jsonb)
             ON CONFLICT (company_id, environment) DO UPDATE
             SET rollout_state = CASE
                     WHEN vapi_tenant_voice_configs.rollout_state = 'suspended'
                         THEN 'suspended'
                     ELSE 'provisioning'
                 END,
                 updated_at = now()`,
            [company.id, ENVIRONMENT],
        );
        const run = await client.query(
            `INSERT INTO vapi_tenant_provisioning_runs (
                 company_id, environment, template_bundle_version, input_hash,
                 template_variables, state, current_step, attempt_count, started_at
             ) VALUES (
                 $1, $2, $3, $4, $5::jsonb, 'planning', 'planning', 1, now()
             )
             ON CONFLICT (company_id, environment) DO UPDATE
             SET template_bundle_version = EXCLUDED.template_bundle_version,
                 input_hash = EXCLUDED.input_hash,
                 template_variables = EXCLUDED.template_variables,
                 state = 'planning',
                 current_step = 'planning',
                 last_error_code = NULL,
                 last_error_step = NULL,
                 attempt_count = vapi_tenant_provisioning_runs.attempt_count + 1,
                 started_at = now(),
                 completed_at = NULL,
                 updated_at = now()
             RETURNING *`,
            [
                company.id,
                ENVIRONMENT,
                templates.BUNDLE_VERSION,
                inputHash,
                JSON.stringify(variables),
            ],
        );
        if (manageTransaction) await client.query('COMMIT');
        return {
            connection: requireExactlyOne(
                connection.rows,
                'VAPI_AGENCY_CONNECTION_WRITE_FAILED',
            ),
            run: requireExactlyOne(run.rows, 'VAPI_AGENCY_RUN_WRITE_FAILED'),
        };
    } catch (error) {
        if (manageTransaction) await client.query('ROLLBACK').catch(() => {});
        throw error;
    }
}

async function provisionCredentials(client, { companyId, runId, secrets }, options = {}) {
    const manageTransaction = options.manageTransaction !== false;
    if (manageTransaction) await client.query('BEGIN');
    try {
        const ids = {};
        for (const definition of CREDENTIALS) {
            const result = await machineCredentials.provisionCredential({
                companyId,
                surface: definition.surface,
                scopes: [definition.scope],
                secret: secrets[definition.key],
                client,
            });
            ids[definition.key] = String(result.id);
        }
        if (new Set(Object.values(ids)).size !== CREDENTIALS.length) {
            throw new VapiAgencyProvisioningError('VAPI_AGENCY_CREDENTIAL_IDS_NOT_DISTINCT');
        }
        const updated = await client.query(
            `UPDATE vapi_tenant_provisioning_runs
             SET tools_credential_id = $1,
                 call_status_credential_id = $2,
                 assistant_request_credential_id = $3,
                 state = 'credentials_ready',
                 current_step = 'credentials_ready',
                 updated_at = now()
             WHERE id = $4
               AND company_id = $5
             RETURNING *`,
            [ids.tools, ids.callStatus, ids.assistantRequest, runId, companyId],
        );
        if (manageTransaction) await client.query('COMMIT');
        return requireExactlyOne(updated.rows, 'VAPI_AGENCY_CREDENTIAL_STATE_WRITE_FAILED');
    } catch (error) {
        if (manageTransaction) await client.query('ROLLBACK').catch(() => {});
        throw error;
    }
}

async function updateRunStep(client, { runId, companyId, state, step }) {
    const result = await client.query(
        `UPDATE vapi_tenant_provisioning_runs
         SET state = $1,
             current_step = $2,
             updated_at = now()
         WHERE id = $3
           AND company_id = $4
         RETURNING *`,
        [state, step, runId, companyId],
    );
    return requireExactlyOne(result.rows, 'VAPI_AGENCY_RUN_STEP_WRITE_FAILED');
}

async function recordAssistantId(client, { runId, companyId, purpose, assistantId }) {
    const result = await client.query(
        `UPDATE vapi_tenant_provisioning_runs
         SET provider_assistant_ids = jsonb_set(
                 provider_assistant_ids,
                 ARRAY[$1::text],
                 to_jsonb($2::text),
                 true
             ),
             state = 'assistants_pending',
             current_step = $3,
             updated_at = now()
         WHERE id = $4
           AND company_id = $5
         RETURNING *`,
        [purpose, assistantId, `assistant:${purpose}:created`, runId, companyId],
    );
    return requireExactlyOne(result.rows, 'VAPI_AGENCY_ASSISTANT_ID_WRITE_FAILED');
}

async function recordAssistantReadback(client, {
    runId,
    companyId,
    purpose,
    evidence,
}) {
    const sanitized = {
        id: evidence.id,
        updated_at: evidence.updatedAt,
        template_version: evidence.templateVersion,
        hash: evidence.hash,
    };
    const result = await client.query(
        `UPDATE vapi_tenant_provisioning_runs
         SET assistant_readback_evidence = jsonb_set(
                 assistant_readback_evidence,
                 ARRAY[$1::text],
                 $2::jsonb,
                 true
             ),
             current_step = $3,
             updated_at = now()
         WHERE id = $4
           AND company_id = $5
         RETURNING *`,
        [purpose, JSON.stringify(sanitized), `assistant:${purpose}:verified`, runId, companyId],
    );
    return requireExactlyOne(result.rows, 'VAPI_AGENCY_ASSISTANT_EVIDENCE_WRITE_FAILED');
}

function assistantDiscoveryIds({ listed, run, localProfiles, rendered }) {
    const candidates = new Set();
    const listedIds = new Set(listed.map(({ id }) => id));
    const runId = run.provider_assistant_ids?.[rendered.purpose];
    if (typeof runId === 'string' && listedIds.has(runId)) candidates.add(runId);
    const local = localProfiles.find((row) => row.purpose === rendered.purpose);
    if (typeof local?.vapi_assistant_id === 'string'
        && listedIds.has(local.vapi_assistant_id)) {
        candidates.add(local.vapi_assistant_id);
    }
    for (const assistant of listed) {
        if (
            assistant.metadata?.albustoProvisioningKey === run.operation_key
            && assistant.metadata?.albustoCompanyId === run.company_id
            && assistant.metadata?.albustoPurpose === rendered.purpose
            && assistant.metadata?.albustoEnvironment === ENVIRONMENT
        ) candidates.add(assistant.id);
    }
    return [...candidates];
}

async function provisionAssistants(client, {
    provider,
    companyId,
    run,
    renderedBundle,
}) {
    await updateRunStep(client, {
        runId: run.id,
        companyId,
        state: 'assistants_pending',
        step: 'assistants:discover',
    });
    const listed = await provider.listAssistants();
    const profiles = await client.query(
        `SELECT purpose, vapi_assistant_id
         FROM vapi_assistant_profiles
         WHERE company_id = $1
           AND environment = $2
           AND purpose = ANY($3::text[])`,
        [companyId, ENVIRONMENT, renderedBundle.map(({ purpose }) => purpose)],
    );
    let currentRun = run;
    for (const rendered of renderedBundle) {
        const candidates = assistantDiscoveryIds({
            listed,
            run: currentRun,
            localProfiles: profiles.rows,
            rendered,
        });
        if (candidates.length > 1) {
            throw new VapiAgencyProvisioningError(
                'VAPI_AGENCY_ASSISTANT_DISCOVERY_AMBIGUOUS',
                { step: `assistant:${rendered.purpose}:discover` },
            );
        }
        let assistantId = candidates[0] || null;
        if (!assistantId) {
            const created = await provider.createAssistant(rendered.config);
            assistantId = created.id;
        }
        currentRun = await recordAssistantId(client, {
            runId: run.id,
            companyId,
            purpose: rendered.purpose,
            assistantId,
        });
        await provider.updateAssistant(assistantId, rendered.config);
        const readback = await provider.getAssistant(assistantId);
        const evidence = templates.verifyAssistantReadback(readback, rendered);
        currentRun = await recordAssistantReadback(client, {
            runId: run.id,
            companyId,
            purpose: rendered.purpose,
            evidence,
        });
    }
    return updateRunStep(client, {
        runId: run.id,
        companyId,
        state: 'assistants_ready',
        step: 'assistants:verified',
    });
}

function resourceDiscoveryIds({ listed, run, localResources, expectedSipUri }) {
    const listedIds = new Set(listed.map(({ id }) => id));
    const candidates = new Set();
    if (typeof run.provider_resource_id === 'string'
        && listedIds.has(run.provider_resource_id)) {
        candidates.add(run.provider_resource_id);
    }
    for (const resource of localResources) {
        if (typeof resource.vapi_phone_number_id === 'string'
            && listedIds.has(resource.vapi_phone_number_id)) {
            candidates.add(resource.vapi_phone_number_id);
        }
    }
    for (const phone of listed) {
        if (phone.sipUri === expectedSipUri) candidates.add(phone.id);
    }
    return [...candidates];
}

async function recordResourceId(client, { runId, companyId, providerResourceId, sipUri }) {
    const result = await client.query(
        `UPDATE vapi_tenant_provisioning_runs
         SET provider_resource_id = $1,
             sip_uri = $2,
             state = 'resource_pending',
             current_step = 'resource:created',
             updated_at = now()
         WHERE id = $3
           AND company_id = $4
         RETURNING *`,
        [providerResourceId, sipUri, runId, companyId],
    );
    return requireExactlyOne(result.rows, 'VAPI_AGENCY_RESOURCE_ID_WRITE_FAILED');
}

async function provisionSipResource(client, {
    provider,
    companyId,
    run,
    expected,
}) {
    await updateRunStep(client, {
        runId: run.id,
        companyId,
        state: 'resource_pending',
        step: 'resource:discover',
    });
    const [listed, local] = await Promise.all([
        provider.listPhoneNumbers(),
        client.query(
            `SELECT vapi_phone_number_id
             FROM vapi_tenant_resources
             WHERE company_id = $1
               AND environment = $2
               AND purpose = 'inbound_call'`,
            [companyId, ENVIRONMENT],
        ),
    ]);
    const candidates = resourceDiscoveryIds({
        listed,
        run,
        localResources: local.rows,
        expectedSipUri: expected.sipUri,
    });
    if (candidates.length > 1) {
        throw new VapiAgencyProvisioningError('VAPI_AGENCY_RESOURCE_DISCOVERY_AMBIGUOUS', {
            step: 'resource:discover',
        });
    }
    let providerResourceId = candidates[0] || null;
    if (!providerResourceId) {
        const created = await provider.createPhoneNumber(expected.config);
        providerResourceId = created.id;
    }
    const currentRun = await recordResourceId(client, {
        runId: run.id,
        companyId,
        providerResourceId,
        sipUri: expected.sipUri,
    });
    await provider.updatePhoneNumber(providerResourceId, expected.config);
    const readback = await provider.getPhoneNumber(providerResourceId);
    const evidence = templates.verifySipResourceReadback(readback, expected);
    const result = await client.query(
        `UPDATE vapi_tenant_provisioning_runs
         SET resource_readback_hash = $1,
             resource_provider_updated_at = $2,
             state = 'resource_ready',
             current_step = 'resource:verified',
             updated_at = now()
         WHERE id = $3
           AND company_id = $4
           AND provider_resource_id = $5
         RETURNING *`,
        [evidence.hash, evidence.updatedAt, run.id, companyId, providerResourceId],
    );
    return requireExactlyOne(result.rows, 'VAPI_AGENCY_RESOURCE_EVIDENCE_WRITE_FAILED')
        || currentRun;
}

async function finalizeRegistry(client, {
    company,
    connection,
    run,
    renderedBundle,
    endpoints,
}, options = {}) {
    const manageTransaction = options.manageTransaction !== false;
    if (manageTransaction) await client.query('BEGIN');
    try {
        const locked = requireExactlyOne((await client.query(
            `SELECT *
             FROM vapi_tenant_provisioning_runs
             WHERE id = $1
               AND company_id = $2
             FOR UPDATE`,
            [run.id, company.id],
        )).rows, 'VAPI_AGENCY_RUN_REQUIRED');
        if (
            locked.state !== 'resource_ready'
            || !locked.provider_resource_id
            || !locked.resource_readback_hash
        ) {
            throw new VapiAgencyProvisioningError('VAPI_AGENCY_RESOURCE_NOT_VERIFIED');
        }
        const credentialIds = {
            tools: locked.tools_credential_id,
            callStatus: locked.call_status_credential_id,
            assistantRequest: locked.assistant_request_credential_id,
        };
        if (Object.values(credentialIds).some((id) => !id)) {
            throw new VapiAgencyProvisioningError('VAPI_AGENCY_CREDENTIALS_NOT_READY');
        }

        const profileIds = {};
        for (const rendered of renderedBundle) {
            const assistantId = locked.provider_assistant_ids?.[rendered.purpose];
            const evidence = locked.assistant_readback_evidence?.[rendered.purpose];
            if (!assistantId || !evidence || evidence.id !== assistantId) {
                throw new VapiAgencyProvisioningError('VAPI_AGENCY_ASSISTANT_NOT_VERIFIED');
            }
            const profileId = profileIdFor(company.id, rendered.purpose);
            await client.query(
                `INSERT INTO vapi_assistant_profiles (
                     id, tenant_id, company_id, provider_connection_id, slug,
                     purpose, base_config_json, vapi_assistant_id, version,
                     is_active, environment, provider_account_key, status,
                     template_version, template_hash, tools_credential_id,
                     call_status_credential_id, provider_generation,
                     provider_updated_at, last_verified_at
                 ) VALUES (
                     $1, $2, $3, $4, $5,
                     $6, NULL, $7, $8,
                     true, $9, $10, 'active',
                     $8, $11, $12,
                     $13, $14,
                     $15, now()
                 )
                 ON CONFLICT (company_id, purpose, environment) DO UPDATE
                 SET tenant_id = EXCLUDED.tenant_id,
                     provider_connection_id = EXCLUDED.provider_connection_id,
                     slug = EXCLUDED.slug,
                     base_config_json = NULL,
                     vapi_assistant_id = EXCLUDED.vapi_assistant_id,
                     version = EXCLUDED.version,
                     is_active = true,
                     provider_account_key = EXCLUDED.provider_account_key,
                     status = 'active',
                     template_version = EXCLUDED.template_version,
                     template_hash = EXCLUDED.template_hash,
                     tools_credential_id = EXCLUDED.tools_credential_id,
                     call_status_credential_id = EXCLUDED.call_status_credential_id,
                     provider_generation = EXCLUDED.provider_generation,
                     provider_updated_at = EXCLUDED.provider_updated_at,
                     last_verified_at = now(),
                     updated_at = now()`,
                [
                    profileId,
                    company.slug,
                    company.id,
                    connection.id,
                    rendered.slug,
                    rendered.purpose,
                    assistantId,
                    rendered.version,
                    ENVIRONMENT,
                    templates.PLATFORM_ACCOUNT_KEY,
                    evidence.hash,
                    credentialIds.tools,
                    credentialIds.callStatus,
                    evidence.updated_at,
                    evidence.updated_at,
                ],
            );
            const actual = await client.query(
                `SELECT id
                 FROM vapi_assistant_profiles
                 WHERE company_id = $1
                   AND purpose = $2
                   AND environment = $3`,
                [company.id, rendered.purpose, ENVIRONMENT],
            );
            profileIds[rendered.purpose] = requireExactlyOne(
                actual.rows,
                'VAPI_AGENCY_PROFILE_WRITE_FAILED',
            ).id;
        }

        await client.query(
            `INSERT INTO vapi_tenant_resources (
                 id, tenant_id, company_id, provider_connection_id, environment,
                 vapi_phone_number_id, sip_uri, server_url,
                 assistant_request_secret, is_active, purpose,
                 assistant_profile_id, server_credential_id, status,
                 resource_type, config_hash, provider_updated_at, last_verified_at
             ) VALUES (
                 $1, $2, $3, $4, $5,
                 $6, $7, $8,
                 NULL, true, 'inbound_call',
                 $9, $10, 'active',
                 'sip_destination', $11, $12, now()
             )
             ON CONFLICT (company_id, purpose, environment)
             WHERE company_id IS NOT NULL
             DO UPDATE SET
                 tenant_id = EXCLUDED.tenant_id,
                 provider_connection_id = EXCLUDED.provider_connection_id,
                 vapi_phone_number_id = EXCLUDED.vapi_phone_number_id,
                 sip_uri = EXCLUDED.sip_uri,
                 server_url = EXCLUDED.server_url,
                 assistant_request_secret = NULL,
                 is_active = true,
                 assistant_profile_id = EXCLUDED.assistant_profile_id,
                 server_credential_id = EXCLUDED.server_credential_id,
                 status = 'active',
                 resource_type = 'sip_destination',
                 config_hash = EXCLUDED.config_hash,
                 provider_updated_at = EXCLUDED.provider_updated_at,
                 last_verified_at = now(),
                 updated_at = now()`,
            [
                resourceIdFor(company.id),
                company.slug,
                company.id,
                connection.id,
                ENVIRONMENT,
                locked.provider_resource_id,
                locked.sip_uri,
                endpoints.assistantRequestUrl,
                profileIds.inbound_call,
                credentialIds.assistantRequest,
                locked.resource_readback_hash,
                locked.resource_provider_updated_at,
            ],
        );

        for (const definition of CREDENTIALS) {
            await client.query(
                `UPDATE api_integrations
                 SET revoked_at = now(),
                     updated_at = now()
                 WHERE company_id = $1
                   AND machine_surface = $2
                   AND id <> $3
                   AND revoked_at IS NULL`,
                [company.id, definition.surface, credentialIds[definition.key]],
            );
        }

        const readiness = {
            provisioning: {
                run_id: locked.id,
                template_bundle_version: locked.template_bundle_version,
                assistant_hashes: Object.fromEntries(renderedBundle.map(({ purpose }) => (
                    [purpose, locked.assistant_readback_evidence[purpose].hash]
                ))),
                resource_hash: locked.resource_readback_hash,
                verified_at: new Date().toISOString(),
            },
        };
        await client.query(
            `UPDATE vapi_tenant_voice_configs
             SET rollout_state = CASE
                     WHEN rollout_state = 'suspended' THEN 'suspended'
                     ELSE 'ready'
                 END,
                 readiness_evidence = readiness_evidence || $1::jsonb,
                 verified_at = now(),
                 updated_at = now()
             WHERE company_id = $2
               AND environment = $3`,
            [JSON.stringify(readiness), company.id, ENVIRONMENT],
        );
        const finished = await client.query(
            `UPDATE vapi_tenant_provisioning_runs
             SET state = 'ready',
                 current_step = 'ready',
                 last_error_code = NULL,
                 last_error_step = NULL,
                 verified_at = now(),
                 completed_at = now(),
                 updated_at = now()
             WHERE id = $1
               AND company_id = $2
             RETURNING *`,
            [locked.id, company.id],
        );
        if (manageTransaction) await client.query('COMMIT');
        return {
            run: requireExactlyOne(finished.rows, 'VAPI_AGENCY_FINAL_STATE_WRITE_FAILED'),
            profileIds,
        };
    } catch (error) {
        if (manageTransaction) await client.query('ROLLBACK').catch(() => {});
        throw error;
    }
}

async function recordFailure(client, { runId, companyId, step, error }) {
    if (!runId) return;
    await client.query(
        `UPDATE vapi_tenant_provisioning_runs
         SET state = 'failed',
             current_step = $1,
             last_error_code = $2,
             last_error_step = $1,
             updated_at = now()
         WHERE id = $3
           AND company_id = $4`,
        [step || 'unknown', safeErrorCode(error), runId, companyId],
    );
}

async function provisionCompany({
    companyId,
    greeting = null,
    apply = false,
}, dependencies = {}) {
    const runtime = resolveRuntimeConfig(dependencies.environment || process.env);
    const externalClient = dependencies.client || null;
    const client = externalClient || await (dependencies.db || db).getClient();
    const manageTransaction = dependencies.manageTransactions !== false;
    let runId = null;
    let step = 'planning';
    try {
        const company = await loadCompany(client, companyId);
        const variables = templates.normalizeTenantVariables({
            companyName: company.name,
            ...(greeting ? { greeting } : {}),
        });
        if (!apply) return inspectDryRun(client, { company, variables, runtime });

        const inputHash = buildInputHash({ variables, runtime });
        const initialized = await beginRun(
            client,
            { company, variables, inputHash },
            { manageTransaction },
        );
        let run = initialized.run;
        runId = run.id;
        const renderedBundle = templates.renderBundle({
            companyId: company.id,
            operationKey: run.operation_key,
            variables,
            endpoints: runtime.endpoints,
            secrets: runtime.secrets,
        });
        const expectedSip = templates.buildSipResource({
            companyId: company.id,
            companyName: variables.companyName,
            sipHost: runtime.sipHost,
            endpoints: runtime.endpoints,
            secrets: runtime.secrets,
        });

        step = 'credentials';
        run = await provisionCredentials(client, {
            companyId: company.id,
            runId,
            secrets: runtime.secrets,
        }, { manageTransaction });

        const provider = dependencies.provider || createVapiAgencyProviderClient({
            apiKeyProvider: () => (dependencies.environment || process.env).VAPI_API_KEY,
            ...(dependencies.providerClientOptions || {}),
        });
        step = 'assistants';
        run = await provisionAssistants(client, {
            provider,
            companyId: company.id,
            run,
            renderedBundle,
        });
        step = 'resource';
        run = await provisionSipResource(client, {
            provider,
            companyId: company.id,
            run,
            expected: expectedSip,
        });
        step = 'registry';
        const finalized = await finalizeRegistry(client, {
            company,
            connection: initialized.connection,
            run,
            renderedBundle,
            endpoints: runtime.endpoints,
        }, { manageTransaction });
        return {
            mode: 'apply',
            company_id: company.id,
            environment: ENVIRONMENT,
            state: finalized.run.state,
            run_id: finalized.run.id,
            template_bundle_version: templates.BUNDLE_VERSION,
            profile_ids: finalized.profileIds,
            resource_id: resourceIdFor(company.id),
            provider_resource_id: finalized.run.provider_resource_id,
            sip_uri: finalized.run.sip_uri,
        };
    } catch (error) {
        await recordFailure(client, { runId, companyId, step, error }).catch(() => {});
        if (
            error instanceof VapiAgencyProvisioningError
            || error instanceof templates.VapiAgencyTemplateError
            || error instanceof machineCredentials.MachineCredentialError
            || error?.name === 'VapiAgencyProviderError'
        ) throw error;
        throw new VapiAgencyProvisioningError('VAPI_AGENCY_PROVISIONING_FAILED', { step });
    } finally {
        if (!externalClient) client.release();
    }
}

module.exports = {
    ENVIRONMENT,
    CREDENTIALS,
    VapiAgencyProvisioningError,
    resolveRuntimeConfig,
    buildInputHash,
    loadCompany,
    inspectDryRun,
    beginRun,
    provisionCredentials,
    assistantDiscoveryIds,
    resourceDiscoveryIds,
    provisionAssistants,
    provisionSipResource,
    finalizeRegistry,
    recordFailure,
    provisionCompany,
};
