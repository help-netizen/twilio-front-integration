'use strict';

const crypto = require('crypto');

const BUNDLE_VERSION = 'agency-voice-v1';
const PLATFORM_ACCOUNT_KEY = 'vapi:platform';
const PURPOSES = Object.freeze([
    {
        purpose: 'inbound_call',
        slug: 'inbound-qualification',
        source: '../../../voice-agent/assistants/lead-qualifier-v2.json',
    },
    {
        purpose: 'outbound_lead_call',
        slug: 'outbound-lead',
        source: '../../../voice-agent/assistants/outbound-lead-caller.json',
    },
    {
        purpose: 'outbound_parts_call',
        slug: 'outbound-parts',
        source: '../../../voice-agent/assistants/parts-visit-scheduler.json',
    },
]);
const TENANT_VARIABLE_KEYS = Object.freeze(['companyName', 'greeting']);
const COMPANY_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} .,'&()/-]{0,99}$/u;

class VapiAgencyTemplateError extends Error {
    constructor(code) {
        super(code);
        this.name = 'VapiAgencyTemplateError';
        this.code = code;
    }
}

function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => (
            `${JSON.stringify(key)}:${stableStringify(value[key])}`
        )).join(',')}}`;
    }
    return JSON.stringify(value);
}

function hashCanonical(value) {
    return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function replaceCompanyText(value, companyName) {
    if (typeof value === 'string') {
        return value
            .split('Home Appliance Repair Service').join(companyName)
            .split('ABC Homes Appliance Repair').join(companyName);
    }
    if (Array.isArray(value)) return value.map((item) => replaceCompanyText(item, companyName));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => (
            [key, replaceCompanyText(item, companyName)]
        )));
    }
    return value;
}

function normalizeTenantVariables(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new VapiAgencyTemplateError('VAPI_AGENCY_TENANT_VARIABLES_INVALID');
    }
    const unknown = Object.keys(value).filter((key) => !TENANT_VARIABLE_KEYS.includes(key));
    if (unknown.length > 0) {
        throw new VapiAgencyTemplateError('VAPI_AGENCY_TENANT_VARIABLE_FORBIDDEN');
    }
    const companyName = typeof value.companyName === 'string' ? value.companyName.trim() : '';
    if (!COMPANY_NAME_RE.test(companyName) || /https?:\/\//i.test(companyName)) {
        throw new VapiAgencyTemplateError('VAPI_AGENCY_COMPANY_NAME_INVALID');
    }
    let greeting = null;
    if (value.greeting !== undefined && value.greeting !== null) {
        greeting = typeof value.greeting === 'string' ? value.greeting.trim() : '';
        if (
            greeting.length < 1
            || greeting.length > 240
            || /[\r\n{}<>]/.test(greeting)
            || /https?:\/\//i.test(greeting)
        ) {
            throw new VapiAgencyTemplateError('VAPI_AGENCY_GREETING_INVALID');
        }
    }
    return { companyName, greeting };
}

function requireSecret(value, code) {
    if (typeof value !== 'string' || value.length < 32) {
        throw new VapiAgencyTemplateError(code);
    }
    return value;
}

function validateSecrets(secrets) {
    const normalized = {
        tools: requireSecret(secrets?.tools, 'VAPI_AGENCY_TOOLS_SECRET_REQUIRED'),
        callStatus: requireSecret(
            secrets?.callStatus,
            'VAPI_AGENCY_CALL_STATUS_SECRET_REQUIRED',
        ),
        assistantRequest: requireSecret(
            secrets?.assistantRequest,
            'VAPI_AGENCY_ASSISTANT_REQUEST_SECRET_REQUIRED',
        ),
    };
    if (new Set(Object.values(normalized)).size !== 3) {
        throw new VapiAgencyTemplateError('VAPI_AGENCY_MACHINE_SECRETS_NOT_DISTINCT');
    }
    return normalized;
}

function requireHttpsUrl(value, code) {
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
            throw new Error('invalid');
        }
        return parsed.toString().replace(/\/$/, '');
    } catch (_error) {
        throw new VapiAgencyTemplateError(code);
    }
}

function normalizeEndpoints(endpoints) {
    const toolsUrl = requireHttpsUrl(endpoints?.toolsUrl, 'VAPI_AGENCY_TOOLS_URL_INVALID');
    const callStatusUrl = requireHttpsUrl(
        endpoints?.callStatusUrl,
        'VAPI_AGENCY_CALL_STATUS_URL_INVALID',
    );
    const assistantRequestUrl = requireHttpsUrl(
        endpoints?.assistantRequestUrl,
        'VAPI_AGENCY_ASSISTANT_REQUEST_URL_INVALID',
    );
    return { toolsUrl, callStatusUrl, assistantRequestUrl };
}

function templateVersion(source) {
    const version = source?.metadata?.version;
    if (typeof version !== 'string' || version.trim() === '') {
        throw new VapiAgencyTemplateError('VAPI_AGENCY_TEMPLATE_VERSION_REQUIRED');
    }
    return `${BUNDLE_VERSION}:${version.trim()}`;
}

function renderAssistant({
    definition,
    companyId,
    operationKey,
    variables,
    endpoints,
    secrets,
}) {
    // Source paths are constants in this module. Tenant input can never choose a
    // template file or merge arbitrary provider JSON.
    const source = require(definition.source);
    const config = replaceCompanyText(clone(source), variables.companyName);
    if (definition.purpose === 'inbound_call' && variables.greeting) {
        config.firstMessage = variables.greeting;
    }
    config.name = `${variables.companyName} · ${source.name} · ${companyId.slice(0, 8)}`;
    if (!config.model || !Array.isArray(config.model.tools) || config.model.tools.length === 0) {
        throw new VapiAgencyTemplateError('VAPI_AGENCY_TEMPLATE_TOOLS_REQUIRED');
    }
    for (const tool of config.model.tools) {
        if (!tool || typeof tool !== 'object' || !tool.function?.name) {
            throw new VapiAgencyTemplateError('VAPI_AGENCY_TEMPLATE_TOOL_INVALID');
        }
        tool.server = {
            url: endpoints.toolsUrl,
            secret: secrets.tools,
        };
    }
    config.server = {
        url: endpoints.callStatusUrl,
        secret: secrets.callStatus,
        timeoutSeconds: 20,
    };
    config.serverMessages = ['end-of-call-report', 'status-update'];
    config.metadata = {
        ...(config.metadata || {}),
        albustoProvisioningKey: operationKey,
        albustoCompanyId: companyId,
        albustoPurpose: definition.purpose,
        albustoEnvironment: 'prod',
        albustoTemplateBundle: BUNDLE_VERSION,
    };
    return {
        purpose: definition.purpose,
        slug: definition.slug,
        version: templateVersion(source),
        config,
    };
}

function renderBundle(input) {
    const variables = normalizeTenantVariables(input.variables);
    const endpoints = normalizeEndpoints(input.endpoints);
    const secrets = validateSecrets(input.secrets);
    if (typeof input.companyId !== 'string' || typeof input.operationKey !== 'string') {
        throw new VapiAgencyTemplateError('VAPI_AGENCY_TEMPLATE_IDENTITY_REQUIRED');
    }
    return PURPOSES.map((definition) => renderAssistant({
        definition,
        companyId: input.companyId,
        operationKey: input.operationKey,
        variables,
        endpoints,
        secrets,
    }));
}

function withoutSecrets(value) {
    if (Array.isArray(value)) return value.map(withoutSecrets);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
            .filter(([key]) => !['secret', 'authorization', 'apiKey'].includes(key))
            .map(([key, item]) => [key, withoutSecrets(item)]));
    }
    return value;
}

function matchesExpected(actual, expected, path = '$') {
    if (Array.isArray(expected)) {
        if (!Array.isArray(actual) || actual.length !== expected.length) return path;
        for (let index = 0; index < expected.length; index += 1) {
            const mismatch = matchesExpected(actual[index], expected[index], `${path}[${index}]`);
            if (mismatch) return mismatch;
        }
        return null;
    }
    if (expected && typeof expected === 'object') {
        if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return path;
        for (const [key, value] of Object.entries(expected)) {
            const mismatch = matchesExpected(actual[key], value, `${path}.${key}`);
            if (mismatch) return mismatch;
        }
        return null;
    }
    return Object.is(actual, expected) ? null : path;
}

function collectExpectedDifferences(actual, expected, path = '$', differences = []) {
    if (Array.isArray(expected)) {
        if (!Array.isArray(actual) || actual.length !== expected.length) {
            differences.push(path);
            return differences;
        }
        for (let index = 0; index < expected.length; index += 1) {
            collectExpectedDifferences(
                actual[index],
                expected[index],
                `${path}[${index}]`,
                differences,
            );
        }
        return differences;
    }
    if (expected && typeof expected === 'object') {
        if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
            differences.push(path);
            return differences;
        }
        for (const [key, value] of Object.entries(expected)) {
            collectExpectedDifferences(actual[key], value, `${path}.${key}`, differences);
        }
        return differences;
    }
    if (!Object.is(actual, expected)) differences.push(path);
    return differences;
}

function assistantReadbackDifferences(actual, rendered) {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
        throw new VapiAgencyTemplateError('VAPI_AGENCY_ASSISTANT_READBACK_INVALID');
    }
    return collectExpectedDifferences(
        withoutSecrets(actual),
        withoutSecrets(rendered.config),
    );
}

function verifyAssistantReadback(actual, rendered) {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
        throw new VapiAgencyTemplateError('VAPI_AGENCY_ASSISTANT_READBACK_INVALID');
    }
    if (
        typeof actual.id !== 'string'
        || typeof actual.updatedAt !== 'string'
        || Number.isNaN(Date.parse(actual.updatedAt))
    ) {
        throw new VapiAgencyTemplateError('VAPI_AGENCY_ASSISTANT_READBACK_IDENTITY_INVALID');
    }
    // Assistant server.secret is write-only at Vapi. The only authoritative
    // readback proof is this boolean flag; an absent secret echo is expected.
    if (actual.isServerUrlSecretSet !== true) {
        throw new VapiAgencyTemplateError('VAPI_AGENCY_ASSISTANT_SERVER_SECRET_UNSET');
    }
    const expectedWithoutServerSecret = clone(rendered.config);
    delete expectedWithoutServerSecret.server.secret;
    const actualForComparison = clone(actual);
    if (actualForComparison.server) delete actualForComparison.server.secret;
    const mismatch = matchesExpected(actualForComparison, expectedWithoutServerSecret);
    if (mismatch) {
        throw new VapiAgencyTemplateError('VAPI_AGENCY_ASSISTANT_READBACK_DRIFT');
    }
    return {
        id: actual.id,
        updatedAt: actual.updatedAt,
        templateVersion: rendered.version,
        hash: hashCanonical(withoutSecrets(rendered.config)),
    };
}

function buildSipResource({ companyId, companyName, sipHost, endpoints, secrets }) {
    if (typeof sipHost !== 'string' || !/^sip(?:\.eu)?\.vapi\.ai$/.test(sipHost)) {
        throw new VapiAgencyTemplateError('VAPI_AGENCY_SIP_HOST_INVALID');
    }
    const normalizedEndpoints = normalizeEndpoints(endpoints);
    const normalizedSecrets = validateSecrets(secrets);
    const sipUri = `sip:albusto-${companyId.replaceAll('-', '')}-prod@${sipHost}`;
    return {
        sipUri,
        config: {
            provider: 'vapi',
            name: `${companyName} · Albusto SIP · ${companyId.slice(0, 8)}`,
            sipUri,
            assistantId: null,
            server: {
                url: normalizedEndpoints.assistantRequestUrl,
                secret: normalizedSecrets.assistantRequest,
                timeoutSeconds: 20,
            },
        },
    };
}

function verifySipResourceReadback(actual, expected) {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
        throw new VapiAgencyTemplateError('VAPI_AGENCY_SIP_READBACK_INVALID');
    }
    if (
        typeof actual.id !== 'string'
        || typeof actual.updatedAt !== 'string'
        || Number.isNaN(Date.parse(actual.updatedAt))
    ) {
        throw new VapiAgencyTemplateError('VAPI_AGENCY_SIP_READBACK_IDENTITY_INVALID');
    }
    if (actual.isServerUrlSecretSet !== true) {
        throw new VapiAgencyTemplateError('VAPI_AGENCY_SIP_SERVER_SECRET_UNSET');
    }
    const expectedWithoutSecret = clone(expected.config);
    delete expectedWithoutSecret.server.secret;
    const actualForComparison = clone(actual);
    if (actualForComparison.server) delete actualForComparison.server.secret;
    const mismatch = matchesExpected(actualForComparison, expectedWithoutSecret);
    if (mismatch) throw new VapiAgencyTemplateError('VAPI_AGENCY_SIP_READBACK_DRIFT');
    return {
        id: actual.id,
        updatedAt: actual.updatedAt,
        hash: hashCanonical(withoutSecrets(expected.config)),
    };
}

function sipResourceReadbackDifferences(actual, expected) {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
        throw new VapiAgencyTemplateError('VAPI_AGENCY_SIP_READBACK_INVALID');
    }
    return collectExpectedDifferences(
        withoutSecrets(actual),
        withoutSecrets(expected.config),
    );
}

module.exports = {
    BUNDLE_VERSION,
    PLATFORM_ACCOUNT_KEY,
    PURPOSES,
    TENANT_VARIABLE_KEYS,
    VapiAgencyTemplateError,
    stableStringify,
    hashCanonical,
    normalizeTenantVariables,
    normalizeEndpoints,
    validateSecrets,
    renderBundle,
    verifyAssistantReadback,
    assistantReadbackDifferences,
    buildSipResource,
    verifySipResourceReadback,
    sipResourceReadbackDifferences,
    withoutSecrets,
};
