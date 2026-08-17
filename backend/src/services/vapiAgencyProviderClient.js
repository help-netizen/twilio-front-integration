'use strict';

const axios = require('axios');

const DEFAULT_BASE_URL = 'https://api.vapi.ai';
const MAX_LIST_LIMIT = 1000;
const PROVIDER_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const DISCOVERY_METADATA_KEYS = Object.freeze([
    'albustoProvisioningKey',
    'albustoCompanyId',
    'albustoPurpose',
    'albustoEnvironment',
]);

class VapiAgencyProviderError extends Error {
    constructor(code, options = {}) {
        super(code);
        this.name = 'VapiAgencyProviderError';
        this.code = code;
        this.status = options.status || null;
        this.retryable = options.retryable !== false;
    }
}

function requireApiKey(value) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new VapiAgencyProviderError('VAPI_AGENCY_API_KEY_REQUIRED', {
            retryable: false,
        });
    }
    return value.trim();
}

function requireProviderId(value, code) {
    if (typeof value !== 'string' || !PROVIDER_ID_RE.test(value)) {
        throw new VapiAgencyProviderError(code, { retryable: false });
    }
    return value;
}

function requireObject(value, code) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new VapiAgencyProviderError(code, { retryable: false });
    }
    return value;
}

function mapRequestError(error) {
    if (error instanceof VapiAgencyProviderError) return error;
    const status = Number.isInteger(error?.response?.status) ? error.response.status : null;
    return new VapiAgencyProviderError('VAPI_AGENCY_PROVIDER_REQUEST_FAILED', {
        status,
        retryable: status === null || status === 408 || status === 429 || status >= 500,
    });
}

function sanitizeAssistantList(value) {
    if (!Array.isArray(value)) {
        throw new VapiAgencyProviderError('VAPI_AGENCY_ASSISTANT_LIST_INVALID', {
            retryable: false,
        });
    }
    return value.map((assistant) => {
        requireObject(assistant, 'VAPI_AGENCY_ASSISTANT_LIST_ITEM_INVALID');
        const id = requireProviderId(
            assistant.id,
            'VAPI_AGENCY_ASSISTANT_LIST_ID_INVALID',
        );
        const metadata = assistant.metadata;
        if (metadata !== undefined && (
            !metadata || typeof metadata !== 'object' || Array.isArray(metadata)
        )) {
            throw new VapiAgencyProviderError(
                'VAPI_AGENCY_ASSISTANT_LIST_METADATA_INVALID',
                { retryable: false },
            );
        }
        const discoveryMetadata = {};
        for (const key of DISCOVERY_METADATA_KEYS) {
            const item = metadata?.[key];
            if (item === undefined) continue;
            if (typeof item !== 'string' || item.length < 1 || item.length > 128) {
                throw new VapiAgencyProviderError(
                    'VAPI_AGENCY_ASSISTANT_LIST_METADATA_INVALID',
                    { retryable: false },
                );
            }
            discoveryMetadata[key] = item;
        }
        return { id, metadata: discoveryMetadata };
    });
}

function sanitizePhoneList(value) {
    if (!Array.isArray(value)) {
        throw new VapiAgencyProviderError('VAPI_AGENCY_PHONE_LIST_INVALID', {
            retryable: false,
        });
    }
    return value.map((phone) => {
        requireObject(phone, 'VAPI_AGENCY_PHONE_LIST_ITEM_INVALID');
        return {
            id: requireProviderId(phone.id, 'VAPI_AGENCY_PHONE_LIST_ID_INVALID'),
            sipUri: typeof phone.sipUri === 'string' ? phone.sipUri : null,
        };
    });
}

function createVapiAgencyProviderClient(dependencies = {}) {
    const http = dependencies.http || axios.create({
        baseURL: dependencies.baseUrl || DEFAULT_BASE_URL,
        timeout: dependencies.timeoutMs || 15000,
        maxContentLength: 16 * 1024 * 1024,
    });
    const apiKeyProvider = dependencies.apiKeyProvider || (() => process.env.VAPI_API_KEY);

    async function request(method, url, body = undefined, config = {}) {
        const apiKey = requireApiKey(apiKeyProvider());
        try {
            const response = await http.request({
                method,
                url,
                data: body,
                ...config,
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                    ...(config.headers || {}),
                },
            });
            return response?.data;
        } catch (error) {
            throw mapRequestError(error);
        }
    }

    async function listAssistants() {
        const assistants = sanitizeAssistantList(await request(
            'get',
            '/assistant',
            undefined,
            { params: { limit: MAX_LIST_LIMIT } },
        ));
        if (assistants.length >= MAX_LIST_LIMIT) {
            throw new VapiAgencyProviderError('VAPI_AGENCY_ASSISTANT_LIST_TRUNCATED', {
                retryable: false,
            });
        }
        return assistants;
    }

    async function createAssistant(config) {
        const value = requireObject(
            await request('post', '/assistant', config),
            'VAPI_AGENCY_ASSISTANT_CREATE_RESPONSE_INVALID',
        );
        requireProviderId(value.id, 'VAPI_AGENCY_ASSISTANT_CREATE_ID_INVALID');
        return value;
    }

    async function updateAssistant(assistantId, config) {
        const id = requireProviderId(assistantId, 'VAPI_AGENCY_ASSISTANT_ID_INVALID');
        const value = requireObject(
            await request('patch', `/assistant/${encodeURIComponent(id)}`, config),
            'VAPI_AGENCY_ASSISTANT_PATCH_RESPONSE_INVALID',
        );
        if (requireProviderId(value.id, 'VAPI_AGENCY_ASSISTANT_PATCH_ID_INVALID') !== id) {
            throw new VapiAgencyProviderError('VAPI_AGENCY_ASSISTANT_PATCH_ID_MISMATCH', {
                retryable: false,
            });
        }
        return value;
    }

    async function getAssistant(assistantId) {
        const id = requireProviderId(assistantId, 'VAPI_AGENCY_ASSISTANT_ID_INVALID');
        const value = requireObject(
            await request('get', `/assistant/${encodeURIComponent(id)}`),
            'VAPI_AGENCY_ASSISTANT_READ_RESPONSE_INVALID',
        );
        if (requireProviderId(value.id, 'VAPI_AGENCY_ASSISTANT_READ_ID_INVALID') !== id) {
            throw new VapiAgencyProviderError('VAPI_AGENCY_ASSISTANT_READ_ID_MISMATCH', {
                retryable: false,
            });
        }
        return value;
    }

    async function listPhoneNumbers() {
        const phoneNumbers = sanitizePhoneList(await request(
            'get',
            '/phone-number',
            undefined,
            { params: { limit: MAX_LIST_LIMIT } },
        ));
        if (phoneNumbers.length >= MAX_LIST_LIMIT) {
            throw new VapiAgencyProviderError('VAPI_AGENCY_PHONE_LIST_TRUNCATED', {
                retryable: false,
            });
        }
        return phoneNumbers;
    }

    async function createPhoneNumber(config) {
        const value = requireObject(
            await request('post', '/phone-number', config),
            'VAPI_AGENCY_PHONE_CREATE_RESPONSE_INVALID',
        );
        requireProviderId(value.id, 'VAPI_AGENCY_PHONE_CREATE_ID_INVALID');
        return value;
    }

    async function updatePhoneNumber(phoneNumberId, config) {
        const id = requireProviderId(phoneNumberId, 'VAPI_AGENCY_PHONE_ID_INVALID');
        const value = requireObject(
            await request('patch', `/phone-number/${encodeURIComponent(id)}`, config),
            'VAPI_AGENCY_PHONE_PATCH_RESPONSE_INVALID',
        );
        if (requireProviderId(value.id, 'VAPI_AGENCY_PHONE_PATCH_ID_INVALID') !== id) {
            throw new VapiAgencyProviderError('VAPI_AGENCY_PHONE_PATCH_ID_MISMATCH', {
                retryable: false,
            });
        }
        return value;
    }

    async function getPhoneNumber(phoneNumberId) {
        const id = requireProviderId(phoneNumberId, 'VAPI_AGENCY_PHONE_ID_INVALID');
        const value = requireObject(
            await request('get', `/phone-number/${encodeURIComponent(id)}`),
            'VAPI_AGENCY_PHONE_READ_RESPONSE_INVALID',
        );
        if (requireProviderId(value.id, 'VAPI_AGENCY_PHONE_READ_ID_INVALID') !== id) {
            throw new VapiAgencyProviderError('VAPI_AGENCY_PHONE_READ_ID_MISMATCH', {
                retryable: false,
            });
        }
        return value;
    }

    return {
        listAssistants,
        createAssistant,
        updateAssistant,
        getAssistant,
        listPhoneNumbers,
        createPhoneNumber,
        updatePhoneNumber,
        getPhoneNumber,
    };
}

module.exports = {
    VapiAgencyProviderError,
    MAX_LIST_LIMIT,
    createVapiAgencyProviderClient,
    sanitizeAssistantList,
    sanitizePhoneList,
};
