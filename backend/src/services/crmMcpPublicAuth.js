'use strict';

const crypto = require('crypto');

function timingSafeEqual(a, b) {
    const left = Buffer.from(String(a || ''));
    const right = Buffer.from(String(b || ''));
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
}

function bearerToken(req) {
    const header = req.headers?.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return match ? match[1] : null;
}

function requirePublicRequest(req) {
    if (process.env.SALES_MCP_PUBLIC_ENABLED !== 'true') {
        const err = new Error('Public Sales MCP transport is disabled');
        err.code = 'MCP_PUBLIC_DISABLED';
        throw err;
    }
    const configuredToken = process.env.SALES_MCP_PUBLIC_TOKEN;
    if (!configuredToken || !timingSafeEqual(bearerToken(req), configuredToken)) {
        const err = new Error('Invalid Sales MCP public token');
        err.code = 'MCP_PUBLIC_UNAUTHORIZED';
        throw err;
    }
    return buildContext({
        companyId: process.env.SALES_MCP_PUBLIC_COMPANY_ID,
        userId: process.env.SALES_MCP_PUBLIC_USER_ID,
        userEmail: process.env.SALES_MCP_PUBLIC_USER_EMAIL || 'sales-mcp@local',
        timezone: process.env.SALES_MCP_PUBLIC_TIMEZONE || 'America/New_York',
        writeEnabled: process.env.SALES_MCP_PUBLIC_WRITE_ENABLED === 'true',
        ip: req.ip,
        requestId: req.requestId || req.traceId || null,
    });
}

function requireStdioContext() {
    return buildContext({
        companyId: process.env.SALES_MCP_STDIO_COMPANY_ID,
        userId: process.env.SALES_MCP_STDIO_USER_ID,
        userEmail: process.env.SALES_MCP_STDIO_USER_EMAIL || 'sales-mcp-stdio@local',
        timezone: process.env.SALES_MCP_STDIO_TIMEZONE || 'America/New_York',
        writeEnabled: process.env.SALES_MCP_STDIO_WRITE_ENABLED === 'true',
        ip: null,
        requestId: null,
    });
}

function buildContext({ companyId, userId, userEmail, timezone, writeEnabled, ip, requestId }) {
    if (!companyId || !userId) {
        const err = new Error('Sales MCP transport context is not configured');
        err.code = 'MCP_CONTEXT_NOT_CONFIGURED';
        throw err;
    }
    return {
        requestId,
        traceId: requestId,
        ip,
        companyFilter: { company_id: companyId },
        user: {
            email: userEmail,
            crmUser: { id: userId },
        },
        authz: {
            permissions: writeEnabled ? ['sales.crm.write'] : [],
            company: { id: companyId, status: 'active', timezone: timezone || 'America/New_York' },
        },
    };
}

function applyContext(req, context) {
    req.companyFilter = context.companyFilter;
    req.user = context.user;
    req.authz = context.authz;
    req.requestId = req.requestId || context.requestId;
    return req;
}

module.exports = {
    requirePublicRequest,
    requireStdioContext,
    applyContext,
};
