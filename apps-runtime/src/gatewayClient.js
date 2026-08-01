'use strict';

const { GATEWAY_TOOLS } = require('./config');
const { AppRunnerError, GatewayError } = require('./errors');

const TOOL_NAMES = new Set(GATEWAY_TOOLS);

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
        const response = await this.fetchImpl(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.runToken}`,
                'Content-Type': 'application/json',
            },
            body,
            signal,
        });

        let payload;
        try {
            payload = await response.json();
        } catch (_error) {
            throw new GatewayError(
                'APP_RUNTIME_GATEWAY_INVALID_RESPONSE',
                'Gateway returned an invalid response.',
                502
            );
        }

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
}

module.exports = {
    GatewayClient,
    gatewayOrigin,
    containsSecret,
};
