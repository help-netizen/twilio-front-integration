'use strict';

const dns = require('node:dns').promises;
const https = require('node:https');
const net = require('node:net');
const nodeFetch = require('node-fetch');
const db = require('../db/connection');
const tokenService = require('./appRuntimeTokenService');
const { appRuntimeError } = require('./appRuntimeErrors');
const { validateConnections, resolvePublicOrigin } = require('./appConnectionValidator');
const { decryptSecret } = require('./appInstallationSecretService');

const EGRESS_TIMEOUT_MS = 15000;
const MAX_EGRESS_BODY_BYTES = 32 * 1024;
const MAX_EGRESS_RESPONSE_BYTES = 256 * 1024;
const EGRESS_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

function normalizedConnections(value) {
    try {
        return validateConnections(value || []);
    } catch (_error) {
        throw appRuntimeError(
            'APP_CONNECTION_CONFIGURATION_INVALID',
            'Accepted app connection configuration is invalid.',
            503
        );
    }
}

async function loadDeclaredConnection(database, context, connectionName) {
    const { rows } = await database.query(
        `SELECT COALESCE(version.scanner_report->'connections', '[]'::jsonb) AS connections
         FROM marketplace_installations installation
         JOIN app_versions version
           ON version.app_id = installation.app_id
          AND version.id = $4
          AND version.id::text = installation.metadata->'app_runtime'->>'version_id'
          AND version.status = 'published'
         WHERE installation.company_id = $1
           AND installation.app_id = $2
           AND installation.id = $3
           AND installation.status = 'connected'`,
        [
            context.company_id,
            context.app_id,
            context.installation_id,
            context.version_id,
        ]
    );
    if (!rows[0]) {
        throw appRuntimeError(
            'APP_RUNTIME_INACTIVE',
            'App runtime authorization is not active.',
            403
        );
    }
    const connection = normalizedConnections(rows[0].connections)
        .find(item => item.name === connectionName);
    if (!connection) {
        throw appRuntimeError(
            'CONNECTION_NOT_DECLARED',
            'Connection is not declared by the accepted app version.',
            403
        );
    }
    return connection;
}

async function loadSecret(database, context, connectionName) {
    const { rows } = await database.query(
        `SELECT secret.ciphertext
         FROM app_installation_secrets secret
         WHERE secret.company_id = $1
           AND secret.installation_id = $2
           AND secret.connection_name = $3`,
        [context.company_id, context.installation_id, connectionName]
    );
    if (!rows[0]) {
        throw appRuntimeError(
            'CONNECTION_SECRET_NOT_SET',
            'Set this connection secret on the app Settings screen.',
            422
        );
    }
    return decryptSecret(rows[0].ciphertext);
}

function isJsonValue(value) {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return false;
    try {
        return JSON.stringify(value) !== undefined;
    } catch (_error) {
        return false;
    }
}

function validateQuery(query) {
    if (query === undefined) return [];
    if (!query || typeof query !== 'object' || Array.isArray(query)) {
        throw appRuntimeError('INVALID_REQUEST', 'HTTP query must be an object.', 400);
    }
    const entries = [];
    for (const [key, rawValue] of Object.entries(query)) {
        if (!key || Array.from(key).length > 128) {
            throw appRuntimeError('INVALID_REQUEST', 'HTTP query is invalid.', 400);
        }
        const values = Array.isArray(rawValue) ? rawValue : [rawValue];
        if (values.length === 0 || values.some(value => (
            !['string', 'number', 'boolean'].includes(typeof value)
            || (typeof value === 'number' && !Number.isFinite(value))
        ))) {
            throw appRuntimeError('INVALID_REQUEST', 'HTTP query is invalid.', 400);
        }
        for (const value of values) entries.push([key, String(value)]);
    }
    return entries;
}

function composeRequest(connection, args, transportQuery = {}) {
    if (Object.keys(transportQuery || {}).length > 0
        || !args
        || typeof args !== 'object'
        || Array.isArray(args)
        || Object.keys(args).some(key => !['method', 'path', 'query', 'body'].includes(key))
        || !Object.prototype.hasOwnProperty.call(args, 'method')
        || !Object.prototype.hasOwnProperty.call(args, 'path')
        || !EGRESS_METHODS.has(args.method)
        || typeof args.path !== 'string'
        || !args.path.startsWith('/')
        || args.path.startsWith('//')
        || args.path.includes('?')
        || args.path.includes('#')) {
        throw appRuntimeError('INVALID_REQUEST', 'HTTP request is invalid.', 400);
    }
    const url = new URL(args.path, connection.base_url);
    if (url.origin !== connection.base_url) {
        throw appRuntimeError('INVALID_REQUEST', 'HTTP request path cannot change the origin.', 400);
    }
    for (const [key, value] of validateQuery(args.query)) url.searchParams.append(key, value);

    let body;
    if (Object.prototype.hasOwnProperty.call(args, 'body')) {
        if (args.method === 'GET' || !isJsonValue(args.body)) {
            throw appRuntimeError('INVALID_REQUEST', 'HTTP request body is invalid.', 400);
        }
        body = JSON.stringify(args.body);
        if (Buffer.byteLength(body, 'utf8') > MAX_EGRESS_BODY_BYTES) {
            throw appRuntimeError(
                'EGRESS_BODY_TOO_LARGE',
                'HTTP request body exceeds the 32 KiB limit.',
                413
            );
        }
    }
    return { method: args.method, url, body };
}

function createPinnedAgent(addresses) {
    const approved = addresses.map(address => ({ address, family: net.isIP(address) }));
    return new https.Agent({
        lookup: (_hostname, options, callback) => {
            const lookupOptions = typeof options === 'object' ? options : { family: options };
            const requestedFamily = Number(lookupOptions?.family) || 0;
            const candidates = requestedFamily
                ? approved.filter(item => item.family === requestedFamily)
                : approved;
            if (candidates.length === 0) {
                const error = new Error('No approved destination address matches the request.');
                error.code = 'EHOSTUNREACH';
                callback(error);
                return;
            }
            if (lookupOptions?.all) callback(null, candidates);
            else callback(null, candidates[0].address, candidates[0].family);
        },
    });
}

async function readBoundedResponse(response) {
    let buffer;
    const declaredLength = Number(response?.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_EGRESS_RESPONSE_BYTES) {
        throw appRuntimeError(
            'EGRESS_RESPONSE_TOO_LARGE',
            'External response exceeds the 256 KiB limit.',
            502
        );
    }
    if (response?.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        const chunks = [];
        let bytes = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_EGRESS_RESPONSE_BYTES) {
                await reader.cancel().catch(() => {});
                throw appRuntimeError(
                    'EGRESS_RESPONSE_TOO_LARGE',
                    'External response exceeds the 256 KiB limit.',
                    502
                );
            }
            chunks.push(Buffer.from(value));
        }
        buffer = Buffer.concat(chunks, bytes);
    } else if (response?.body
        && typeof response.body[Symbol.asyncIterator] === 'function') {
        const chunks = [];
        let bytes = 0;
        for await (const value of response.body) {
            const chunk = Buffer.from(value);
            bytes += chunk.length;
            if (bytes > MAX_EGRESS_RESPONSE_BYTES) {
                response.body.destroy?.();
                throw appRuntimeError(
                    'EGRESS_RESPONSE_TOO_LARGE',
                    'External response exceeds the 256 KiB limit.',
                    502
                );
            }
            chunks.push(chunk);
        }
        buffer = Buffer.concat(chunks, bytes);
    } else if (typeof response?.arrayBuffer === 'function') {
        buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > MAX_EGRESS_RESPONSE_BYTES) {
            throw appRuntimeError(
                'EGRESS_RESPONSE_TOO_LARGE',
                'External response exceeds the 256 KiB limit.',
                502
            );
        }
    } else {
        throw appRuntimeError('EGRESS_INVALID_RESPONSE', 'External response is invalid.', 502);
    }
    return buffer.toString('utf8');
}

function responseBody(text, contentType) {
    if (!/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i.test(contentType || '')) {
        return text;
    }
    try {
        return JSON.parse(text);
    } catch (_error) {
        throw appRuntimeError(
            'EGRESS_INVALID_JSON_RESPONSE',
            'External response declared invalid JSON.',
            502
        );
    }
}

function containsSecret(value, secret) {
    if (typeof value === 'string') return value.includes(secret);
    if (Array.isArray(value)) return value.some(item => containsSecret(item, secret));
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, item]) => (
        key.includes(secret) || containsSecret(item, secret)
    ));
}

function createAppEgressService({
    database = db,
    meter = tokenService,
    fetchImpl = nodeFetch,
    lookup = dns.lookup,
} = {}) {
    async function execute(context, connectionName, args, { transportQuery = {} } = {}) {
        // APP-EGRESS-001 gate order is security-sensitive. Keep these operations sequential.
        const connection = await loadDeclaredConnection(database, context, connectionName);
        const secret = await loadSecret(database, context, connection.name);
        const request = composeRequest(connection, args, transportQuery);
        let approvedAddresses;
        try {
            approvedAddresses = await resolvePublicOrigin(connection.base_url, { lookup });
        } catch (error) {
            if (error?.code !== 'CONNECTIONS_INVALID') throw error;
            throw appRuntimeError(
                'EGRESS_DESTINATION_DENIED',
                'External destination is not public.',
                403
            );
        }
        await meter.consumeRunEgressCall(context);
        if (typeof fetchImpl !== 'function') {
            throw appRuntimeError('EGRESS_UNAVAILABLE', 'External request service is unavailable.', 503);
        }
        const headers = {};
        if (connection.auth.kind === 'bearer') headers.Authorization = `Bearer ${secret}`;
        else headers[connection.auth.header] = secret;
        if (request.body !== undefined) headers['Content-Type'] = 'application/json';
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), EGRESS_TIMEOUT_MS);
        const agent = createPinnedAgent(approvedAddresses);
        try {
            const response = await fetchImpl(request.url.href, {
                method: request.method,
                headers,
                ...(request.body === undefined ? {} : { body: request.body }),
                redirect: 'manual',
                signal: controller.signal,
                agent,
            });
            if (response.status >= 300 && response.status < 400) {
                throw appRuntimeError(
                    'EGRESS_REDIRECT_DENIED',
                    'External redirects are not allowed.',
                    502
                );
            }
            const text = await readBoundedResponse(response);
            const body = responseBody(text, response.headers?.get?.('content-type'));
            if (text.includes(secret) || containsSecret(body, secret)) {
                throw appRuntimeError(
                    'EGRESS_SECRET_EXPOSURE_BLOCKED',
                    'External response was blocked by secret hygiene.',
                    502
                );
            }
            return {
                status: response.status,
                body,
            };
        } catch (error) {
            if (error?.code) throw error;
            if (controller.signal.aborted || error?.name === 'AbortError') {
                throw appRuntimeError(
                    'EGRESS_TIMEOUT',
                    'External request exceeded the 15 second timeout.',
                    504
                );
            }
            throw appRuntimeError('EGRESS_UNAVAILABLE', 'External request failed.', 502);
        } finally {
            clearTimeout(timer);
            agent.destroy();
        }
    }

    return { execute };
}

const service = createAppEgressService();

module.exports = {
    ...service,
    EGRESS_TIMEOUT_MS,
    MAX_EGRESS_BODY_BYTES,
    MAX_EGRESS_RESPONSE_BYTES,
    EGRESS_METHODS,
    createAppEgressService,
    loadDeclaredConnection,
    loadSecret,
    composeRequest,
    createPinnedAgent,
    readBoundedResponse,
    responseBody,
    containsSecret,
};
