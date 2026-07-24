'use strict';

const crypto = require('crypto');
const identityService = require('./chatgptMcpIdentityService');

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

function publicError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

async function requirePublicRequest(req) {
    if (process.env.NODE_ENV === 'production' || process.env.SVC_MCP_PUBLIC_ENABLED !== 'true') {
        throw publicError('MCP_PUBLIC_DISABLED', 'Public Service MCP transport is disabled');
    }
    const configuredToken = process.env.SVC_MCP_PUBLIC_TOKEN;
    if (!configuredToken || !timingSafeEqual(bearerToken(req), configuredToken)) {
        throw publicError('MCP_PUBLIC_UNAUTHORIZED', 'Invalid Service MCP public token');
    }
    const companyId = process.env.SVC_MCP_PUBLIC_COMPANY_ID;
    const agentUserId = process.env.SVC_MCP_PUBLIC_AGENT_USER_ID;
    if (!companyId || !agentUserId) {
        throw publicError('MCP_CONTEXT_NOT_CONFIGURED', 'Explicit Service MCP company and AI user are required');
    }
    const binding = await identityService.resolveFixedBearerContext({ companyId, agentUserId });
    return buildContext(binding, {
        ip: req.ip,
        requestId: req.requestId || req.traceId || null,
    });
}

async function requireStdioContext() {
    if (process.env.NODE_ENV === 'production') {
        throw publicError('MCP_PUBLIC_DISABLED', 'Service MCP stdio is disabled in production');
    }
    const companyId = process.env.SVC_MCP_STDIO_COMPANY_ID;
    const agentUserId = process.env.SVC_MCP_STDIO_AGENT_USER_ID;
    if (!companyId || !agentUserId) {
        throw publicError('MCP_CONTEXT_NOT_CONFIGURED', 'Explicit Service MCP stdio company and AI user are required');
    }
    const binding = await identityService.resolveFixedBearerContext({ companyId, agentUserId });
    return buildContext(binding, { ip: null, requestId: null });
}

function buildContext(binding, { ip, requestId }) {
    return {
        requestId,
        traceId: requestId,
        ip,
        companyFilter: { company_id: binding.company_id },
        user: {
            email: binding.ai_email,
            name: binding.ai_full_name,
            kind: 'agent',
            oauthAuthorizerId: binding.authorized_by_user_id,
            avatarOwnerId: binding.owner_user_id,
            crmUser: {
                id: binding.ai_user_id,
                email: binding.ai_email,
                full_name: binding.ai_full_name,
                company_id: binding.company_id,
                kind: 'agent',
                status: 'active',
            },
        },
        authz: {
            permissions: binding.permissions || [],
            oauthScopes: ['albusto.mcp.read'],
            avatarOwner: {
                id: binding.owner_user_id,
                display_name: binding.owner_display_name,
                role_key: binding.owner_role_key,
                membership: binding.owner_membership,
                permissions: binding.owner_permissions || [],
                scopes: binding.owner_scopes || {},
            },
            company: {
                id: binding.company_id,
                name: binding.company_name,
                status: 'active',
                timezone: binding.company_timezone,
            },
        },
        chatgptMcpBinding: {
            id: binding.binding_id,
            installationId: binding.installation_id,
            authorizerId: binding.authorized_by_user_id,
            ownerUserId: binding.owner_user_id,
        },
    };
}

function applyContext(req, context) {
    req.companyFilter = context.companyFilter;
    req.user = context.user;
    req.authz = context.authz;
    req.chatgptMcpBinding = context.chatgptMcpBinding;
    req.requestId = req.requestId || context.requestId;
    return req;
}

module.exports = {
    requirePublicRequest,
    requireStdioContext,
    applyContext,
    buildContext,
};
