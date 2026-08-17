'use strict';

const crypto = require('crypto');
const db = require('../db/connection');
const machineCredentials = require('./machineCredentialService');
const templates = require('./vapiAgencyAssistantTemplates');
const { createVapiAgencyProviderClient } = require('./vapiAgencyProviderClient');

const ENVIRONMENT = 'prod';
const DEFAULT_CREDENTIAL_TTL_DAYS = 365;
const DEFAULT_ASSISTANT_REQUEST_ROTATION_GRACE_MINUTES = 15;
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
        super(options.message || code, options.cause ? { cause: options.cause } : undefined);
        this.name = 'VapiAgencyProvisioningError';
        this.code = code;
        this.step = options.step || null;
        this.details = options.details || null;
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

function credentialExpiry(environment = process.env, now = new Date()) {
    const raw = environment.VAPI_TENANT_CREDENTIAL_TTL_DAYS;
    const days = raw === undefined || raw === ''
        ? DEFAULT_CREDENTIAL_TTL_DAYS
        : Number.parseInt(raw, 10);
    if (!Number.isInteger(days) || days < 30 || days > 730) {
        throw new VapiAgencyProvisioningError('VAPI_AGENCY_CREDENTIAL_TTL_INVALID');
    }
    return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

function assistantRequestRotationGraceMinutes(environment = process.env) {
    const raw = environment.VAPI_ASSISTANT_REQUEST_ROTATION_GRACE_MINUTES;
    const minutes = raw === undefined || raw === ''
        ? DEFAULT_ASSISTANT_REQUEST_ROTATION_GRACE_MINUTES
        : Number.parseInt(raw, 10);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 60) {
        throw new VapiAgencyProvisioningError('VAPI_AGENCY_CREDENTIAL_GRACE_INVALID');
    }
    return minutes;
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
    return {
        endpoints: {
            toolsUrl: `${origin}/api/vapi-tools`,
            callStatusUrl: `${origin}/api/vapi/call-status`,
            assistantRequestUrl: `${origin}/api/vapi/call-status/assistant-request`,
        },
        sipHost: environment.VAPI_SIP_HOST || 'sip.vapi.ai',
    };
}

function generatePreviewSecrets() {
    return templates.validateSecrets({
        tools: crypto.randomBytes(36).toString('base64url'),
        callStatus: crypto.randomBytes(36).toString('base64url'),
        assistantRequest: crypto.randomBytes(36).toString('base64url'),
    });
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

async function acquireCompanyProvisioningLock(client, companyId) {
    await client.query(
        `SELECT pg_advisory_lock(hashtextextended('vapi-agency-provisioning:' || $1, 0))`,
        [companyId],
    );
}

async function releaseCompanyProvisioningLock(client, companyId) {
    await client.query(
        `SELECT pg_advisory_unlock(hashtextextended('vapi-agency-provisioning:' || $1, 0))`,
        [companyId],
    );
}

async function resolveTemplateVariables(client, { company, greeting }) {
    const previous = await client.query(
        `SELECT state, template_variables, last_successful_template_variables
         FROM vapi_tenant_provisioning_runs
         WHERE company_id = $1
           AND environment = $2`,
        [company.id, ENVIRONMENT],
    );
    const run = previous.rows[0] || null;
    const durable = run?.last_successful_template_variables
        && Object.keys(run.last_successful_template_variables).length > 0
        ? run.last_successful_template_variables
        : (run?.state === 'ready' ? run.template_variables : {});
    const candidate = { companyName: company.name };
    if (greeting !== undefined) candidate.greeting = greeting;
    else if (durable?.greeting !== undefined) candidate.greeting = durable.greeting;
    return templates.normalizeTenantVariables(candidate);
}

function buildInputHash({ variables, runtime }) {
    return templates.hashCanonical({
        templateBundleVersion: templates.BUNDLE_VERSION,
        variables,
        endpoints: runtime.endpoints,
        sipHost: runtime.sipHost,
    });
}

async function inspectDryRun(client, {
    company,
    variables,
    runtime,
    provider,
    adoptExisting = false,
}) {
    const existing = await client.query(
        `SELECT *
         FROM vapi_tenant_provisioning_runs
         WHERE company_id = $1
           AND environment = $2`,
        [company.id, ENVIRONMENT],
    );
    const operationKey = existing.rows[0]?.operation_key || `dry-run-${company.id}`;
    // Dry-run renders the exact provider shape with ephemeral values, but never
    // persists or returns them. Apply creates a fresh credential per company.
    const secrets = generatePreviewSecrets();
    const rendered = templates.renderBundle({
        companyId: company.id,
        operationKey,
        variables,
        endpoints: runtime.endpoints,
        secrets,
    });
    const sip = templates.buildSipResource({
        companyId: company.id,
        companyName: variables.companyName,
        sipHost: runtime.sipHost,
        endpoints: runtime.endpoints,
        secrets,
    });
    const [listed, profiles, listedPhones, localResources] = await Promise.all([
        provider.listAssistants(),
        client.query(
            `SELECT purpose, vapi_assistant_id
             FROM vapi_assistant_profiles
             WHERE company_id = $1
               AND environment = $2
               AND purpose = ANY($3::text[])`,
            [company.id, ENVIRONMENT, rendered.map(({ purpose }) => purpose)],
        ),
        provider.listPhoneNumbers(),
        client.query(
            `SELECT vapi_phone_number_id
             FROM vapi_tenant_resources
             WHERE company_id = $1
               AND environment = $2
               AND purpose = 'inbound_call'`,
            [company.id, ENVIRONMENT],
        ),
    ]);
    const run = existing.rows[0] || {
        company_id: company.id,
        operation_key: operationKey,
        provider_assistant_ids: {},
    };
    const assistantChanges = [];
    for (const entry of rendered) {
        const candidates = assistantDiscoveryIds({
            listed,
            run,
            localProfiles: profiles.rows,
            rendered: entry,
        });
        if (candidates.length > 1) {
            throw new VapiAgencyProvisioningError(
                'VAPI_AGENCY_ASSISTANT_DISCOVERY_AMBIGUOUS',
                { step: `assistant:${entry.purpose}:discover` },
            );
        }
        if (candidates.length === 0) {
            assistantChanges.push({
                purpose: entry.purpose,
                assistant_id: null,
                action: 'create',
                differing_fields: [],
            });
            continue;
        }
        const assistantId = candidates[0];
        const readback = await provider.getAssistant(assistantId);
        const differingFields = templates.assistantReadbackDifferences(readback, entry);
        const sameIncompleteOperation = (
            existing.rows[0]
            && existing.rows[0].state !== 'ready'
            && listed.some((assistant) => (
                assistant.id === assistantId
                && assistant.metadata?.albustoProvisioningKey === operationKey
                && assistant.metadata?.albustoCompanyId === company.id
                && assistant.metadata?.albustoPurpose === entry.purpose
                && assistant.metadata?.albustoEnvironment === ENVIRONMENT
            ))
        );
        let action;
        if (adoptExisting) action = 'adopt_existing';
        else if (sameIncompleteOperation) action = 'repair_existing';
        else if (existing.rows[0]?.state === 'ready' && differingFields.length === 0) {
            action = 'verify_existing';
        } else action = 'adopt_required';
        assistantChanges.push({
            purpose: entry.purpose,
            assistant_id: assistantId,
            action,
            differing_fields: differingFields,
        });
    }
    const resourceCandidates = resourceDiscoveryIds({
        listed: listedPhones,
        run,
        localResources: localResources.rows,
        expectedSipUri: sip.sipUri,
    });
    if (resourceCandidates.length > 1) {
        throw new VapiAgencyProvisioningError(
            'VAPI_AGENCY_RESOURCE_DISCOVERY_AMBIGUOUS',
            { step: 'resource:discover' },
        );
    }
    let resourceChange = {
        resource_id: null,
        action: 'create',
        differing_fields: [],
    };
    if (resourceCandidates.length === 1) {
        const providerResourceId = resourceCandidates[0];
        const readback = await provider.getPhoneNumber(providerResourceId);
        const differingFields = templates.sipResourceReadbackDifferences(readback, sip);
        let action;
        if (adoptExisting) action = 'adopt_existing';
        else if (
            existing.rows[0]
            && existing.rows[0].state !== 'ready'
            && existing.rows[0].provider_resource_id === providerResourceId
        ) action = 'repair_existing';
        else if (existing.rows[0]?.state === 'ready' && differingFields.length === 0) {
            action = 'verify_existing';
        } else action = 'adopt_required';
        resourceChange = {
            resource_id: providerResourceId,
            action,
            differing_fields: differingFields,
        };
    }
    return {
        mode: 'dry-run',
        company_id: company.id,
        environment: ENVIRONMENT,
        template_bundle_version: templates.BUNDLE_VERSION,
        purposes: rendered.map((entry) => entry.purpose),
        sip_uri: sip.sipUri,
        existing_state: existing.rows[0]?.state || null,
        assistant_changes: assistantChanges,
        resource_change: resourceChange,
        requires_adopt_existing: (
            assistantChanges.some(({ action }) => action === 'adopt_required')
            || resourceChange.action === 'adopt_required'
        ),
        writes: false,
        provider_calls: true,
    };
}

async function readyRegistryProjection(client, companyId) {
    const [run, profiles, resource] = await Promise.all([
        client.query(
            `SELECT id, state, provider_resource_id, sip_uri
             FROM vapi_tenant_provisioning_runs
             WHERE company_id = $1
               AND environment = $2`,
            [companyId, ENVIRONMENT],
        ),
        client.query(
            `SELECT id, purpose
             FROM vapi_assistant_profiles
             WHERE company_id = $1
               AND environment = $2
               AND purpose = ANY($3::text[])
               AND status = 'active'
               AND is_active = true`,
            [companyId, ENVIRONMENT, templates.PURPOSES.map(({ purpose }) => purpose)],
        ),
        client.query(
            `SELECT id
             FROM vapi_tenant_resources
             WHERE company_id = $1
               AND environment = $2
               AND purpose = 'inbound_call'
               AND status = 'active'
               AND is_active = true`,
            [companyId, ENVIRONMENT],
        ),
    ]);
    if (
        run.rows.length !== 1
        || run.rows[0].state !== 'ready'
        || profiles.rows.length !== templates.PURPOSES.length
        || resource.rows.length !== 1
    ) return null;
    const profileIds = Object.fromEntries(profiles.rows.map((row) => [row.purpose, row.id]));
    if (templates.PURPOSES.some(({ purpose }) => !profileIds[purpose])) return null;
    return {
        mode: 'apply',
        company_id: companyId,
        environment: ENVIRONMENT,
        state: 'ready',
        run_id: run.rows[0].id,
        template_bundle_version: templates.BUNDLE_VERSION,
        profile_ids: profileIds,
        resource_id: resource.rows[0].id,
        provider_resource_id: run.rows[0].provider_resource_id,
        sip_uri: run.rows[0].sip_uri,
        no_op: true,
    };
}

async function beginRun(client, { company, variables, inputHash }, options = {}) {
    const manageTransaction = options.manageTransaction !== false;
    if (manageTransaction) await client.query('BEGIN');
    try {
        const previousVoiceConfig = await client.query(
            `SELECT rollout_state
             FROM vapi_tenant_voice_configs
             WHERE company_id = $1
               AND environment = $2
             FOR UPDATE`,
            [company.id, ENVIRONMENT],
        );
        const currentRolloutState = previousVoiceConfig.rows[0]?.rollout_state || null;
        let previousRolloutState = currentRolloutState;
        if (currentRolloutState === 'provisioning') {
            const priorRun = await client.query(
                `SELECT previous_rollout_state
                 FROM vapi_tenant_provisioning_runs
                 WHERE company_id = $1
                   AND environment = $2
                 FOR UPDATE`,
                [company.id, ENVIRONMENT],
            );
            previousRolloutState = priorRun.rows[0]?.previous_rollout_state || null;
        }
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
                 template_variables, previous_rollout_state,
                 state, current_step, attempt_count, started_at
             ) VALUES (
                 $1, $2, $3, $4, $5::jsonb, $6,
                 'planning', 'planning', 1, now()
             )
             ON CONFLICT (company_id, environment) DO UPDATE
             SET template_bundle_version = EXCLUDED.template_bundle_version,
                 input_hash = EXCLUDED.input_hash,
                 template_variables = EXCLUDED.template_variables,
                 previous_rollout_state = EXCLUDED.previous_rollout_state,
                 last_successful_template_variables = CASE
                     WHEN vapi_tenant_provisioning_runs.state = 'ready'
                      AND vapi_tenant_provisioning_runs.last_successful_template_variables = '{}'::jsonb
                         THEN vapi_tenant_provisioning_runs.template_variables
                     ELSE vapi_tenant_provisioning_runs.last_successful_template_variables
                 END,
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
                previousRolloutState,
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

async function provisionCredentials(client, { companyId, runId }, options = {}) {
    const manageTransaction = options.manageTransaction !== false;
    if (manageTransaction) await client.query('BEGIN');
    try {
        const ids = {};
        const secrets = {};
        for (const definition of CREDENTIALS) {
            const result = await machineCredentials.provisionCredential({
                companyId,
                surface: definition.surface,
                scopes: [definition.scope],
                secret: null,
                expiresAt: credentialExpiry(options.environment || process.env),
                client,
            });
            if (!result.created || typeof result.secret !== 'string') {
                throw new VapiAgencyProvisioningError(
                    'VAPI_AGENCY_FRESH_CREDENTIAL_SECRET_REQUIRED',
                    { step: 'credentials' },
                );
            }
            ids[definition.key] = String(result.id);
            secrets[definition.key] = result.secret;
        }
        if (
            new Set(Object.values(ids)).size !== CREDENTIALS.length
            || new Set(Object.values(secrets)).size !== CREDENTIALS.length
        ) {
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
        return {
            run: requireExactlyOne(
                updated.rows,
                'VAPI_AGENCY_CREDENTIAL_STATE_WRITE_FAILED',
            ),
            secrets,
        };
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
    adoptExisting = false,
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
        const createdNow = !assistantId;
        let repairableExisting = false;
        if (!assistantId) {
            const created = await provider.createAssistant(rendered.config);
            assistantId = created.id;
        } else {
            repairableExisting = listed.some((assistant) => (
                assistant.id === assistantId
                && assistant.metadata?.albustoProvisioningKey === currentRun.operation_key
                && assistant.metadata?.albustoCompanyId === companyId
                && assistant.metadata?.albustoPurpose === rendered.purpose
                && assistant.metadata?.albustoEnvironment === ENVIRONMENT
            ));
            const currentReadback = await provider.getAssistant(assistantId);
            const differingFields = templates.assistantReadbackDifferences(
                currentReadback,
                rendered,
            );
            if (differingFields.length > 0 && !adoptExisting && !repairableExisting) {
                throw new VapiAgencyProvisioningError(
                    'VAPI_AGENCY_EXISTING_ASSISTANT_DRIFT',
                    {
                        step: `assistant:${rendered.purpose}:compare`,
                        details: {
                            purpose: rendered.purpose,
                            assistantId,
                            differingFields,
                        },
                        message: `Existing assistant ${rendered.purpose} differs at: ${differingFields.join(', ')}`,
                    },
                );
            }
            if (!adoptExisting && !repairableExisting) {
                throw new VapiAgencyProvisioningError(
                    'VAPI_AGENCY_EXISTING_ASSISTANT_ADOPTION_REQUIRED',
                    {
                        step: `assistant:${rendered.purpose}:compare`,
                        details: {
                            purpose: rendered.purpose,
                            assistantId,
                            differingFields,
                        },
                    },
                );
            }
        }
        currentRun = await recordAssistantId(client, {
            runId: run.id,
            companyId,
            purpose: rendered.purpose,
            assistantId,
        });
        // Existing objects are patched only with explicit adoption, except an object
        // carrying this exact durable operation marker after a partial provider success.
        // That narrow repair exception is required because its write-only secret cannot
        // be recovered after the previous process died.
        if (!createdNow && (adoptExisting || repairableExisting)) {
            await provider.updateAssistant(assistantId, rendered.config);
        }
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
    // Rotation order is local-before-provider. Only the credential pinned on the
    // call session or one explicitly listed in this bounded overlap is accepted;
    // arbitrary active same-company credentials are never authority.
    const localAcceptance = await client.query(
        `SELECT id
         FROM api_integrations
         WHERE id = $1
           AND company_id = $2
           AND machine_surface = 'vapi_assistant_request'
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > now())
           AND scopes ? 'vapi_assistant_request:invoke'`,
        [currentRun.assistant_request_credential_id, companyId],
    );
    if (localAcceptance.rows.length !== 1) {
        throw new VapiAgencyProvisioningError(
            'VAPI_AGENCY_ASSISTANT_REQUEST_OVERLAP_NOT_READY',
            { step: 'resource:credential-overlap' },
        );
    }
    const previousCredential = await client.query(
        `SELECT server_credential_id
         FROM vapi_tenant_resources
         WHERE company_id = $1
           AND environment = $2
           AND purpose = 'inbound_call'
         LIMIT 1`,
        [companyId, ENVIRONMENT],
    );
    const previousCredentialId = previousCredential.rows[0]?.server_credential_id || null;
    if (previousCredentialId && String(previousCredentialId) !== String(currentRun.assistant_request_credential_id)) {
        await client.query(
            `INSERT INTO vapi_company_credential_acceptance (
                 company_id, environment, machine_surface, credential_id,
                 acceptance_state, expires_at
             ) VALUES ($1, $2, 'vapi_assistant_request', $3, 'current', NULL)
             ON CONFLICT (company_id, environment, machine_surface, credential_id)
             DO NOTHING`,
            [companyId, ENVIRONMENT, previousCredentialId],
        );
    }
    await client.query(
        `INSERT INTO vapi_company_credential_acceptance (
             company_id, environment, machine_surface, credential_id,
             acceptance_state, expires_at
         ) VALUES ($1, $2, 'vapi_assistant_request', $3, 'rotating', NULL)
         ON CONFLICT (company_id, environment, machine_surface, credential_id)
         DO UPDATE SET acceptance_state = 'rotating',
                       expires_at = NULL,
                       accepted_at = now()`,
        [companyId, ENVIRONMENT, currentRun.assistant_request_credential_id],
    );
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
                 assistant_profile_id, server_credential_id,
                 fallback_vapi_assistant_id, status,
                 resource_type, config_hash, provider_updated_at, last_verified_at
             ) VALUES (
                 $1, $2, $3, $4, $5,
                 $6, $7, $8,
                 NULL, true, 'inbound_call',
                 $9, $10, $11, 'active',
                 'sip_destination', $12, $13, now()
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
                 fallback_vapi_assistant_id = EXCLUDED.fallback_vapi_assistant_id,
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
                locked.provider_assistant_ids?.inbound_call,
                locked.resource_readback_hash,
                locked.resource_provider_updated_at,
            ],
        );

        const graceMinutes = assistantRequestRotationGraceMinutes(
            options.environment || process.env,
        );
        await client.query(
            `UPDATE vapi_company_credential_acceptance
             SET acceptance_state = 'retiring',
                 expires_at = now() + ($4 * interval '1 minute')
             WHERE company_id = $1
               AND environment = $2
               AND machine_surface = 'vapi_assistant_request'
               AND credential_id <> $3
               AND acceptance_state IN ('current', 'rotating')`,
            [company.id, ENVIRONMENT, credentialIds.assistantRequest, graceMinutes],
        );
        await client.query(
            `INSERT INTO vapi_company_credential_acceptance (
                 company_id, environment, machine_surface, credential_id,
                 acceptance_state, expires_at
             ) VALUES ($1, $2, 'vapi_assistant_request', $3, 'current', NULL)
             ON CONFLICT (company_id, environment, machine_surface, credential_id)
             DO UPDATE SET acceptance_state = 'current',
                           expires_at = NULL,
                           accepted_at = now()`,
            [company.id, ENVIRONMENT, credentialIds.assistantRequest],
        );

        for (const definition of CREDENTIALS) {
            if (definition.surface === machineCredentials.SURFACES.VAPI_ASSISTANT_REQUEST) {
                await client.query(
                    `UPDATE api_integrations
                     SET expires_at = LEAST(
                             COALESCE(expires_at, now() + ($4 * interval '1 minute')),
                             now() + ($4 * interval '1 minute')
                         ),
                         updated_at = now()
                     WHERE company_id = $1
                       AND machine_surface = $2
                       AND id <> $3
                       AND revoked_at IS NULL`,
                    [company.id, definition.surface, credentialIds[definition.key], graceMinutes],
                );
                continue;
            }
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
                 last_successful_template_variables = template_variables,
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
    const failed = await client.query(
        `UPDATE vapi_tenant_provisioning_runs
         SET state = 'failed',
             current_step = $1,
             last_error_code = $2,
             last_error_step = $1,
             updated_at = now()
         WHERE id = $3
           AND company_id = $4
         RETURNING previous_rollout_state`,
        [step || 'unknown', safeErrorCode(error), runId, companyId],
    );
    if (failed.rows.length !== 1) return;
    const previousRolloutState = failed.rows[0].previous_rollout_state;
    if (previousRolloutState) {
        await client.query(
            `UPDATE vapi_tenant_voice_configs
             SET rollout_state = $1,
                 updated_at = now()
             WHERE company_id = $2
               AND environment = $3
               AND rollout_state = 'provisioning'`,
            [previousRolloutState, companyId, ENVIRONMENT],
        );
    } else {
        await client.query(
            `DELETE FROM vapi_tenant_voice_configs
             WHERE company_id = $1
               AND environment = $2
               AND rollout_state = 'provisioning'`,
            [companyId, ENVIRONMENT],
        );
    }
}

async function provisionCompany({
    companyId,
    greeting,
    apply = false,
    adoptExisting = false,
}, dependencies = {}) {
    const runtime = resolveRuntimeConfig(dependencies.environment || process.env);
    const externalClient = dependencies.client || null;
    const client = externalClient || await (dependencies.db || db).getClient();
    const manageTransaction = dependencies.manageTransactions !== false;
    let runId = null;
    let step = 'planning';
    let lockAcquired = false;
    let unlockFailed = false;
    try {
        if (apply) {
            await acquireCompanyProvisioningLock(client, companyId);
            lockAcquired = true;
        }
        const company = await loadCompany(client, companyId);
        const variables = await resolveTemplateVariables(client, {
            company,
            greeting,
        });
        const provider = dependencies.provider || createVapiAgencyProviderClient({
            apiKeyProvider: () => (dependencies.environment || process.env).VAPI_API_KEY,
            ...(dependencies.providerClientOptions || {}),
        });
        const inspection = await inspectDryRun(client, {
            company,
            variables,
            runtime,
            provider,
            adoptExisting,
        });
        if (!apply) return inspection;
        if (inspection.requires_adopt_existing) {
            const differingFields = [
                ...inspection.assistant_changes.flatMap((entry) => (
                    entry.differing_fields.map((field) => `${entry.purpose}:${field}`)
                )),
                ...inspection.resource_change.differing_fields.map((field) => (
                    `inbound_resource:${field}`
                )),
            ];
            const hasProviderDrift = differingFields.length > 0;
            throw new VapiAgencyProvisioningError(
                hasProviderDrift
                    ? 'VAPI_AGENCY_EXISTING_ASSISTANT_DRIFT'
                    : 'VAPI_AGENCY_EXISTING_PROVIDER_ADOPTION_REQUIRED',
                {
                    step: 'preflight:provider-drift',
                    details: { differingFields },
                    message: hasProviderDrift
                        ? `Existing provider configuration differs at: ${differingFields.join(', ')}`
                        : 'Existing provider objects require --adopt-existing because write-only secrets cannot be verified',
                },
            );
        }
        if (inspection.existing_state === 'ready' && !adoptExisting) {
            const allProviderObjectsMatch = (
                inspection.assistant_changes.every(({ action }) => action === 'verify_existing')
                && inspection.resource_change.action === 'verify_existing'
            );
            const projection = allProviderObjectsMatch
                ? await readyRegistryProjection(client, company.id)
                : null;
            if (projection) return projection;
            throw new VapiAgencyProvisioningError(
                'VAPI_AGENCY_READY_REPAIR_REQUIRES_ADOPTION',
                { step: 'preflight:ready-repair' },
            );
        }

        const inputHash = buildInputHash({ variables, runtime });
        const initialized = await beginRun(
            client,
            { company, variables, inputHash },
            { manageTransaction },
        );
        let run = initialized.run;
        runId = run.id;
        step = 'credentials';
        const credentialState = await provisionCredentials(client, {
            companyId: company.id,
            runId,
        }, {
            manageTransaction,
            environment: dependencies.environment || process.env,
        });
        run = credentialState.run;

        const renderedBundle = templates.renderBundle({
            companyId: company.id,
            operationKey: run.operation_key,
            variables,
            endpoints: runtime.endpoints,
            secrets: credentialState.secrets,
        });
        const expectedSip = templates.buildSipResource({
            companyId: company.id,
            companyName: variables.companyName,
            sipHost: runtime.sipHost,
            endpoints: runtime.endpoints,
            secrets: credentialState.secrets,
        });

        step = 'assistants';
        run = await provisionAssistants(client, {
            provider,
            companyId: company.id,
            run,
            renderedBundle,
            adoptExisting,
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
        }, {
            manageTransaction,
            environment: dependencies.environment || process.env,
        });
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
        throw new VapiAgencyProvisioningError(
            'VAPI_AGENCY_PROVISIONING_FAILED',
            { step, cause: error },
        );
    } finally {
        if (lockAcquired) {
            await releaseCompanyProvisioningLock(client, companyId).catch((error) => {
                unlockFailed = true;
                console.error('[vapiAgencyProvisioning] advisory unlock failed:', error.message);
            });
        }
        if (!externalClient) client.release(unlockFailed);
    }
}

module.exports = {
    ENVIRONMENT,
    CREDENTIALS,
    VapiAgencyProvisioningError,
    resolveRuntimeConfig,
    buildInputHash,
    credentialExpiry,
    assistantRequestRotationGraceMinutes,
    loadCompany,
    resolveTemplateVariables,
    acquireCompanyProvisioningLock,
    releaseCompanyProvisioningLock,
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
