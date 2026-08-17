#!/usr/bin/env node
'use strict';

const axios = require('axios');
const db = require('../src/db/connection');
const {
    acquireCompanyProvisioningLock,
    releaseCompanyProvisioningLock,
} = require('../src/services/vapiAgencyProvisioningService');

const ENVIRONMENT = 'prod';
const PLATFORM_ACCOUNT_KEY = 'vapi:platform';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PURPOSES = Object.freeze([
    {
        purpose: 'inbound_call',
        slug: 'inbound-qualification',
        envKey: 'VAPI_INBOUND_ASSISTANT_ID',
    },
    {
        purpose: 'outbound_lead_call',
        slug: 'outbound-lead',
        envKey: 'VAPI_LEAD_CALL_ASSISTANT_ID',
    },
    {
        purpose: 'outbound_parts_call',
        slug: 'outbound-parts',
        envKey: 'VAPI_OUTBOUND_ASSISTANT_ID',
    },
]);
const CREDENTIALS = Object.freeze([
    { key: 'vapi_tools', scope: 'vapi_tools:invoke' },
    { key: 'vapi_call_status', scope: 'vapi_call_status:invoke' },
    { key: 'vapi_assistant_request', scope: 'vapi_assistant_request:invoke' },
]);

class VapiRegistryBootstrapError extends Error {
    constructor(code, detail = '') {
        super(detail ? `${code}: ${detail}` : code);
        this.name = 'VapiRegistryBootstrapError';
        this.code = code;
    }
}

function parseArgs(argv) {
    const args = { apply: false, verifyProvider: false };
    let explicitDryRun = false;
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--company-id') {
            args.companyId = argv[index + 1];
            index += 1;
        } else if (token.startsWith('--company-id=')) {
            args.companyId = token.slice('--company-id='.length);
        } else if (token === '--apply') {
            args.apply = true;
        } else if (token === '--dry-run') {
            explicitDryRun = true;
        } else if (token === '--verify-provider') {
            args.verifyProvider = true;
        } else {
            throw new VapiRegistryBootstrapError(
                'VAPI_REGISTRY_BOOTSTRAP_ARGUMENT_UNKNOWN',
                token,
            );
        }
    }
    if (!args.companyId || !UUID_RE.test(args.companyId)) {
        throw new VapiRegistryBootstrapError(
            'VAPI_REGISTRY_BOOTSTRAP_COMPANY_ID_REQUIRED',
            '--company-id must be a UUID',
        );
    }
    if (args.apply && explicitDryRun) {
        throw new VapiRegistryBootstrapError(
            'VAPI_REGISTRY_BOOTSTRAP_MODE_CONFLICT',
            '--apply and --dry-run are mutually exclusive',
        );
    }
    return args;
}

function readAssistantIds(environment) {
    const missing = PURPOSES
        .filter(({ envKey }) => typeof environment[envKey] !== 'string'
            || environment[envKey].trim() === '')
        .map(({ envKey }) => envKey);
    if (missing.length > 0) {
        throw new VapiRegistryBootstrapError(
            'VAPI_REGISTRY_BOOTSTRAP_ASSISTANT_IDS_REQUIRED',
            `missing ${missing.join(', ')}`,
        );
    }

    const assistants = PURPOSES.map((entry) => ({
        ...entry,
        assistantId: environment[entry.envKey].trim(),
    }));
    const invalid = assistants
        .filter(({ assistantId }) => !UUID_RE.test(assistantId))
        .map(({ envKey }) => envKey);
    if (invalid.length > 0) {
        throw new VapiRegistryBootstrapError(
            'VAPI_REGISTRY_BOOTSTRAP_ASSISTANT_ID_INVALID',
            invalid.join(', '),
        );
    }
    if (new Set(assistants.map(({ assistantId }) => assistantId)).size !== assistants.length) {
        throw new VapiRegistryBootstrapError(
            'VAPI_REGISTRY_BOOTSTRAP_ASSISTANT_IDS_NOT_DISTINCT',
        );
    }
    return assistants;
}

async function verifyProviderAssistants(assistants, environment, dependencies = {}) {
    const apiKey = typeof environment.VAPI_API_KEY === 'string'
        ? environment.VAPI_API_KEY.trim()
        : '';
    if (!apiKey) {
        throw new VapiRegistryBootstrapError('VAPI_REGISTRY_BOOTSTRAP_API_KEY_REQUIRED');
    }
    const http = dependencies.http || axios;
    const baseUrl = dependencies.baseUrl || 'https://api.vapi.ai';
    for (const assistant of assistants) {
        let response;
        try {
            response = await http.get(
                `${baseUrl}/assistant/${encodeURIComponent(assistant.assistantId)}`,
                {
                    headers: { Authorization: `Bearer ${apiKey}` },
                    timeout: 15000,
                },
            );
        } catch (_error) {
            throw new VapiRegistryBootstrapError(
                'VAPI_REGISTRY_BOOTSTRAP_PROVIDER_READ_FAILED',
                assistant.envKey,
            );
        }
        if (response?.data?.id !== assistant.assistantId) {
            throw new VapiRegistryBootstrapError(
                'VAPI_REGISTRY_BOOTSTRAP_PROVIDER_ID_MISMATCH',
                assistant.envKey,
            );
        }
    }
}

function requireExactlyOne(rows, code) {
    if (rows.length !== 1) {
        throw new VapiRegistryBootstrapError(code, `found ${rows.length}`);
    }
    return rows[0];
}

async function inspectPlan(client, { companyId, assistants, providerVerified }) {
    const connectionResult = await client.query(
        `SELECT id, tenant_id, company_id, environment
         FROM provider_connections
         WHERE company_id = $1
           AND provider = 'vapi'
           AND environment = $2
           AND status = 'active'
         ORDER BY id`,
        [companyId, ENVIRONMENT],
    );
    const connection = requireExactlyOne(
        connectionResult.rows,
        'VAPI_REGISTRY_BOOTSTRAP_CONNECTION_REQUIRED',
    );

    const resourceResult = await client.query(
        `SELECT id, company_id, provider_connection_id, sip_uri
         FROM vapi_tenant_resources
         WHERE company_id = $1
           AND environment = $2
           AND is_active = true
           AND NULLIF(BTRIM(sip_uri), '') IS NOT NULL
         ORDER BY id`,
        [companyId, ENVIRONMENT],
    );
    const resource = requireExactlyOne(
        resourceResult.rows,
        'VAPI_REGISTRY_BOOTSTRAP_SIP_RESOURCE_REQUIRED',
    );
    if (resource.provider_connection_id !== connection.id) {
        throw new VapiRegistryBootstrapError(
            'VAPI_REGISTRY_BOOTSTRAP_RESOURCE_CONNECTION_MISMATCH',
        );
    }

    const purposes = assistants.map(({ purpose }) => purpose);
    const slugs = assistants.map(({ slug }) => slug);
    const existingResult = await client.query(
        `SELECT id, purpose, slug, vapi_assistant_id
         FROM vapi_assistant_profiles
         WHERE company_id = $1
           AND environment = $2
           AND (purpose = ANY($3::text[]) OR slug = ANY($4::text[]))
         ORDER BY id`,
        [companyId, ENVIRONMENT, purposes, slugs],
    );
    for (const assistant of assistants) {
        const tupleRows = existingResult.rows.filter((row) => row.purpose === assistant.purpose);
        if (tupleRows.length > 1) {
            throw new VapiRegistryBootstrapError(
                'VAPI_REGISTRY_BOOTSTRAP_PROFILE_AMBIGUOUS',
                assistant.purpose,
            );
        }
        const slugConflict = existingResult.rows.find((row) => (
            row.slug === assistant.slug && row.purpose !== assistant.purpose
        ));
        if (slugConflict) {
            throw new VapiRegistryBootstrapError(
                'VAPI_REGISTRY_BOOTSTRAP_PROFILE_SLUG_CONFLICT',
                assistant.slug,
            );
        }
        const existing = tupleRows[0];
        if (existing?.vapi_assistant_id
            && existing.vapi_assistant_id !== assistant.assistantId) {
            throw new VapiRegistryBootstrapError(
                'VAPI_REGISTRY_BOOTSTRAP_ASSISTANT_ID_CONFLICT',
                assistant.purpose,
            );
        }
    }

    // This guard is deliberately global: provider assistant ids belong to the
    // one platform account, so a row in any company owns the identifier.
    const ownershipResult = await client.query(
        `SELECT company_id, purpose, environment, vapi_assistant_id
         FROM vapi_assistant_profiles
         WHERE vapi_assistant_id = ANY($1::text[])
         ORDER BY company_id, purpose`,
        [assistants.map(({ assistantId }) => assistantId)],
    );
    for (const owner of ownershipResult.rows) {
        const expected = assistants.find(({ assistantId }) => (
            assistantId === owner.vapi_assistant_id
        ));
        if (
            owner.company_id !== companyId
            || owner.purpose !== expected.purpose
            || owner.environment !== ENVIRONMENT
        ) {
            throw new VapiRegistryBootstrapError(
                'VAPI_REGISTRY_BOOTSTRAP_ASSISTANT_OWNERSHIP_CONFLICT',
                expected.envKey,
            );
        }
    }

    const credentials = {};
    for (const credential of CREDENTIALS) {
        const result = await client.query(
            `SELECT id
             FROM api_integrations
             WHERE company_id = $1
               AND machine_surface = $2
               AND revoked_at IS NULL
               AND (expires_at IS NULL OR expires_at > now())
               AND scopes @> $3::jsonb
             ORDER BY id`,
            [companyId, credential.key, JSON.stringify([credential.scope])],
        );
        credentials[credential.key] = {
            count: result.rows.length,
            id: result.rows.length === 1 ? result.rows[0].id : null,
        };
    }

    return {
        companyId,
        environment: ENVIRONMENT,
        providerAccountKey: PLATFORM_ACCOUNT_KEY,
        providerVerified,
        connection,
        resource,
        assistants,
        credentials,
        credentialsComplete: CREDENTIALS.every(({ key }) => credentials[key].count === 1),
    };
}

function profileIdFor(companyId, purpose) {
    return `vapi_profile_${companyId.replaceAll('-', '')}_${purpose}_${ENVIRONMENT}`;
}

async function upsertProfile(client, plan, assistant) {
    await client.query(
        `INSERT INTO vapi_assistant_profiles (
             id, tenant_id, company_id, provider_connection_id, slug, purpose,
             base_config_json, vapi_assistant_id, version, is_active, environment,
             provider_account_key, status, template_version,
             tools_credential_id, call_status_credential_id
         ) VALUES (
             $1, $2, $3, $4, $5, $6,
             NULL, $7, 'legacy-env-v1', true, $8,
             $9, 'active', 'legacy-env-v1', $10, $11
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
             status = EXCLUDED.status,
             template_version = EXCLUDED.template_version,
             tools_credential_id = EXCLUDED.tools_credential_id,
             call_status_credential_id = EXCLUDED.call_status_credential_id
         WHERE (
             vapi_assistant_profiles.tenant_id,
             vapi_assistant_profiles.provider_connection_id,
             vapi_assistant_profiles.slug,
             vapi_assistant_profiles.base_config_json,
             vapi_assistant_profiles.vapi_assistant_id,
             vapi_assistant_profiles.version,
             vapi_assistant_profiles.is_active,
             vapi_assistant_profiles.provider_account_key,
             vapi_assistant_profiles.status,
             vapi_assistant_profiles.template_version,
             vapi_assistant_profiles.tools_credential_id,
             vapi_assistant_profiles.call_status_credential_id
         ) IS DISTINCT FROM (
             EXCLUDED.tenant_id,
             EXCLUDED.provider_connection_id,
             EXCLUDED.slug,
             NULL,
             EXCLUDED.vapi_assistant_id,
             EXCLUDED.version,
             true,
             EXCLUDED.provider_account_key,
             EXCLUDED.status,
             EXCLUDED.template_version,
             EXCLUDED.tools_credential_id,
             EXCLUDED.call_status_credential_id
         )`,
        [
            profileIdFor(plan.companyId, assistant.purpose),
            plan.connection.tenant_id,
            plan.companyId,
            plan.connection.id,
            assistant.slug,
            assistant.purpose,
            assistant.assistantId,
            plan.environment,
            plan.providerAccountKey,
            plan.credentials.vapi_tools.id,
            plan.credentials.vapi_call_status.id,
        ],
    );
    const result = await client.query(
        `SELECT id
         FROM vapi_assistant_profiles
         WHERE company_id = $1 AND purpose = $2 AND environment = $3`,
        [plan.companyId, assistant.purpose, plan.environment],
    );
    return requireExactlyOne(
        result.rows,
        'VAPI_REGISTRY_BOOTSTRAP_PROFILE_WRITE_FAILED',
    ).id;
}

async function applyPlan(client, plan) {
    await client.query(
        `UPDATE provider_connections
         SET encrypted_credentials_json = NULL,
             updated_at = now()
         WHERE id = $1
           AND company_id = $2
           AND provider = 'vapi'
           AND encrypted_credentials_json IS NOT NULL`,
        [plan.connection.id, plan.companyId],
    );

    const profileIds = {};
    for (const assistant of plan.assistants) {
        profileIds[assistant.purpose] = await upsertProfile(client, plan, assistant);
    }

    await client.query(
        `UPDATE vapi_tenant_resources
         SET purpose = 'inbound_call',
             assistant_profile_id = $1,
             server_credential_id = $2,
             fallback_vapi_assistant_id = $3,
             assistant_request_secret = NULL,
             status = 'active',
             updated_at = now()
         WHERE id = $4
           AND company_id = $5
           AND provider_connection_id = $6
           AND (
               purpose,
               assistant_profile_id,
               server_credential_id,
               fallback_vapi_assistant_id,
               assistant_request_secret,
               status
           ) IS DISTINCT FROM (
               'inbound_call'::text,
               $1::text,
               $2::bigint,
               $3::text,
               NULL::text,
               'active'::text
           )`,
        [
            profileIds.inbound_call,
            plan.credentials.vapi_assistant_request.id,
            plan.assistants.find(({ purpose }) => purpose === 'inbound_call').assistantId,
            plan.resource.id,
            plan.companyId,
            plan.connection.id,
        ],
    );

    const credentialEvidence = Object.fromEntries([
        ...CREDENTIALS.map(({ key }) => [key, plan.credentials[key].count]),
        ['complete', plan.credentialsComplete],
    ]);
    const readiness = {
        registry_bootstrap: 'bootstrap-vapi-assistant-registry',
        machine_credentials: credentialEvidence,
        provider_assistants_verified: plan.providerVerified,
    };
    await client.query(
        `INSERT INTO vapi_tenant_voice_configs (
             company_id, environment, rollout_state, readiness_evidence
         ) VALUES ($1, $2, 'legacy_canary', $3::jsonb)
         ON CONFLICT (company_id, environment) DO UPDATE
         SET rollout_state = CASE
                 WHEN vapi_tenant_voice_configs.rollout_state = 'suspended'
                     THEN 'suspended'
                 ELSE 'legacy_canary'
             END,
             readiness_evidence = vapi_tenant_voice_configs.readiness_evidence || EXCLUDED.readiness_evidence
         WHERE (
             vapi_tenant_voice_configs.rollout_state,
             vapi_tenant_voice_configs.readiness_evidence
         ) IS DISTINCT FROM (
             CASE
                 WHEN vapi_tenant_voice_configs.rollout_state = 'suspended'
                     THEN 'suspended'
                 ELSE 'legacy_canary'
             END,
             vapi_tenant_voice_configs.readiness_evidence || EXCLUDED.readiness_evidence
         )`,
        [plan.companyId, plan.environment, JSON.stringify(readiness)],
    );

    return {
        mode: 'apply',
        company_id: plan.companyId,
        environment: plan.environment,
        profile_ids: profileIds,
        resource_id: plan.resource.id,
        credentials_complete: plan.credentialsComplete,
        provider_verified: plan.providerVerified,
    };
}

function summarizeDryRun(plan) {
    return {
        mode: 'dry-run',
        company_id: plan.companyId,
        environment: plan.environment,
        connection_id: plan.connection.id,
        resource_id: plan.resource.id,
        assistants: Object.fromEntries(plan.assistants.map(({ purpose, assistantId }) => (
            [purpose, assistantId]
        ))),
        credential_counts: Object.fromEntries(CREDENTIALS.map(({ key }) => (
            [key, plan.credentials[key].count]
        ))),
        credentials_complete: plan.credentialsComplete,
        provider_verified: plan.providerVerified,
        writes: false,
    };
}

async function run(argv = process.argv.slice(2), dependencies = {}) {
    const args = parseArgs(argv);
    const environment = dependencies.environment || process.env;
    const assistants = readAssistantIds(environment);
    if (args.verifyProvider) {
        const verifier = dependencies.verifyProviderAssistants || verifyProviderAssistants;
        await verifier(assistants, environment, dependencies);
    }

    const externalClient = dependencies.client || null;
    const client = externalClient || await (dependencies.db || db).getClient();
    const ownsTransaction = !externalClient;
    let lockAcquired = false;
    let discardClient = false;
    try {
        if (args.apply) {
            await acquireCompanyProvisioningLock(client, args.companyId);
            lockAcquired = true;
        }
        if (ownsTransaction) await client.query('BEGIN');
        const inspect = dependencies.inspectPlan || inspectPlan;
        const apply = dependencies.applyPlan || applyPlan;
        const plan = await inspect(client, {
            companyId: args.companyId,
            assistants,
            providerVerified: args.verifyProvider,
        });
        const result = args.apply
            ? await apply(client, plan)
            : summarizeDryRun(plan);
        if (ownsTransaction) {
            await client.query(args.apply ? 'COMMIT' : 'ROLLBACK');
        }
        (dependencies.log || console.log)(JSON.stringify(result, null, 2));
        return result;
    } catch (error) {
        if (ownsTransaction) await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        if (lockAcquired) {
            await releaseCompanyProvisioningLock(client, args.companyId).catch((error) => {
                discardClient = true;
                console.error('[vapiRegistryBootstrap] advisory unlock failed:', error.message);
            });
        }
        if (ownsTransaction) client.release(discardClient);
    }
}

if (require.main === module) {
    run()
        .catch((error) => {
            console.error(
                'Vapi assistant registry bootstrap failed:',
                error?.message || error?.code || error?.name || 'UNKNOWN',
            );
            process.exitCode = 1;
        })
        .finally(() => db.pool.end().catch(() => {}));
}

module.exports = {
    VapiRegistryBootstrapError,
    parseArgs,
    readAssistantIds,
    verifyProviderAssistants,
    inspectPlan,
    applyPlan,
    run,
};
