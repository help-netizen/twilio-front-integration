'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');

const MAX_CONNECTIONS = 2;
const CONNECTION_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const AUTH_HEADER = /^X-[A-Za-z0-9][A-Za-z0-9-]{0,61}$/;

class AppConnectionValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AppConnectionValidationError';
        this.code = 'CONNECTIONS_INVALID';
        this.httpStatus = 422;
    }
}

function fail(path, message) {
    throw new AppConnectionValidationError(`${path} ${message}`);
}

function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireExactKeys(value, allowedKeys, requiredKeys, path) {
    if (!isObject(value)) fail(path, 'must be an object.');
    const allowed = new Set(allowedKeys);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) fail(`${path}.${key}`, 'is not supported.');
    }
    for (const key of requiredKeys) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            fail(path, `must include "${key}".`);
        }
    }
}

function parseIpv4(address) {
    if (net.isIP(address) !== 4) return null;
    return address.split('.').map(Number);
}

function parseIpv6(address) {
    let normalized = String(address).toLowerCase();
    if (normalized.startsWith('[') && normalized.endsWith(']')) {
        normalized = normalized.slice(1, -1);
    }
    if (normalized.includes('%') || net.isIP(normalized) !== 6) return null;
    const ipv4Match = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    if (ipv4Match) {
        const octets = parseIpv4(ipv4Match[1]);
        if (!octets) return null;
        normalized = `${normalized.slice(0, -ipv4Match[1].length)}`
            + `${((octets[0] << 8) | octets[1]).toString(16)}:`
            + `${((octets[2] << 8) | octets[3]).toString(16)}`;
    }
    const halves = normalized.split('::');
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
        return null;
    }
    const words = [
        ...left,
        ...Array(halves.length === 2 ? missing : 0).fill('0'),
        ...right,
    ].map(word => Number.parseInt(word, 16));
    return words.length === 8 && words.every(word => Number.isInteger(word) && word >= 0 && word <= 0xffff)
        ? words
        : null;
}

function isUnsafeIpv4(address) {
    const octets = parseIpv4(address);
    if (!octets) return false;
    const [a, b] = octets;
    return a === 0
        || a === 10
        || a === 127
        || (a === 100 && b >= 64 && b <= 127)
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168)
        || a >= 224;
}

function isUnsafeIpv6(address) {
    const words = parseIpv6(address);
    if (!words) return false;
    const allZeroPrefix = words.slice(0, 7).every(word => word === 0);
    if ((allZeroPrefix && (words[7] === 0 || words[7] === 1))
        || (words[0] & 0xfe00) === 0xfc00
        || (words[0] & 0xffc0) === 0xfe80
        || (words[0] & 0xffc0) === 0xfec0
        || (words[0] & 0xff00) === 0xff00) {
        return true;
    }
    const mappedIpv4 = words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff;
    if (!mappedIpv4) return false;
    return isUnsafeIpv4([
        words[6] >> 8,
        words[6] & 0xff,
        words[7] >> 8,
        words[7] & 0xff,
    ].join('.'));
}

function isUnsafeAddress(address) {
    return isUnsafeIpv4(address) || isUnsafeIpv6(address);
}

function hostnameWithoutBrackets(hostname) {
    const normalized = String(hostname).toLowerCase().replace(/\.$/, '');
    return normalized.startsWith('[') && normalized.endsWith(']')
        ? normalized.slice(1, -1)
        : normalized;
}

function isUnsafeHostname(hostname) {
    const normalized = hostnameWithoutBrackets(hostname);
    return normalized === 'localhost'
        || normalized.endsWith('.localhost')
        || normalized.endsWith('.local')
        || normalized === 'metadata.google.internal'
        || normalized === 'instance-data.ec2.internal'
        || isUnsafeAddress(normalized);
}

function normalizeBaseUrl(value, path) {
    if (typeof value !== 'string') fail(path, 'must be an HTTPS origin.');
    let url;
    try {
        url = new URL(value);
    } catch (_error) {
        fail(path, 'must be an HTTPS origin.');
    }
    if (url.protocol !== 'https:'
        || url.username
        || url.password
        || url.port
        || url.search
        || url.hash
        || (url.pathname !== '/' && url.pathname !== '')
        || isUnsafeHostname(url.hostname)) {
        fail(path, 'must be a public HTTPS origin with implicit port 443 and no path, query, or fragment.');
    }
    return url.origin;
}

function validateConnections(value) {
    if (!Array.isArray(value)) fail('connections', 'must be an array.');
    if (value.length > MAX_CONNECTIONS) {
        fail('connections', `must contain no more than ${MAX_CONNECTIONS} connections.`);
    }
    const names = new Set();
    return value.map((connection, index) => {
        const path = `connections[${index}]`;
        requireExactKeys(connection, ['name', 'base_url', 'auth'], [
            'name', 'base_url', 'auth',
        ], path);
        if (typeof connection.name !== 'string' || !CONNECTION_NAME.test(connection.name)) {
            fail(`${path}.name`, 'must match /^[a-z][a-z0-9_]{0,31}$/.');
        }
        if (names.has(connection.name)) fail(`${path}.name`, 'must be unique.');
        names.add(connection.name);
        const baseUrl = normalizeBaseUrl(connection.base_url, `${path}.base_url`);
        requireExactKeys(
            connection.auth,
            connection.auth?.kind === 'header' ? ['kind', 'header'] : ['kind'],
            connection.auth?.kind === 'header' ? ['kind', 'header'] : ['kind'],
            `${path}.auth`
        );
        if (!['bearer', 'header'].includes(connection.auth.kind)) {
            fail(`${path}.auth.kind`, 'must be bearer or header.');
        }
        if (connection.auth.kind === 'header'
            && (typeof connection.auth.header !== 'string'
                || !AUTH_HEADER.test(connection.auth.header))) {
            fail(`${path}.auth.header`, 'must be an X- prefixed HTTP header name.');
        }
        return {
            name: connection.name,
            base_url: baseUrl,
            auth: connection.auth.kind === 'bearer'
                ? { kind: 'bearer' }
                : { kind: 'header', header: connection.auth.header },
        };
    });
}

async function resolvePublicOrigin(baseUrl, { lookup = dns.lookup } = {}) {
    const url = new URL(baseUrl);
    const hostname = hostnameWithoutBrackets(url.hostname);
    if (isUnsafeHostname(hostname)) {
        throw new AppConnectionValidationError('Connection destination is not public.');
    }
    let records;
    try {
        records = await lookup(hostname, { all: true, verbatim: true });
    } catch (_error) {
        throw new AppConnectionValidationError('Connection destination could not be resolved.');
    }
    const addresses = Array.isArray(records) ? records : [records];
    if (addresses.length === 0
        || addresses.some(record => (
            !record
            || typeof record.address !== 'string'
            || net.isIP(record.address) === 0
            || isUnsafeAddress(record.address)
        ))) {
        throw new AppConnectionValidationError('Connection destination is not public.');
    }
    return addresses.map(record => record.address);
}

async function validateConnectionDestinations(value, options = {}) {
    const connections = validateConnections(value);
    for (const connection of connections) {
        await resolvePublicOrigin(connection.base_url, options);
    }
    return connections;
}

function renderConnectionsContract() {
    return [
        'APP HTTP CONNECTION CONTRACT:',
        `The response field connections is an array of at most ${MAX_CONNECTIONS} declarations.`,
        'Use [] when the app needs no external API. Each declaration is exactly one of:',
        '{"name":"supplier","base_url":"https://api.supplier.com","auth":{"kind":"bearer"}}',
        '{"name":"supplier","base_url":"https://api.supplier.com","auth":{"kind":"header","header":"X-API-Key"}}',
        `name must match ${CONNECTION_NAME}. base_url must be a public HTTPS origin on implicit port 443,`,
        'with no path, query, fragment, credentials, private address, loopback, or link-local destination.',
        'Inside run(ctx), call only a declared connection with:',
        'await ctx.http.request(connection, {method, path, query?, body?}) -> {status, body}',
        'method is GET, POST, PUT, or DELETE; path starts with /; body is JSON up to 32 KiB.',
        'Custom headers are unavailable. HTTP failures are catchable. Limits are 5 calls per run and 500 per installation per day.',
        'Dry runs never use the network and return a synthetic sandbox_echo response.',
    ].join('\n');
}

module.exports = {
    MAX_CONNECTIONS,
    CONNECTION_NAME,
    AUTH_HEADER,
    AppConnectionValidationError,
    isUnsafeAddress,
    isUnsafeHostname,
    normalizeBaseUrl,
    validateConnections,
    resolvePublicOrigin,
    validateConnectionDestinations,
    renderConnectionsContract,
};
