'use strict';

const crypto = require('crypto');

const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 2048;
const MAX_TEXT_VALUE_LENGTH = 1024;
const ENDPOINTS = new Set(['leads', 'jobs', 'tasks', 'contacts', 'payments']);
const DIRECTIONS = new Set(['asc', 'desc']);
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const FINGERPRINT_RE = /^[A-Za-z0-9_-]{43}$/;
const SORT_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const BIGINT_RE = /^(?:0|[1-9]\d*)$/;
const NUMERIC_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;
const VALUE_TYPES = new Set(['bigint', 'boolean', 'numeric', 'text', 'timestamp']);
const SQL_CASTS = Object.freeze({
    bigint: '::bigint',
    boolean: '::boolean',
    numeric: '::numeric',
    text: '::text',
    timestamp: '::timestamptz',
});

class InvalidCursorError extends Error {
    constructor() {
        super('Invalid cursor');
        this.name = 'InvalidCursorError';
        this.code = 'INVALID_CURSOR';
        this.statusCode = 400;
    }
}

class InvalidCursorRequestError extends Error {
    constructor() {
        super('Cursor and offset cannot be used together');
        this.name = 'InvalidCursorRequestError';
        this.code = 'INVALID_CURSOR_REQUEST';
        this.statusCode = 400;
    }
}

function invalidCursor() {
    throw new InvalidCursorError();
}

function canonicalize(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;

    if (Array.isArray(value)) return value.map(canonicalize);

    if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        return Object.keys(value)
            .sort()
            .reduce((result, key) => {
                if (value[key] === undefined) throw new TypeError('Fingerprint values cannot be undefined');
                result[key] = canonicalize(value[key]);
                return result;
            }, {});
    }

    throw new TypeError('Fingerprint values must be JSON primitives, arrays, or plain objects');
}

function createCursorFingerprint(scope) {
    const canonicalJson = JSON.stringify(canonicalize(scope));
    return crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('base64url');
}

function isValidTimestamp(value) {
    if (typeof value !== 'string') return false;
    const match = TIMESTAMP_RE.exec(value);
    if (!match || match[1] === '0000') return false;

    const millisecondTimestamp = `${value.slice(0, 20)}${match[7].slice(0, 3)}Z`;
    const parsed = new Date(millisecondTimestamp);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === millisecondTimestamp;
}

function normalizeValueType(type) {
    const descriptor = typeof type === 'string' ? { type, nullable: false } : type;
    if (
        descriptor === null
        || typeof descriptor !== 'object'
        || !VALUE_TYPES.has(descriptor.type)
        || (descriptor.nullable !== undefined && typeof descriptor.nullable !== 'boolean')
    ) {
        throw new TypeError('Unsupported cursor value type');
    }
    return { type: descriptor.type, nullable: descriptor.nullable === true };
}

function isValidCursorValue(value, descriptor) {
    if (value === null) return descriptor.nullable;

    switch (descriptor.type) {
    case 'bigint':
        return typeof value === 'string' && BIGINT_RE.test(value);
    case 'boolean':
        return typeof value === 'boolean';
    case 'numeric':
        return typeof value === 'string' && NUMERIC_RE.test(value);
    case 'text':
        return typeof value === 'string' && value.length <= MAX_TEXT_VALUE_LENGTH;
    case 'timestamp':
        return isValidTimestamp(value);
    default:
        return false;
    }
}

function validateEnvelope(payload, expected = {}) {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) invalidCursor();

    const keys = Object.keys(payload).sort();
    const expectedKeys = ['direction', 'endpoint', 'fingerprint', 'sort', 'v', 'values'];
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
        invalidCursor();
    }

    if (
        payload.v !== CURSOR_VERSION
        || !ENDPOINTS.has(payload.endpoint)
        || !SORT_RE.test(payload.sort)
        || !DIRECTIONS.has(payload.direction)
        || !FINGERPRINT_RE.test(payload.fingerprint)
        || !Array.isArray(payload.values)
    ) {
        invalidCursor();
    }

    if (
        (expected.endpoint !== undefined && payload.endpoint !== expected.endpoint)
        || (expected.sort !== undefined && payload.sort !== expected.sort)
        || (expected.direction !== undefined && payload.direction !== expected.direction)
        || (expected.fingerprint !== undefined && payload.fingerprint !== expected.fingerprint)
    ) {
        invalidCursor();
    }

    const valueTypes = expected.valueTypes;
    if (valueTypes !== undefined) {
        if (!Array.isArray(valueTypes) || payload.values.length !== valueTypes.length) invalidCursor();
        const descriptors = valueTypes.map(normalizeValueType);
        if (payload.values.some((value, index) => !isValidCursorValue(value, descriptors[index]))) {
            invalidCursor();
        }
    } else if (payload.values.some(value => (
        value !== null && typeof value !== 'string' && typeof value !== 'boolean'
    ))) {
        invalidCursor();
    }

    return payload;
}

function encodeCursor(payload, expected = {}) {
    const normalized = validateEnvelope({ ...payload, v: CURSOR_VERSION }, expected);
    const token = Buffer.from(JSON.stringify(normalized), 'utf8').toString('base64url');
    if (token.length > MAX_CURSOR_LENGTH) invalidCursor();
    return token;
}

function decodeCursor(token, expected = {}) {
    if (
        typeof token !== 'string'
        || token.length === 0
        || token.length > MAX_CURSOR_LENGTH
        || !BASE64URL_RE.test(token)
    ) {
        invalidCursor();
    }

    let payload;
    try {
        const decoded = Buffer.from(token, 'base64url');
        if (decoded.toString('base64url') !== token) invalidCursor();
        payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded));
    } catch (error) {
        if (error?.code === 'INVALID_CURSOR') throw error;
        invalidCursor();
    }

    return validateEnvelope(payload, expected);
}

function assertCursorOffsetExclusive(cursor, offset) {
    const hasCursor = typeof cursor === 'string' && cursor.length > 0;
    const hasOffset = offset !== undefined && offset !== null && String(offset).length > 0;
    if (hasCursor && hasOffset) throw new InvalidCursorRequestError();
}

function buildKeysetPredicate(keys, values, startParameter = 1) {
    if (!Array.isArray(keys) || !Array.isArray(values) || keys.length === 0 || keys.length !== values.length) {
        throw new TypeError('Cursor keys and values must be non-empty arrays of equal length');
    }
    if (!Number.isInteger(startParameter) || startParameter < 1) {
        throw new TypeError('startParameter must be a positive integer');
    }

    const normalizedKeys = keys.map((key, index) => {
        if (
            key === null
            || typeof key !== 'object'
            || typeof key.expression !== 'string'
            || key.expression.length === 0
            || !DIRECTIONS.has(key.direction)
        ) {
            throw new TypeError('Invalid cursor key descriptor');
        }

        const valueType = normalizeValueType({ type: key.type, nullable: key.nullable === true });
        if (!isValidCursorValue(values[index], valueType)) throw new InvalidCursorError();
        return { ...key, ...valueType };
    });

    const parameterFor = index => `$${startParameter + index}${SQL_CASTS[normalizedKeys[index].type]}`;
    const clauses = normalizedKeys.map((key, index) => {
        const equality = normalizedKeys
            .slice(0, index)
            .map((prefixKey, prefixIndex) => (
                `${prefixKey.expression} IS NOT DISTINCT FROM ${parameterFor(prefixIndex)}`
            ));
        const operator = key.direction === 'asc' ? '>' : '<';
        const comparison = `${key.expression} ${operator} ${parameterFor(index)}`;
        return `(${[...equality, comparison].join(' AND ')})`;
    });

    return {
        sql: `(${clauses.join(' OR ')})`,
        params: values.slice(),
    };
}

function timestampCursorExpression(expression) {
    return `to_char(${expression} AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')`;
}

function bigintCursorExpression(expression) {
    return `${expression}::text`;
}

module.exports = {
    CURSOR_VERSION,
    MAX_CURSOR_LENGTH,
    InvalidCursorError,
    InvalidCursorRequestError,
    createCursorFingerprint,
    encodeCursor,
    decodeCursor,
    assertCursorOffsetExclusive,
    buildKeysetPredicate,
    timestampCursorExpression,
    bigintCursorExpression,
};
