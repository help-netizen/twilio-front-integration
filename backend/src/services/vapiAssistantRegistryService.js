'use strict';

const db = require('../db/connection');

const PLATFORM_PROVIDER_ACCOUNT_KEY = 'vapi:platform';
const ENVIRONMENTS = Object.freeze({
    PROD: 'prod',
});
const PURPOSES = Object.freeze({
    INBOUND_QUALIFICATION: 'inbound_call',
    OUTBOUND_LEAD: 'outbound_lead_call',
    OUTBOUND_PARTS: 'outbound_parts_call',
});

class VapiAssistantRegistryError extends Error {
    constructor(code, status = 409) {
        super(code);
        this.name = 'VapiAssistantRegistryError';
        this.code = code;
        this.status = status;
    }
}

function queryFor(client) {
    return client?.query ? client.query.bind(client) : db.query;
}

function requireString(value, code, maxLength = 128) {
    if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
        throw new VapiAssistantRegistryError(code, 400);
    }
    return value.trim();
}

function assertKnownPurpose(purpose) {
    const normalized = requireString(purpose, 'VAPI_REGISTRY_PURPOSE_REQUIRED', 64);
    if (!Object.values(PURPOSES).includes(normalized)) {
        throw new VapiAssistantRegistryError('VAPI_REGISTRY_PURPOSE_UNSUPPORTED', 400);
    }
    return normalized;
}

function assertKnownEnvironment(environment) {
    const normalized = requireString(environment, 'VAPI_REGISTRY_ENVIRONMENT_REQUIRED', 32);
    if (!Object.values(ENVIRONMENTS).includes(normalized)) {
        throw new VapiAssistantRegistryError('VAPI_REGISTRY_ENVIRONMENT_UNSUPPORTED', 400);
    }
    return normalized;
}

async function resolveActiveProfile({
    companyId,
    purpose,
    environment = ENVIRONMENTS.PROD,
    client = null,
}) {
    const normalizedCompanyId = requireString(companyId, 'VAPI_REGISTRY_COMPANY_REQUIRED', 64);
    const normalizedPurpose = assertKnownPurpose(purpose);
    const normalizedEnvironment = assertKnownEnvironment(environment);
    const query = queryFor(client);
    const result = await query(
        `SELECT
             profile.id AS assistant_profile_id,
             profile.company_id,
             profile.purpose,
             profile.environment,
             profile.vapi_assistant_id,
             profile.provider_connection_id,
             profile.provider_account_key,
             profile.tools_credential_id,
             profile.call_status_credential_id
         FROM vapi_assistant_profiles profile
         JOIN provider_connections connection
           ON connection.id = profile.provider_connection_id
          AND connection.company_id = profile.company_id
          AND connection.provider = 'vapi'
          AND connection.environment = profile.environment
          AND connection.status = 'active'
         JOIN api_integrations tools_credential
           ON tools_credential.id = profile.tools_credential_id
          AND tools_credential.company_id = profile.company_id
          AND tools_credential.machine_surface = 'vapi_tools'
          AND tools_credential.revoked_at IS NULL
          AND (tools_credential.expires_at IS NULL OR tools_credential.expires_at > now())
          AND tools_credential.scopes ? 'vapi_tools:invoke'
         JOIN api_integrations status_credential
           ON status_credential.id = profile.call_status_credential_id
          AND status_credential.company_id = profile.company_id
          AND status_credential.machine_surface = 'vapi_call_status'
          AND status_credential.revoked_at IS NULL
          AND (status_credential.expires_at IS NULL OR status_credential.expires_at > now())
          AND status_credential.scopes ? 'vapi_call_status:invoke'
         WHERE profile.company_id = $1
           AND profile.purpose = $2
           AND profile.environment = $3
           AND profile.provider_account_key = $4
           AND profile.status = 'active'
           AND profile.is_active = true
           AND NULLIF(BTRIM(profile.vapi_assistant_id), '') IS NOT NULL
         ORDER BY profile.id
         LIMIT 2`,
        [
            normalizedCompanyId,
            normalizedPurpose,
            normalizedEnvironment,
            PLATFORM_PROVIDER_ACCOUNT_KEY,
        ],
    );
    if (result.rows.length !== 1) {
        throw new VapiAssistantRegistryError('VAPI_REGISTRY_PROFILE_UNAVAILABLE', 409);
    }
    const selected = result.rows[0];
    if (
        selected.company_id !== normalizedCompanyId
        || selected.purpose !== normalizedPurpose
        || selected.environment !== normalizedEnvironment
        || selected.provider_account_key !== PLATFORM_PROVIDER_ACCOUNT_KEY
    ) {
        throw new VapiAssistantRegistryError('VAPI_REGISTRY_PROFILE_SCOPE_MISMATCH', 409);
    }
    return selected;
}

async function resolveInboundTuple({
    companyId,
    purpose = PURPOSES.INBOUND_QUALIFICATION,
    environment = ENVIRONMENTS.PROD,
    client = null,
}) {
    const normalizedCompanyId = requireString(companyId, 'VAPI_REGISTRY_COMPANY_REQUIRED', 64);
    const normalizedPurpose = assertKnownPurpose(purpose);
    const normalizedEnvironment = assertKnownEnvironment(environment);
    if (normalizedPurpose !== PURPOSES.INBOUND_QUALIFICATION) {
        throw new VapiAssistantRegistryError('VAPI_REGISTRY_INBOUND_PURPOSE_REQUIRED', 400);
    }
    const query = queryFor(client);
    const result = await query(
         `SELECT
             resource.id AS tenant_resource_id,
             resource.company_id,
             resource.purpose,
             resource.environment,
             resource.sip_uri,
             resource.provider_connection_id,
             resource.server_credential_id AS assistant_request_credential_id,
             profile.id AS assistant_profile_id,
             profile.vapi_assistant_id AS expected_vapi_assistant_id
         FROM vapi_tenant_resources resource
         JOIN vapi_assistant_profiles profile
           ON profile.id = resource.assistant_profile_id
          AND profile.company_id = resource.company_id
          AND profile.provider_connection_id = resource.provider_connection_id
          AND profile.purpose = resource.purpose
          AND profile.environment = resource.environment
          AND profile.provider_account_key = $4
          AND profile.status = 'active'
          AND profile.is_active = true
         JOIN provider_connections connection
           ON connection.id = resource.provider_connection_id
          AND connection.company_id = resource.company_id
          AND connection.provider = 'vapi'
          AND connection.environment = resource.environment
          AND connection.status = 'active'
         JOIN api_integrations assistant_request_credential
           ON assistant_request_credential.id = resource.server_credential_id
          AND assistant_request_credential.company_id = resource.company_id
          AND assistant_request_credential.machine_surface = 'vapi_assistant_request'
          AND assistant_request_credential.revoked_at IS NULL
          AND (assistant_request_credential.expires_at IS NULL
               OR assistant_request_credential.expires_at > now())
          AND assistant_request_credential.scopes ? 'vapi_assistant_request:invoke'
         JOIN api_integrations tools_credential
           ON tools_credential.id = profile.tools_credential_id
          AND tools_credential.company_id = profile.company_id
          AND tools_credential.machine_surface = 'vapi_tools'
          AND tools_credential.revoked_at IS NULL
          AND (tools_credential.expires_at IS NULL OR tools_credential.expires_at > now())
          AND tools_credential.scopes ? 'vapi_tools:invoke'
         JOIN api_integrations status_credential
           ON status_credential.id = profile.call_status_credential_id
          AND status_credential.company_id = profile.company_id
          AND status_credential.machine_surface = 'vapi_call_status'
          AND status_credential.revoked_at IS NULL
          AND (status_credential.expires_at IS NULL OR status_credential.expires_at > now())
          AND status_credential.scopes ? 'vapi_call_status:invoke'
         WHERE resource.company_id = $1
           AND resource.purpose = $2
           AND resource.environment = $3
           AND resource.status = 'active'
           AND resource.is_active = true
           AND NULLIF(BTRIM(resource.sip_uri), '') IS NOT NULL
           AND NULLIF(BTRIM(profile.vapi_assistant_id), '') IS NOT NULL
         ORDER BY resource.id
         LIMIT 2
         FOR SHARE OF resource, profile, connection, assistant_request_credential,
                      tools_credential, status_credential`,
        [
            normalizedCompanyId,
            normalizedPurpose,
            normalizedEnvironment,
            PLATFORM_PROVIDER_ACCOUNT_KEY,
        ],
    );
    if (result.rows.length !== 1) {
        throw new VapiAssistantRegistryError('VAPI_REGISTRY_INBOUND_TUPLE_UNAVAILABLE', 409);
    }
    const selected = result.rows[0];
    if (
        selected.company_id !== normalizedCompanyId
        || selected.purpose !== normalizedPurpose
        || selected.environment !== normalizedEnvironment
    ) {
        throw new VapiAssistantRegistryError('VAPI_REGISTRY_INBOUND_SCOPE_MISMATCH', 409);
    }
    return selected;
}

function purposeForOutboundScenario(scenario) {
    if (scenario === undefined || scenario === null || scenario === 'parts_visit') {
        return PURPOSES.OUTBOUND_PARTS;
    }
    if (scenario === 'lead_call') return PURPOSES.OUTBOUND_LEAD;
    throw new VapiAssistantRegistryError('VAPI_REGISTRY_OUTBOUND_SCENARIO_UNSUPPORTED', 400);
}

module.exports = {
    PLATFORM_PROVIDER_ACCOUNT_KEY,
    ENVIRONMENTS,
    PURPOSES,
    VapiAssistantRegistryError,
    resolveActiveProfile,
    resolveInboundTuple,
    purposeForOutboundScenario,
};
