'use strict';

const authorizationService = require('./authorizationService');
const machineCredentials = require('./machineCredentialService');

const SALES_READ_PERMISSIONS = Object.freeze([
    'contacts.view',
    'leads.view',
    'tasks.view',
]);

function bearerToken(req) {
    const header = req.headers?.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return match ? match[1] : null;
}

function publicError(code, message, status = 403) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
}

async function requirePublicRequest(req) {
    if (process.env.SALES_MCP_PUBLIC_ENABLED !== 'true') {
        throw publicError('MCP_PUBLIC_DISABLED', 'Public Sales MCP transport is disabled');
    }

    let credential;
    try {
        credential = await machineCredentials.resolveCredential(bearerToken(req), {
            surface: machineCredentials.SURFACES.SALES_MCP_PUBLIC,
            requiredScope: machineCredentials.ACCESS_SCOPES.SALES_MCP_PUBLIC,
        });
    } catch (error) {
        if (error instanceof machineCredentials.MachineCredentialError) {
            const code = error.status === 401 ? 'MCP_PUBLIC_UNAUTHORIZED' : error.code;
            throw publicError(code, 'Sales MCP credential was rejected', error.status);
        }
        throw publicError('MACHINE_CREDENTIAL_UNAVAILABLE', 'Sales MCP authentication is unavailable', 503);
    }

    let liveAuthz;
    try {
        liveAuthz = await authorizationService.resolveCompanyUserAuthz(
            credential.companyId,
            credential.actorUserId
        );
    } catch (error) {
        if (error instanceof authorizationService.CompanyUserAuthzError) {
            throw publicError(error.code, 'Sales MCP actor access is inactive', error.httpStatus || 403);
        }
        throw publicError('MCP_AUTHZ_UNAVAILABLE', 'Sales MCP authorization is unavailable', 503);
    }

    const credentialScopes = new Set(credential.scopes);
    const effectivePermissions = (liveAuthz.permissions || [])
        .filter((permission) => credentialScopes.has(permission));

    return buildLivePublicContext({
        credential,
        liveAuthz,
        permissions: effectivePermissions,
        ip: req.ip,
        requestId: req.requestId || req.traceId || null,
    });
}

function buildLivePublicContext({ credential, liveAuthz, permissions, ip, requestId }) {
    return {
        requestId,
        traceId: requestId,
        ip,
        companyFilter: { company_id: credential.companyId },
        user: {
            email: liveAuthz.owner_email,
            name: liveAuthz.owner_display_name,
            crmUser: { id: liveAuthz.owner_user_id },
        },
        authz: {
            permissions,
            credentialScopes: credential.scopes,
            company: liveAuthz.company,
            membership: liveAuthz.membership,
            role_key: liveAuthz.role_key,
            scopes: liveAuthz.scopes,
        },
        machineCredential: credential,
    };
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
            permissions: [
                ...SALES_READ_PERMISSIONS,
                ...(writeEnabled ? ['sales.crm.write'] : []),
            ],
            company: { id: companyId, status: 'active', timezone: timezone || 'America/New_York' },
        },
    };
}

function applyContext(req, context) {
    req.companyFilter = context.companyFilter;
    req.user = context.user;
    req.authz = context.authz;
    req.machineCredential = context.machineCredential || null;
    req.requestId = req.requestId || context.requestId;
    return req;
}

module.exports = {
    requirePublicRequest,
    requireStdioContext,
    applyContext,
    buildLivePublicContext,
};
