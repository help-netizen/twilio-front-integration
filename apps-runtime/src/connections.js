'use strict';

const { GatewayError } = require('./errors');

const MAX_CONNECTIONS = 2;
const MAX_BODY_BYTES = 32 * 1024;
const NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const HEADER_PATTERN = /^X-[A-Za-z0-9][A-Za-z0-9-]{0,61}$/;
const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

function invalid(message = 'Connection declaration is invalid.') {
    throw new GatewayError('CONNECTIONS_INVALID', message, 422);
}

function validateConnections(value) {
    if (!Array.isArray(value) || value.length > MAX_CONNECTIONS) invalid();
    const names = new Set();
    return value.map(connection => {
        if (!connection || typeof connection !== 'object' || Array.isArray(connection)
            || Object.keys(connection).some(key => !['name', 'base_url', 'auth'].includes(key))
            || Object.keys(connection).length !== 3
            || typeof connection.name !== 'string'
            || !NAME_PATTERN.test(connection.name)
            || names.has(connection.name)) invalid();
        names.add(connection.name);
        let baseUrl;
        try {
            baseUrl = new URL(connection.base_url);
        } catch (_error) {
            invalid();
        }
        if (baseUrl.protocol !== 'https:'
            || baseUrl.username
            || baseUrl.password
            || baseUrl.port
            || baseUrl.search
            || baseUrl.hash
            || baseUrl.pathname !== '/') invalid();
        const auth = connection.auth;
        if (!auth || typeof auth !== 'object' || Array.isArray(auth)
            || !['bearer', 'header'].includes(auth.kind)
            || (auth.kind === 'bearer' && Object.keys(auth).length !== 1)
            || (auth.kind === 'header' && (
                Object.keys(auth).length !== 2
                || typeof auth.header !== 'string'
                || !HEADER_PATTERN.test(auth.header)
            ))) invalid();
        return {
            name: connection.name,
            base_url: baseUrl.origin,
            auth: auth.kind === 'bearer'
                ? { kind: 'bearer' }
                : { kind: 'header', header: auth.header },
        };
    });
}

function validateHttpRequest(connection, request) {
    if (typeof connection !== 'string' || !NAME_PATTERN.test(connection)
        || !request || typeof request !== 'object' || Array.isArray(request)
        || Object.keys(request).some(key => !['method', 'path', 'query', 'body'].includes(key))
        || !METHODS.has(request.method)
        || typeof request.path !== 'string'
        || !request.path.startsWith('/')
        || request.path.startsWith('//')
        || request.path.includes('?')
        || request.path.includes('#')) {
        throw new GatewayError('INVALID_REQUEST', 'HTTP request is invalid.', 400);
    }
    if (request.query !== undefined) {
        if (!request.query || typeof request.query !== 'object' || Array.isArray(request.query)) {
            throw new GatewayError('INVALID_REQUEST', 'HTTP query must be an object.', 400);
        }
        for (const [key, rawValue] of Object.entries(request.query)) {
            const values = Array.isArray(rawValue) ? rawValue : [rawValue];
            if (!key || Array.from(key).length > 128 || values.length === 0
                || values.some(value => (
                    !['string', 'number', 'boolean'].includes(typeof value)
                    || (typeof value === 'number' && !Number.isFinite(value))
                ))) {
                throw new GatewayError('INVALID_REQUEST', 'HTTP query is invalid.', 400);
            }
        }
    }
    if (Object.prototype.hasOwnProperty.call(request, 'body')) {
        let encoded;
        try {
            encoded = JSON.stringify(request.body);
        } catch (_error) {
            encoded = undefined;
        }
        if (request.method === 'GET' || encoded === undefined) {
            throw new GatewayError('INVALID_REQUEST', 'HTTP request body is invalid.', 400);
        }
        if (Buffer.byteLength(encoded, 'utf8') > MAX_BODY_BYTES) {
            throw new GatewayError(
                'EGRESS_BODY_TOO_LARGE',
                'HTTP request body exceeds the 32 KiB limit.',
                413
            );
        }
    }
    return { method: request.method, path: request.path };
}

function createDryRunEgressStore(declarations) {
    const connections = validateConnections(declarations);
    const names = new Set(connections.map(connection => connection.name));
    const calls = [];
    return {
        handle: async (connection, request) => {
            if (!names.has(connection)) {
                throw new GatewayError(
                    'CONNECTION_NOT_DECLARED',
                    'Connection is not declared by the draft.',
                    403
                );
            }
            const normalized = validateHttpRequest(connection, request);
            const echo = { connection, ...normalized };
            calls.push(echo);
            return { status: 200, body: { sandbox_echo: echo } };
        },
        report: () => calls.map(call => ({ ...call })),
    };
}

module.exports = {
    MAX_CONNECTIONS,
    MAX_BODY_BYTES,
    NAME_PATTERN,
    METHODS,
    validateConnections,
    validateHttpRequest,
    createDryRunEgressStore,
};
