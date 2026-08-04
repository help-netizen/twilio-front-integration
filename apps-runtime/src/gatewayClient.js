'use strict';

const { GATEWAY_TOOLS, LIMITS } = require('./config');
const { AppRunnerError, GatewayError } = require('./errors');

const TOOL_NAMES = new Set(GATEWAY_TOOLS);
const DATA_OPERATIONS = new Set(['list', 'upsert', 'delete']);
const CONNECTION_NAME = /^[a-z][a-z0-9_]{0,31}$/;

function gatewayOrigin(value) {
    let url;
    try {
        url = new URL(value);
    } catch (_error) {
        throw new AppRunnerError(
            'APP_RUNTIME_GATEWAY_CONFIG_INVALID',
            'Gateway base URL must be a valid HTTP(S) origin.'
        );
    }
    if (!['http:', 'https:'].includes(url.protocol)
        || url.username
        || url.password
        || url.search
        || url.hash
        || (url.pathname !== '/' && url.pathname !== '')) {
        throw new AppRunnerError(
            'APP_RUNTIME_GATEWAY_CONFIG_INVALID',
            'Gateway base URL must be a valid HTTP(S) origin.'
        );
    }
    return url.origin;
}

function containsSecret(value, secret, seen = new Set()) {
    if (!secret) return false;
    if (typeof value === 'string') return value.includes(secret);
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
        if ('value' in descriptor && containsSecret(descriptor.value, secret, seen)) {
            return true;
        }
    }
    return false;
}

class GatewayClient {
    constructor({ baseUrl, runToken, fetchImpl = globalThis.fetch }) {
        if (typeof runToken !== 'string' || runToken.length === 0) {
            throw new AppRunnerError(
                'APP_RUNTIME_RUN_TOKEN_REQUIRED',
                'A run token is required.'
            );
        }
        if (typeof fetchImpl !== 'function') {
            throw new AppRunnerError(
                'APP_RUNTIME_GATEWAY_CONFIG_INVALID',
                'A host fetch implementation is required.'
            );
        }
        this.baseUrl = gatewayOrigin(baseUrl);
        this.runToken = runToken;
        this.fetchImpl = fetchImpl;
    }

    async authorizeRunSource(sourceSha256, signal) {
        const url = new URL('/internal/app-runtime/v1/runs/authorize', this.baseUrl);
        const { response, payload } = await this.fetchJson(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.runToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ source_sha256: sourceSha256 }),
        }, signal);
        if (containsSecret(payload, this.runToken)) {
            throw new AppRunnerError(
                'APP_RUNTIME_TOKEN_EXPOSURE_BLOCKED',
                'Gateway response was blocked by secret hygiene.'
            );
        }
        if (!response.ok || payload?.ok !== true) {
            throw new GatewayError(
                typeof payload?.code === 'string'
                    ? payload.code
                    : 'APP_RUNTIME_AUTHORIZATION_FAILED',
                typeof payload?.message === 'string'
                    ? payload.message
                    : 'App runtime execution was not authorized.',
                Number.isInteger(response.status) ? response.status : 502
            );
        }
    }

    async fetchJson(url, options, signal, timeoutMs = LIMITS.gatewayRequestTimeoutMs) {
        const controller = new AbortController();
        let timedOut = false;
        const forwardAbort = () => controller.abort();
        if (signal?.aborted) controller.abort();
        else signal?.addEventListener('abort', forwardAbort, { once: true });
        let rejectTimeout;
        const timeout = new Promise((_, reject) => {
            rejectTimeout = reject;
        });
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            rejectTimeout(new AppRunnerError(
                'APP_RUNTIME_GATEWAY_TIMEOUT',
                'Gateway request exceeded the host timeout.'
            ));
        }, timeoutMs);

        try {
            const operation = (async () => {
                const response = await this.fetchImpl(url, {
                    ...options,
                    signal: controller.signal,
                });
                const payload = await readBoundedJson(
                    response,
                    LIMITS.maxGatewayResponseBytes
                );
                return { response, payload };
            })();
            return await Promise.race([operation, timeout]);
        } catch (error) {
            if (timedOut) {
                throw new AppRunnerError(
                    'APP_RUNTIME_GATEWAY_TIMEOUT',
                    'Gateway request exceeded the host timeout.'
                );
            }
            if (error instanceof AppRunnerError || error instanceof GatewayError) {
                throw error;
            }
            throw new AppRunnerError(
                'APP_RUNTIME_GATEWAY_UNAVAILABLE',
                'Gateway request failed.'
            );
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', forwardAbort);
        }
    }

    async callTool(toolName, args, signal) {
        if (!TOOL_NAMES.has(toolName)) {
            throw new GatewayError('TOOL_NOT_FOUND', 'Tool not found.', 404);
        }
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
            throw new GatewayError('INVALID_REQUEST', 'Tool arguments must be an object.', 400);
        }

        let body;
        try {
            body = JSON.stringify(args);
        } catch (_error) {
            throw new GatewayError('INVALID_REQUEST', 'Tool arguments must be JSON-serializable.', 400);
        }
        if (body === undefined) {
            throw new GatewayError('INVALID_REQUEST', 'Tool arguments must be JSON-serializable.', 400);
        }

        const url = new URL(
            `/internal/app-runtime/v1/tools/${encodeURIComponent(toolName)}`,
            this.baseUrl
        );
        const { response, payload } = await this.fetchJson(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.runToken}`,
                'Content-Type': 'application/json',
            },
            body,
        }, signal);

        if (containsSecret(payload, this.runToken)) {
            throw new AppRunnerError(
                'APP_RUNTIME_TOKEN_EXPOSURE_BLOCKED',
                'Gateway response was blocked by secret hygiene.'
            );
        }
        if (!response.ok || payload?.ok !== true) {
            throw new GatewayError(
                typeof payload?.code === 'string' ? payload.code : 'APP_RUNTIME_GATEWAY_ERROR',
                typeof payload?.message === 'string'
                    ? payload.message
                    : 'Gateway call failed.',
                Number.isInteger(response.status) ? response.status : 502
            );
        }
        return payload.data;
    }

    async callData(operation, collection, payload, signal) {
        if (!DATA_OPERATIONS.has(operation)
            || typeof collection !== 'string'
            || !/^[a-z][a-z0-9_]{0,63}$/.test(collection)) {
            throw new GatewayError('INVALID_REQUEST', 'Data operation is invalid.', 400);
        }
        let body;
        try {
            body = JSON.stringify(payload);
        } catch (_error) {
            throw new GatewayError('INVALID_REQUEST', 'Data request must be JSON-serializable.', 400);
        }
        if (body === undefined) {
            throw new GatewayError('INVALID_REQUEST', 'Data request must be JSON-serializable.', 400);
        }
        const url = new URL(
            `/internal/app-runtime/v1/data/${encodeURIComponent(collection)}/${operation}`,
            this.baseUrl
        );
        const { response, payload: responsePayload } = await this.fetchJson(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.runToken}`,
                'Content-Type': 'application/json',
            },
            body,
        }, signal);
        if (containsSecret(responsePayload, this.runToken)) {
            throw new AppRunnerError(
                'APP_RUNTIME_TOKEN_EXPOSURE_BLOCKED',
                'Gateway response was blocked by secret hygiene.'
            );
        }
        if (!response.ok || responsePayload?.ok !== true) {
            throw new GatewayError(
                typeof responsePayload?.code === 'string'
                    ? responsePayload.code
                    : 'APP_RUNTIME_GATEWAY_ERROR',
                typeof responsePayload?.message === 'string'
                    ? responsePayload.message
                    : 'Gateway data call failed.',
                Number.isInteger(response.status) ? response.status : 502
            );
        }
        return responsePayload.data;
    }

    async callHttp(connection, request, signal) {
        if (typeof connection !== 'string' || !CONNECTION_NAME.test(connection)
            || !request || typeof request !== 'object' || Array.isArray(request)) {
            throw new GatewayError('INVALID_REQUEST', 'HTTP request is invalid.', 400);
        }
        let body;
        try {
            body = JSON.stringify(request);
        } catch (_error) {
            throw new GatewayError('INVALID_REQUEST', 'HTTP request must be JSON-serializable.', 400);
        }
        if (body === undefined) {
            throw new GatewayError('INVALID_REQUEST', 'HTTP request must be JSON-serializable.', 400);
        }
        const url = new URL(
            `/internal/app-runtime/v1/egress/${encodeURIComponent(connection)}`,
            this.baseUrl
        );
        const { response, payload } = await this.fetchJson(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.runToken}`,
                'Content-Type': 'application/json',
            },
            body,
        }, signal, LIMITS.egressGatewayRequestTimeoutMs);
        if (containsSecret(payload, this.runToken)) {
            throw new AppRunnerError(
                'APP_RUNTIME_TOKEN_EXPOSURE_BLOCKED',
                'Gateway response was blocked by secret hygiene.'
            );
        }
        if (!response.ok || payload?.ok !== true) {
            throw new GatewayError(
                typeof payload?.code === 'string' ? payload.code : 'APP_RUNTIME_GATEWAY_ERROR',
                typeof payload?.message === 'string'
                    ? payload.message
                    : 'Gateway HTTP call failed.',
                Number.isInteger(response.status) ? response.status : 502
            );
        }
        return payload.data;
    }

    async recordRunCompletion(metrics, signal) {
        const url = new URL('/internal/app-runtime/v1/runs/complete', this.baseUrl);
        const { response, payload } = await this.fetchJson(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.runToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(metrics),
        }, signal);
        if (!response.ok || payload?.ok !== true) {
            throw new AppRunnerError(
                'APP_RUNTIME_USAGE_REPORT_FAILED',
                'App runtime usage could not be recorded.'
            );
        }
    }
}

async function readBoundedJson(response, maxBytes) {
    let text;
    try {
        if (response?.body && typeof response.body.getReader === 'function') {
            const reader = response.body.getReader();
            const chunks = [];
            let bytes = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > maxBytes) {
                    await reader.cancel().catch(() => {});
                    throw new AppRunnerError(
                        'APP_RUNTIME_GATEWAY_RESPONSE_TOO_LARGE',
                        'Gateway response exceeded the host byte limit.'
                    );
                }
                chunks.push(Buffer.from(value));
            }
            text = Buffer.concat(chunks, bytes).toString('utf8');
        } else if (typeof response?.text === 'function') {
            text = await response.text();
            if (Buffer.byteLength(text, 'utf8') > maxBytes) {
                throw new AppRunnerError(
                    'APP_RUNTIME_GATEWAY_RESPONSE_TOO_LARGE',
                    'Gateway response exceeded the host byte limit.'
                );
            }
        } else {
            throw new Error('response body unavailable');
        }
        return JSON.parse(text);
    } catch (error) {
        if (error instanceof AppRunnerError) throw error;
        throw new GatewayError(
            'APP_RUNTIME_GATEWAY_INVALID_RESPONSE',
            'Gateway returned an invalid response.',
            502
        );
    }
}

module.exports = {
    GatewayClient,
    gatewayOrigin,
    containsSecret,
    readBoundedJson,
};
