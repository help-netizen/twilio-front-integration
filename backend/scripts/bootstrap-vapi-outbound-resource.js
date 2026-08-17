#!/usr/bin/env node
'use strict';

const db = require('../src/db/connection');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164_RE = /^\+[1-9]\d{7,14}$/;
const ENVIRONMENT = 'prod';
const OUTBOUND_PURPOSES = ['outbound_lead_call', 'outbound_parts_call'];

class VapiOutboundBootstrapError extends Error {
    constructor(code, detail = '') {
        super(detail ? `${code}: ${detail}` : code);
        this.name = 'VapiOutboundBootstrapError';
        this.code = code;
    }
}

function parseArgs(argv) {
    const args = { apply: false };
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
        } else {
            throw new VapiOutboundBootstrapError('VAPI_OUTBOUND_BOOTSTRAP_ARGUMENT_UNKNOWN', token);
        }
    }
    if (!args.companyId || !UUID_RE.test(args.companyId)) {
        throw new VapiOutboundBootstrapError(
            'VAPI_OUTBOUND_BOOTSTRAP_COMPANY_ID_REQUIRED',
            '--company-id must be a UUID',
        );
    }
    if (args.apply && explicitDryRun) {
        throw new VapiOutboundBootstrapError(
            'VAPI_OUTBOUND_BOOTSTRAP_MODE_CONFLICT',
            '--apply and --dry-run are mutually exclusive',
        );
    }
    return args;
}

function readCallerResource(environment) {
    const phoneNumberId = typeof environment.VAPI_OUTBOUND_PHONE_NUMBER_ID === 'string'
        ? environment.VAPI_OUTBOUND_PHONE_NUMBER_ID.trim()
        : '';
    const twilioPhoneNumber = typeof environment.VAPI_OUTBOUND_TWILIO_NUMBER === 'string'
        ? environment.VAPI_OUTBOUND_TWILIO_NUMBER.trim()
        : '';
    if (Boolean(phoneNumberId) === Boolean(twilioPhoneNumber)) {
        throw new VapiOutboundBootstrapError(
            'VAPI_OUTBOUND_BOOTSTRAP_CALLER_REQUIRED',
            'set exactly one of VAPI_OUTBOUND_PHONE_NUMBER_ID or VAPI_OUTBOUND_TWILIO_NUMBER',
        );
    }
    if (twilioPhoneNumber && !E164_RE.test(twilioPhoneNumber)) {
        throw new VapiOutboundBootstrapError('VAPI_OUTBOUND_BOOTSTRAP_TWILIO_NUMBER_INVALID');
    }
    if (twilioPhoneNumber && (
        typeof environment.TWILIO_ACCOUNT_SID !== 'string'
        || environment.TWILIO_ACCOUNT_SID.trim() === ''
        || typeof environment.TWILIO_AUTH_TOKEN !== 'string'
        || environment.TWILIO_AUTH_TOKEN.trim() === ''
    )) {
        throw new VapiOutboundBootstrapError(
            'VAPI_OUTBOUND_BOOTSTRAP_TWILIO_CREDENTIALS_REQUIRED',
        );
    }
    return phoneNumberId
        ? {
            resourceType: 'vapi_phone_number',
            vapiPhoneNumberId: phoneNumberId,
            twilioPhoneNumber: null,
        }
        : {
            resourceType: 'transient_twilio',
            vapiPhoneNumberId: null,
            twilioPhoneNumber,
        };
}

function requireExactlyOne(rows, code) {
    if (rows.length !== 1) {
        throw new VapiOutboundBootstrapError(code, `found ${rows.length}`);
    }
    return rows[0];
}

async function inspectPlan(client, { companyId, caller }) {
    const connection = requireExactlyOne((await client.query(
        `SELECT id, tenant_id, company_id
         FROM provider_connections
         WHERE company_id = $1
           AND provider = 'vapi'
           AND environment = $2
           AND status = 'active'
         ORDER BY id`,
        [companyId, ENVIRONMENT],
    )).rows, 'VAPI_OUTBOUND_BOOTSTRAP_CONNECTION_REQUIRED');

    const profiles = (await client.query(
        `SELECT id, company_id, provider_connection_id, purpose, environment
         FROM vapi_assistant_profiles
         WHERE company_id = $1
           AND purpose = ANY($2::text[])
           AND environment = $3
           AND provider_account_key = 'vapi:platform'
           AND status = 'active'
           AND is_active = true
           AND NULLIF(BTRIM(vapi_assistant_id), '') IS NOT NULL
         ORDER BY purpose, id`,
        [companyId, OUTBOUND_PURPOSES, ENVIRONMENT],
    )).rows;
    for (const purpose of OUTBOUND_PURPOSES) {
        const profile = requireExactlyOne(
            profiles.filter((row) => row.purpose === purpose),
            'VAPI_OUTBOUND_BOOTSTRAP_PROFILE_REQUIRED',
        );
        if (profile.provider_connection_id !== connection.id) {
            throw new VapiOutboundBootstrapError(
                'VAPI_OUTBOUND_BOOTSTRAP_PROFILE_CONNECTION_MISMATCH',
                purpose,
            );
        }
    }

    const ownership = await client.query(
        `SELECT company_id, id
         FROM vapi_tenant_resources
         WHERE is_active = true
           AND (
               ($1::text IS NOT NULL AND vapi_phone_number_id = $1)
               OR ($2::text IS NOT NULL AND twilio_phone_number = $2)
           )
           AND company_id <> $3
         LIMIT 2`,
        [caller.vapiPhoneNumberId, caller.twilioPhoneNumber, companyId],
    );
    if (ownership.rows.length > 0) {
        throw new VapiOutboundBootstrapError('VAPI_OUTBOUND_BOOTSTRAP_CALLER_OWNERSHIP_CONFLICT');
    }

    return { companyId, connection, profiles, caller };
}

function resourceIdFor(companyId) {
    return `vapi_resource_${companyId.replaceAll('-', '')}_outbound_${ENVIRONMENT}`;
}

async function applyPlan(client, plan) {
    const resourceId = resourceIdFor(plan.companyId);
    const written = await client.query(
        `INSERT INTO vapi_tenant_resources (
             id, tenant_id, provider_connection_id, environment,
             vapi_phone_number_id, twilio_phone_number, is_active,
             company_id, purpose, assistant_profile_id,
             server_credential_id, assistant_request_secret, status,
             resource_type
         ) VALUES (
             $1, $2, $3, $4, $5, $6, true,
             $7, 'outbound_call', NULL,
             NULL, NULL, 'active', $8
         )
         ON CONFLICT (company_id, purpose, environment)
         WHERE company_id IS NOT NULL
         DO UPDATE
         SET tenant_id = EXCLUDED.tenant_id,
             provider_connection_id = EXCLUDED.provider_connection_id,
             vapi_phone_number_id = EXCLUDED.vapi_phone_number_id,
             twilio_phone_number = EXCLUDED.twilio_phone_number,
             is_active = true,
             assistant_profile_id = NULL,
             server_credential_id = NULL,
             assistant_request_secret = NULL,
             status = 'active',
             resource_type = EXCLUDED.resource_type,
             updated_at = now()
         WHERE (
             vapi_tenant_resources.tenant_id,
             vapi_tenant_resources.provider_connection_id,
             vapi_tenant_resources.vapi_phone_number_id,
             vapi_tenant_resources.twilio_phone_number,
             vapi_tenant_resources.is_active,
             vapi_tenant_resources.assistant_profile_id,
             vapi_tenant_resources.server_credential_id,
             vapi_tenant_resources.assistant_request_secret,
             vapi_tenant_resources.status,
             vapi_tenant_resources.resource_type
         ) IS DISTINCT FROM (
             EXCLUDED.tenant_id,
             EXCLUDED.provider_connection_id,
             EXCLUDED.vapi_phone_number_id,
             EXCLUDED.twilio_phone_number,
             true,
             NULL::text,
             NULL::bigint,
             NULL::text,
             'active'::text,
             EXCLUDED.resource_type
         )
         RETURNING id`,
        [
            resourceId,
            plan.connection.tenant_id,
            plan.connection.id,
            ENVIRONMENT,
            plan.caller.vapiPhoneNumberId,
            plan.caller.twilioPhoneNumber,
            plan.companyId,
            plan.caller.resourceType,
        ],
    );
    let persistedResourceId = written.rows[0]?.id || null;
    if (!persistedResourceId) {
        const existing = await client.query(
            `SELECT id
             FROM vapi_tenant_resources
             WHERE company_id = $1
               AND purpose = 'outbound_call'
               AND environment = $2
             ORDER BY id`,
            [plan.companyId, ENVIRONMENT],
        );
        persistedResourceId = requireExactlyOne(
            existing.rows,
            'VAPI_OUTBOUND_BOOTSTRAP_RESOURCE_WRITE_FAILED',
        ).id;
    }
    return {
        mode: 'apply',
        company_id: plan.companyId,
        environment: ENVIRONMENT,
        resource_id: persistedResourceId,
        resource_type: plan.caller.resourceType,
    };
}

function summarizeDryRun(plan) {
    return {
        mode: 'dry-run',
        company_id: plan.companyId,
        environment: ENVIRONMENT,
        connection_id: plan.connection.id,
        profile_ids: Object.fromEntries(plan.profiles.map((profile) => [profile.purpose, profile.id])),
        resource_type: plan.caller.resourceType,
        caller_identifier: plan.caller.vapiPhoneNumberId || plan.caller.twilioPhoneNumber,
        writes: false,
    };
}

async function run(argv = process.argv.slice(2), dependencies = {}) {
    const args = parseArgs(argv);
    const caller = readCallerResource(dependencies.environment || process.env);
    const externalClient = dependencies.client || null;
    const client = externalClient || await (dependencies.db || db).getClient();
    const ownsTransaction = !externalClient;
    try {
        if (ownsTransaction) await client.query('BEGIN');
        const plan = await inspectPlan(client, { companyId: args.companyId, caller });
        const result = args.apply ? await applyPlan(client, plan) : summarizeDryRun(plan);
        if (ownsTransaction) await client.query(args.apply ? 'COMMIT' : 'ROLLBACK');
        (dependencies.log || console.log)(JSON.stringify(result, null, 2));
        return result;
    } catch (error) {
        if (ownsTransaction) await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        if (ownsTransaction) client.release();
    }
}

if (require.main === module) {
    run()
        .catch((error) => {
            console.error(
                'Vapi outbound resource bootstrap failed:',
                error?.message || error?.code || error?.name || 'UNKNOWN',
            );
            process.exitCode = 1;
        })
        .finally(() => db.pool.end().catch(() => {}));
}

module.exports = {
    VapiOutboundBootstrapError,
    parseArgs,
    readCallerResource,
    inspectPlan,
    applyPlan,
    run,
};
