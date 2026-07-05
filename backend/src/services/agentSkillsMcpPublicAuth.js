'use strict';

/**
 * agentSkillsMcpPublicAuth — token-gated public / stdio context for the
 * service-CRM (`svc.*`) MCP surface. AGENT-SKILLS-001, AR-3 / spec §8 /
 * architecture §4. MIRRORS `crmMcpPublicAuth.js`, but:
 *   - env names are `SVC_MCP_*` (never the sales `SALES_MCP_*`);
 *   - **company context is env-bound** (`SVC_MCP_PUBLIC_COMPANY_ID`, default
 *     `…0001` = DEFAULT_COMPANY_ID) — never taken from the client payload;
 *   - **writes are DISABLED unless explicitly enabled** (`SVC_MCP_PUBLIC_WRITE_ENABLED`
 *     === 'true'); when off, no `service.crm.write` permission is granted, so the
 *     executor's framework write-gate refuses every `svc.*` write;
 *   - the granted permission is `service.crm.write` (not `sales.crm.write`).
 *
 * The public transport is FULLY DISABLED unless `SVC_MCP_PUBLIC_ENABLED === 'true'`.
 * The sales public-auth (`crmMcpPublicAuth.js`) is UNTOUCHED — additive only.
 */

const crypto = require('crypto');

// Single-tenant default for the voice/public surface (== ZENBOOKER_DEFAULT_COMPANY_ID).
const DEFAULT_PUBLIC_COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const SERVICE_WRITE_PERMISSION = 'service.crm.write';

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

/**
 * Authenticate + build the env-bound public context for a `svc.*` request.
 * Fail-closed: disabled → MCP_PUBLIC_DISABLED; bad/missing token →
 * MCP_PUBLIC_UNAUTHORIZED (routed to HTTP 401 by the route; other codes → 403).
 * @param {Object} req Express-like request.
 * @returns {Object} Context to apply onto the request.
 */
function requirePublicRequest(req) {
    if (process.env.SVC_MCP_PUBLIC_ENABLED !== 'true') {
        const err = new Error('Public Service MCP transport is disabled');
        err.code = 'MCP_PUBLIC_DISABLED';
        throw err;
    }
    const configuredToken = process.env.SVC_MCP_PUBLIC_TOKEN;
    if (!configuredToken || !timingSafeEqual(bearerToken(req), configuredToken)) {
        const err = new Error('Invalid Service MCP public token');
        err.code = 'MCP_PUBLIC_UNAUTHORIZED';
        throw err;
    }
    return buildContext({
        companyId: process.env.SVC_MCP_PUBLIC_COMPANY_ID || DEFAULT_PUBLIC_COMPANY_ID,
        userEmail: process.env.SVC_MCP_PUBLIC_USER_EMAIL || 'svc-mcp@local',
        timezone: process.env.SVC_MCP_PUBLIC_TIMEZONE || 'America/New_York',
        // Writes OFF by default — must be explicitly enabled.
        writeEnabled: process.env.SVC_MCP_PUBLIC_WRITE_ENABLED === 'true',
        ip: req.ip,
        requestId: req.requestId || req.traceId || null,
    });
}

/**
 * Build the env-bound stdio context (optional transport). Same defaults, its own
 * env namespace, writes off unless `SVC_MCP_STDIO_WRITE_ENABLED === 'true'`.
 * @returns {Object} Context to hand to the protocol service.
 */
function requireStdioContext() {
    return buildContext({
        companyId: process.env.SVC_MCP_STDIO_COMPANY_ID || DEFAULT_PUBLIC_COMPANY_ID,
        userEmail: process.env.SVC_MCP_STDIO_USER_EMAIL || 'svc-mcp-stdio@local',
        timezone: process.env.SVC_MCP_STDIO_TIMEZONE || 'America/New_York',
        writeEnabled: process.env.SVC_MCP_STDIO_WRITE_ENABLED === 'true',
        ip: null,
        requestId: null,
    });
}

/**
 * Assemble the request-shaped context. `companyFilter.company_id` is the
 * env-bound tenant; `authz.permissions` carries `service.crm.write` only when
 * writes are enabled. No `crmUser` id is required here (the skill layer scopes by
 * companyId; audit authorship is stamped as 'AI Phone' inside the write skills).
 * @param {{companyId:string,userEmail:string,timezone:string,writeEnabled:boolean,ip:?string,requestId:?string}} opts
 * @returns {Object} Context object.
 */
function buildContext({ companyId, userEmail, timezone, writeEnabled, ip, requestId }) {
    if (!companyId) {
        const err = new Error('Service MCP transport context is not configured');
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
        },
        authz: {
            permissions: writeEnabled ? [SERVICE_WRITE_PERMISSION] : [],
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
