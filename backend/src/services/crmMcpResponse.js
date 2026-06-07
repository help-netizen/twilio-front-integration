'use strict';

const { CrmServiceError } = require('./crmErrors');

const ERROR_HTTP_STATUS = Object.freeze({
    invalid_request: 400,
    access_denied: 403,
    not_found: 404,
    unsupported_tool: 400,
    confirmation_required: 409,
    internal_error: 500,
});

function metaFromRequest(reqOrMeta = {}) {
    return {
        request_id: reqOrMeta.requestId || reqOrMeta.request_id || reqOrMeta.traceId || reqOrMeta.trace_id || null,
        timestamp: reqOrMeta.timestamp || new Date().toISOString(),
    };
}

function success(toolName, data, reqOrMeta = {}) {
    return {
        ok: true,
        tool: toolName,
        content: [{ type: 'json', json: data }],
        structuredContent: data,
        meta: metaFromRequest(reqOrMeta),
    };
}

function toolList(tools, reqOrMeta = {}) {
    return {
        ok: true,
        data: { tools },
        meta: metaFromRequest(reqOrMeta),
    };
}

function mcpError(code, message, details = {}) {
    const err = new Error(message);
    err.mcpCode = code;
    err.mcpDetails = details;
    return err;
}

function mapError(err) {
    if (err?.mcpCode) {
        return {
            code: err.mcpCode,
            message: safeMessage(err.message, err.mcpCode),
            details: sanitizeDetails(err.mcpDetails || {}),
        };
    }
    if (err instanceof CrmServiceError) {
        return mapCrmError(err);
    }
    if (err?.code === 'COMPANY_ID_REQUIRED') {
        return {
            code: 'access_denied',
            message: 'Company context required',
            details: { crm_code: err.code },
        };
    }
    return {
        code: 'internal_error',
        message: 'Unexpected CRM MCP error',
        details: {},
    };
}

function mapCrmError(err) {
    const crmCode = err.code || 'CRM_ERROR';
    const code = (() => {
        if (crmCode === 'NOT_FOUND') return 'not_found';
        if (crmCode === 'TENANT_CONTEXT_REQUIRED') return 'access_denied';
        if (crmCode === 'BAD_REQUEST' || err.httpStatus === 400) return 'invalid_request';
        if (err.httpStatus === 403) return 'access_denied';
        return 'internal_error';
    })();
    return {
        code,
        message: safeMessage(err.message, code),
        details: sanitizeDetails({ crm_code: crmCode, ...(err.details || {}) }),
    };
}

function error(toolName, err, reqOrMeta = {}) {
    return {
        ok: false,
        tool: toolName || null,
        error: mapError(err),
        meta: metaFromRequest(reqOrMeta),
    };
}

function httpStatusFor(errorResponse) {
    return ERROR_HTTP_STATUS[errorResponse?.error?.code] || 500;
}

function safeMessage(message, code) {
    if (code === 'internal_error') return 'Unexpected CRM MCP error';
    return String(message || 'CRM MCP error').slice(0, 500);
}

function sanitizeDetails(details) {
    const safe = {};
    for (const [key, value] of Object.entries(details || {})) {
        if (/token|secret|password|oauth|sql|stack/i.test(key)) continue;
        if (value === undefined || typeof value === 'function') continue;
        safe[key] = sanitizeDetailValue(value);
    }
    return safe;
}

function sanitizeDetailValue(value) {
    if (typeof value === 'string') return value.slice(0, 500);
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
    if (Array.isArray(value)) {
        return value.slice(0, 50).map(item => sanitizeDetailValue(item));
    }
    return '[redacted]';
}

module.exports = {
    success,
    toolList,
    error,
    httpStatusFor,
    mcpError,
    mapError,
    metaFromRequest,
};
