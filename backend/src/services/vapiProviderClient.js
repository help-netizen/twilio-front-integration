'use strict';

const axios = require('axios');
const { parseExactJson } = require('./vapiProviderContracts');

const DEFAULT_BASE_URL = 'https://api.vapi.ai';
const MAX_LIST_LIMIT = 1000;

class VapiProviderClientError extends Error {
    constructor(code, options = {}) {
        super(code);
        this.name = 'VapiProviderClientError';
        this.code = code;
        this.status = options.status || null;
        this.retryable = options.retryable !== false;
    }
}

function requireApiKey(value) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new VapiProviderClientError('VAPI_API_KEY_MISSING', { retryable: false });
    }
    return value.trim();
}

function requireRawBody(response) {
    if (typeof response?.data !== 'string') {
        throw new VapiProviderClientError('VAPI_PROVIDER_RAW_BODY_REQUIRED', {
            status: response?.status,
            retryable: false,
        });
    }
    return response.data;
}

function mapRequestError(error) {
    if (error instanceof VapiProviderClientError) return error;
    const status = Number.isInteger(error?.response?.status) ? error.response.status : null;
    return new VapiProviderClientError('VAPI_PROVIDER_REQUEST_FAILED', {
        status,
        retryable: status === null || status === 408 || status === 429 || status >= 500,
    });
}

function requireTimestamp(value, code) {
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        throw new VapiProviderClientError(code, { retryable: false });
    }
    return value;
}

function sanitizeListedCalls(rawJson) {
    let value;
    try {
        value = parseExactJson(rawJson).value;
    } catch (_error) {
        throw new VapiProviderClientError('VAPI_LIST_CALLS_INVALID_JSON', { retryable: false });
    }
    if (!Array.isArray(value)) {
        throw new VapiProviderClientError('VAPI_LIST_CALLS_ARRAY_REQUIRED', { retryable: false });
    }
    return value.map((call, index) => {
        if (!call || typeof call !== 'object' || Array.isArray(call)) {
            throw new VapiProviderClientError(`VAPI_LIST_CALL_INVALID_${index}`, {
                retryable: false,
            });
        }
        if (typeof call.id !== 'string' || call.id.trim() === '') {
            throw new VapiProviderClientError(`VAPI_LIST_CALL_ID_REQUIRED_${index}`, {
                retryable: false,
            });
        }
        return {
            id: call.id,
            createdAt: requireTimestamp(
                call.createdAt,
                `VAPI_LIST_CALL_CREATED_AT_REQUIRED_${index}`,
            ),
            updatedAt: requireTimestamp(
                call.updatedAt,
                `VAPI_LIST_CALL_UPDATED_AT_REQUIRED_${index}`,
            ),
        };
    });
}

function createVapiProviderClient(dependencies = {}) {
    const http = dependencies.http || axios.create({
        baseURL: dependencies.baseUrl || DEFAULT_BASE_URL,
        timeout: dependencies.timeoutMs || 15000,
        maxContentLength: 16 * 1024 * 1024,
    });
    const apiKeyProvider = dependencies.apiKeyProvider
        || (() => process.env.VAPI_API_KEY);

    async function requestRaw(url, config = {}) {
        const apiKey = requireApiKey(apiKeyProvider());
        try {
            const response = await http.get(url, {
                ...config,
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    ...(config.headers || {}),
                },
                responseType: 'text',
                transformResponse: [(body) => body],
            });
            return requireRawBody(response);
        } catch (error) {
            throw mapRequestError(error);
        }
    }

    async function getCall(providerCallId) {
        if (typeof providerCallId !== 'string' || providerCallId.trim() === '') {
            throw new VapiProviderClientError('VAPI_PROVIDER_CALL_ID_REQUIRED', {
                retryable: false,
            });
        }
        return requestRaw(`/call/${encodeURIComponent(providerCallId.trim())}`);
    }

    async function listCalls({
        createdAtGe,
        createdAtLt,
        updatedAtGe,
        updatedAtLt,
        limit = MAX_LIST_LIMIT,
    }) {
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
            throw new VapiProviderClientError('VAPI_LIST_CALLS_LIMIT_INVALID', {
                retryable: false,
            });
        }
        const hasCreatedRange = createdAtGe !== undefined || createdAtLt !== undefined;
        const hasUpdatedRange = updatedAtGe !== undefined || updatedAtLt !== undefined;
        if (hasCreatedRange === hasUpdatedRange) {
            throw new VapiProviderClientError('VAPI_LIST_CALLS_ONE_RANGE_REQUIRED', {
                retryable: false,
            });
        }
        const params = hasCreatedRange
            ? {
                createdAtGe: requireTimestamp(
                    createdAtGe,
                    'VAPI_LIST_CALLS_START_REQUIRED',
                ),
                createdAtLt: requireTimestamp(
                    createdAtLt,
                    'VAPI_LIST_CALLS_END_REQUIRED',
                ),
                limit,
            }
            : {
                updatedAtGe: requireTimestamp(
                    updatedAtGe,
                    'VAPI_LIST_CALLS_UPDATED_START_REQUIRED',
                ),
                updatedAtLt: requireTimestamp(
                    updatedAtLt,
                    'VAPI_LIST_CALLS_UPDATED_END_REQUIRED',
                ),
                limit,
            };
        const rawJson = await requestRaw('/call', { params });
        return sanitizeListedCalls(rawJson);
    }

    return { getCall, listCalls };
}

const singleton = createVapiProviderClient();

module.exports = {
    VapiProviderClientError,
    MAX_LIST_LIMIT,
    createVapiProviderClient,
    sanitizeListedCalls,
    getCall: singleton.getCall,
    listCalls: singleton.listCalls,
};
