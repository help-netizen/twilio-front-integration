'use strict';

const SERVER_MESSAGE_TYPES = new Set([
    'assistant-request',
    'status-update',
    'end-of-call-report',
]);

const CONTRACT_VERSION = 1;

const CALL_TYPES = new Set([
    'inboundPhoneCall',
    'outboundPhoneCall',
    'webCall',
]);

const CALL_STATUSES = new Set([
    'scheduled',
    'queued',
    'ringing',
    'in-progress',
    'forwarding',
    'ended',
]);

const CORE_COST_FIELDS = ['transport', 'stt', 'llm', 'tts', 'vapi', 'chat'];
const OPTIONAL_COST_FIELDS = ['knowledgeBaseCost', 'voicemailDetectionCost'];
const TOKEN_FIELDS = [
    'llmPromptTokens',
    'llmCompletionTokens',
    'llmCachedPromptTokens',
    'ttsCharacters',
];
const ANALYSIS_COST_FIELDS = [
    'summary',
    'structuredData',
    'structuredOutput',
    'successEvaluation',
];
const ANALYSIS_TOKEN_FIELDS = [
    'summaryPromptTokens',
    'summaryCompletionTokens',
    'summaryCachedPromptTokens',
    'structuredDataPromptTokens',
    'structuredDataCompletionTokens',
    'structuredDataCachedPromptTokens',
    'structuredOutputPromptTokens',
    'structuredOutputCompletionTokens',
    'structuredOutputCachedPromptTokens',
    'successEvaluationPromptTokens',
    'successEvaluationCompletionTokens',
    'successEvaluationCachedPromptTokens',
];

const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

class VapiContractError extends Error {
    constructor(code, path, detail) {
        super(`${code} at ${path}${detail ? `: ${detail}` : ''}`);
        this.name = 'VapiContractError';
        this.code = code;
        this.path = path;
    }
}

function fail(code, path, detail) {
    throw new VapiContractError(code, path, detail);
}

/**
 * JSON.parse converts provider decimals to IEEE-754 numbers before validation.
 * Replace numeric tokens outside JSON strings with collision-free tagged strings
 * first, so money is normalized from its original wire lexeme.
 */
function parseExactJson(rawJson) {
    if (typeof rawJson !== 'string') {
        fail('raw_json_required', '$', 'pass the unparsed provider response body');
    }

    let numericPrefix = '__VAPI_EXACT_NUMBER__';
    while (rawJson.includes(numericPrefix)) numericPrefix += '_';

    let encoded = '';
    let inString = false;
    let escaped = false;

    for (let cursor = 0; cursor < rawJson.length;) {
        const char = rawJson[cursor];

        if (inString) {
            encoded += char;
            cursor += 1;
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }

        if (char === '"') {
            inString = true;
            encoded += char;
            cursor += 1;
            continue;
        }

        if (char === '-' || (char >= '0' && char <= '9')) {
            const match = rawJson.slice(cursor).match(JSON_NUMBER);
            if (!match) fail('invalid_json', '$', 'invalid numeric token');
            encoded += JSON.stringify(`${numericPrefix}${match[0]}`);
            cursor += match[0].length;
            continue;
        }

        encoded += char;
        cursor += 1;
    }

    try {
        return { value: JSON.parse(encoded), numericPrefix };
    } catch (_error) {
        fail('invalid_json', '$');
    }
}

function requireObject(value, path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail('required_object', path);
    }
    return value;
}

function requireString(object, key, path) {
    const value = object[key];
    if (typeof value !== 'string' || value.trim() === '') {
        fail('required_string', `${path}.${key}`);
    }
    return value;
}

function requireEnum(object, key, allowed, path) {
    const value = requireString(object, key, path);
    if (!allowed.has(value)) fail('unknown_value', `${path}.${key}`, value);
    return value;
}

function requireTimestamp(object, key, path) {
    const value = requireString(object, key, path);
    if (!ISO_UTC_TIMESTAMP.test(value)) fail('invalid_timestamp', `${path}.${key}`);
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) fail('invalid_timestamp', `${path}.${key}`);
    const wholeSecond = `${value.slice(0, 19)}Z`;
    if (new Date(wholeSecond).toISOString().slice(0, 19) !== value.slice(0, 19)) {
        fail('invalid_timestamp', `${path}.${key}`);
    }
    return value;
}

function optionalTimestamp(object, key, path) {
    if (object[key] === undefined) return undefined;
    return requireTimestamp(object, key, path);
}

function requireNumericLexeme(object, key, numericPrefix, path) {
    const value = object[key];
    if (typeof value !== 'string' || !value.startsWith(numericPrefix)) {
        fail('required_json_number', `${path}.${key}`);
    }
    return value.slice(numericPrefix.length);
}

function repeatZeros(count) {
    let result = '';
    for (let remaining = count; remaining > 0n; remaining -= 1n) result += '0';
    return result;
}

function normalizeUnsignedDecimal(lexeme, path) {
    if (lexeme.length > 512) fail('invalid_decimal', path, 'too long');
    const match = lexeme.match(/^(?<sign>-?)(?<integer>0|[1-9]\d*)(?:\.(?<fraction>\d+))?(?:[eE](?<exponent>[+-]?\d+))?$/);
    if (!match) fail('invalid_decimal', path);
    if (match.groups.sign === '-') fail('negative_cost', path);

    const integer = match.groups.integer;
    const fraction = match.groups.fraction || '';
    const exponent = BigInt(match.groups.exponent || '0');
    if (exponent > 1000n || exponent < -1000n) {
        fail('invalid_decimal', path, 'exponent out of range');
    }

    const digits = integer + fraction;
    const decimalPosition = BigInt(integer.length) + exponent;
    let whole;
    let decimal;

    if (decimalPosition <= 0n) {
        whole = '0';
        decimal = repeatZeros(-decimalPosition) + digits;
    } else if (decimalPosition >= BigInt(digits.length)) {
        whole = digits + repeatZeros(decimalPosition - BigInt(digits.length));
        decimal = '';
    } else {
        whole = '';
        decimal = '';
        let position = 0n;
        for (const digit of digits) {
            if (position < decimalPosition) whole += digit;
            else decimal += digit;
            position += 1n;
        }
    }

    whole = whole.replace(/^0+(?=\d)/, '');
    decimal = decimal.replace(/0+$/, '');
    if (/^0+$/.test(whole) && (!decimal || /^0+$/.test(decimal))) return '0';
    return decimal ? `${whole}.${decimal}` : whole;
}

function requireMoney(object, key, numericPrefix, path) {
    const lexeme = requireNumericLexeme(object, key, numericPrefix, path);
    return normalizeUnsignedDecimal(lexeme, `${path}.${key}`);
}

function requireCounter(object, key, numericPrefix, path) {
    const lexeme = requireNumericLexeme(object, key, numericPrefix, path);
    const normalized = normalizeUnsignedDecimal(lexeme, `${path}.${key}`);
    if (normalized.includes('.')) fail('invalid_integer', `${path}.${key}`);
    return normalized;
}

function parseCallIdentity(callValue, path, options = {}) {
    const call = requireObject(callValue, path);
    const normalized = {
        id: requireString(call, 'id', path),
        orgId: requireString(call, 'orgId', path),
        type: requireEnum(call, 'type', CALL_TYPES, path),
    };

    if (options.requireAssistant) {
        normalized.assistantId = requireString(call, 'assistantId', path);
    } else if (call.assistantId !== undefined) {
        normalized.assistantId = requireString(call, 'assistantId', path);
    }

    if (options.requireStatus) {
        normalized.status = requireEnum(call, 'status', CALL_STATUSES, path);
    } else if (call.status !== undefined) {
        normalized.status = requireEnum(call, 'status', CALL_STATUSES, path);
    }

    for (const key of ['createdAt', 'updatedAt', 'startedAt', 'endedAt']) {
        const value = optionalTimestamp(call, key, path);
        if (value !== undefined) normalized[key] = value;
    }

    if (call.endedReason !== undefined) {
        normalized.endedReason = requireString(call, 'endedReason', path);
    }

    return normalized;
}

function normalizeCost(call, numericPrefix, path) {
    const breakdown = requireObject(call.costBreakdown, `${path}.costBreakdown`);
    const supplierTotal = requireMoney(call, 'cost', numericPrefix, path);
    const breakdownTotal = requireMoney(
        breakdown,
        'total',
        numericPrefix,
        `${path}.costBreakdown`,
    );
    if (supplierTotal !== breakdownTotal) {
        fail('cost_total_mismatch', `${path}.costBreakdown.total`);
    }

    const components = {};
    for (const key of CORE_COST_FIELDS) {
        components[key] = requireMoney(breakdown, key, numericPrefix, `${path}.costBreakdown`);
    }
    for (const key of OPTIONAL_COST_FIELDS) {
        if (breakdown[key] !== undefined) {
            components[key] = requireMoney(
                breakdown,
                key,
                numericPrefix,
                `${path}.costBreakdown`,
            );
        }
    }

    const tokens = {};
    for (const key of TOKEN_FIELDS) {
        tokens[key] = requireCounter(breakdown, key, numericPrefix, `${path}.costBreakdown`);
    }

    const analysisBreakdown = requireObject(
        breakdown.analysisCostBreakdown,
        `${path}.costBreakdown.analysisCostBreakdown`,
    );
    const analysis = { costs: {}, tokens: {} };
    for (const key of ANALYSIS_COST_FIELDS) {
        analysis.costs[key] = requireMoney(
            analysisBreakdown,
            key,
            numericPrefix,
            `${path}.costBreakdown.analysisCostBreakdown`,
        );
    }
    for (const key of ANALYSIS_TOKEN_FIELDS) {
        analysis.tokens[key] = requireCounter(
            analysisBreakdown,
            key,
            numericPrefix,
            `${path}.costBreakdown.analysisCostBreakdown`,
        );
    }

    return {
        supplierTotal,
        components,
        tokens,
        analysis,
    };
}

function parseVapiServerMessageValue(value) {
    const root = requireObject(value, '$');
    const message = requireObject(root.message, '$.message');
    const type = requireEnum(message, 'type', SERVER_MESSAGE_TYPES, '$.message');

    if (type === 'assistant-request') {
        return {
            contractVersion: CONTRACT_VERSION,
            kind: type,
            call: parseCallIdentity(message.call, '$.message.call'),
        };
    }

    if (type === 'status-update') {
        const status = requireEnum(message, 'status', CALL_STATUSES, '$.message');
        const call = parseCallIdentity(message.call, '$.message.call', {
            requireAssistant: true,
            requireStatus: true,
        });
        if (call.status !== status) fail('status_mismatch', '$.message.call.status');
        return { contractVersion: CONTRACT_VERSION, kind: type, status, call };
    }

    const endedReason = requireString(message, 'endedReason', '$.message');
    const call = parseCallIdentity(message.call, '$.message.call', {
        requireAssistant: true,
        requireStatus: true,
    });
    if (call.status !== 'ended') fail('status_mismatch', '$.message.call.status');
    if (call.endedReason !== undefined && call.endedReason !== endedReason) {
        fail('ended_reason_mismatch', '$.message.call.endedReason');
    }
    return { contractVersion: CONTRACT_VERSION, kind: type, endedReason, call };
}

function parseVapiServerMessageJson(rawJson) {
    const { value } = parseExactJson(rawJson);
    return parseVapiServerMessageValue(value);
}

function parseVapiEndOfCallReportJson(rawJson) {
    const { value, numericPrefix } = parseExactJson(rawJson);
    const parsed = parseVapiServerMessageValue(value);
    if (parsed.kind !== 'end-of-call-report') {
        fail('unknown_value', '$.message.type', parsed.kind);
    }

    const rawCall = value.message.call;
    for (const key of ['createdAt', 'updatedAt', 'startedAt', 'endedAt']) {
        requireTimestamp(rawCall, key, '$.message.call');
    }

    return {
        ...parsed,
        cost: normalizeCost(rawCall, numericPrefix, '$.message.call'),
    };
}

function copyExactNumber(source, target, key, numericPrefix) {
    if (source[key] === undefined) return;
    const value = source[key];
    target[key] = typeof value === 'string' && value.startsWith(numericPrefix)
        ? value.slice(numericPrefix.length)
        : null;
}

function sanitizeCostCandidate(source, numericPrefix) {
    const sanitized = {};
    copyExactNumber(source, sanitized, 'cost', numericPrefix);

    if (source.costBreakdown === undefined) return sanitized;
    if (!source.costBreakdown || typeof source.costBreakdown !== 'object'
        || Array.isArray(source.costBreakdown)) {
        sanitized.costBreakdown = null;
        return sanitized;
    }

    const breakdown = {};
    for (const key of [
        ...CORE_COST_FIELDS,
        ...OPTIONAL_COST_FIELDS,
        ...TOKEN_FIELDS,
        'total',
    ]) {
        copyExactNumber(source.costBreakdown, breakdown, key, numericPrefix);
    }

    const rawAnalysis = source.costBreakdown.analysisCostBreakdown;
    if (rawAnalysis !== undefined) {
        if (rawAnalysis && typeof rawAnalysis === 'object' && !Array.isArray(rawAnalysis)) {
            const analysis = {};
            for (const key of [...ANALYSIS_COST_FIELDS, ...ANALYSIS_TOKEN_FIELDS]) {
                copyExactNumber(rawAnalysis, analysis, key, numericPrefix);
            }
            breakdown.analysisCostBreakdown = analysis;
        } else {
            breakdown.analysisCostBreakdown = null;
        }
    }
    sanitized.costBreakdown = breakdown;
    return sanitized;
}

/**
 * Preserve only provider identity/lifecycle/cost evidence. Numeric lexemes are
 * strings so JSONB persistence cannot pass through IEEE-754. Transcripts,
 * messages, recordings, artifacts, customer/phone objects, names, numbers,
 * assistant snapshots/overrides and server/tool configuration are never copied.
 */
function sanitizeVapiServerMessageJson(rawJson) {
    const { value, numericPrefix } = parseExactJson(rawJson);
    const parsed = parseVapiServerMessageValue(value);
    const rawMessage = value.message;
    const rawCall = rawMessage.call;
    const call = {
        id: parsed.call.id,
        orgId: parsed.call.orgId,
        type: parsed.call.type,
    };
    for (const key of [
        'assistantId',
        'status',
        'createdAt',
        'updatedAt',
        'startedAt',
        'endedAt',
        'endedReason',
    ]) {
        if (parsed.call[key] !== undefined) call[key] = parsed.call[key];
    }
    Object.assign(call, sanitizeCostCandidate(rawCall, numericPrefix));

    const message = { type: parsed.kind, call };
    if (parsed.status !== undefined) message.status = parsed.status;
    if (parsed.endedReason !== undefined) message.endedReason = parsed.endedReason;

    // Keep documented candidate placement at message level as evidence without
    // accepting it as the monetary contract. The strict EoC parser accepts only
    // message.call.cost + message.call.costBreakdown until a live body proves
    // otherwise.
    Object.assign(message, sanitizeCostCandidate(rawMessage, numericPrefix));

    return {
        evidenceSchemaVersion: 1,
        numberEncoding: 'decimal-string',
        message,
    };
}

function parseVapiGetCallJson(rawJson) {
    const { value, numericPrefix } = parseExactJson(rawJson);
    const rawCall = requireObject(value, '$');
    const call = parseCallIdentity(rawCall, '$', {
        requireAssistant: true,
        requireStatus: true,
    });

    requireTimestamp(rawCall, 'createdAt', '$');
    requireTimestamp(rawCall, 'updatedAt', '$');
    requireTimestamp(rawCall, 'startedAt', '$');
    requireTimestamp(rawCall, 'endedAt', '$');
    const endedReason = requireString(rawCall, 'endedReason', '$');
    if (call.status !== 'ended') fail('unknown_value', '$.status', call.status);

    return {
        contractVersion: CONTRACT_VERSION,
        kind: 'get-call',
        call: { ...call, endedReason },
        cost: normalizeCost(rawCall, numericPrefix, '$'),
    };
}

module.exports = {
    VapiContractError,
    parseVapiServerMessageJson,
    parseVapiEndOfCallReportJson,
    parseVapiGetCallJson,
    sanitizeVapiServerMessageJson,
};
