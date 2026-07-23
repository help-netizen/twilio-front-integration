'use strict';

const mcpResponse = require('./crmMcpResponse');

function requiredPermissions(tool) {
    if (!tool) return [];
    const declared = Array.isArray(tool.requiredPermissions)
        ? tool.requiredPermissions
        : [tool.requiredPermission];
    return [...new Set(declared.filter((permission) => (
        typeof permission === 'string' && permission.trim().length > 0
    )))];
}

function canInvoke(tool, permissions = []) {
    const required = requiredPermissions(tool);
    if (required.length === 0) return false;
    const granted = new Set(Array.isArray(permissions) ? permissions : []);
    return required.every((permission) => granted.has(permission));
}

function requiredOAuthScopes(tool) {
    if (!tool) return [];
    const declared = Array.isArray(tool.requiredOAuthScopes)
        ? tool.requiredOAuthScopes
        : [tool.requiredOAuthScope];
    return [...new Set(declared.filter((scope) => (
        typeof scope === 'string' && scope.trim().length > 0
    )))];
}

function hasRequiredOAuthScopes(tool, oauthScopes = []) {
    const required = requiredOAuthScopes(tool);
    if (required.length === 0) return true;
    const granted = new Set(Array.isArray(oauthScopes) ? oauthScopes : []);
    return required.every((scope) => granted.has(scope));
}

function filterTools(tools, permissions = [], oauthScopes = []) {
    return (tools || []).filter((tool) => (
        canInvoke(tool, permissions) && hasRequiredOAuthScopes(tool, oauthScopes)
    ));
}

function requireToolAccess(tool, permissions = [], oauthScopes = []) {
    const permissionAllowed = canInvoke(tool, permissions);
    const scopeAllowed = hasRequiredOAuthScopes(tool, oauthScopes);
    if (permissionAllowed && scopeAllowed) return;
    const required = requiredPermissions(tool);
    const scopes = requiredOAuthScopes(tool);
    throw mcpResponse.mcpError('access_denied', 'Insufficient permission for MCP tool', {
        tool: tool?.name || null,
        required_permissions: required,
        required_oauth_scopes: scopes,
        reason: required.length === 0
            ? 'TOOL_PERMISSION_UNMAPPED'
            : (permissionAllowed ? 'OAUTH_SCOPE_REQUIRED' : 'TOOL_PERMISSION_REQUIRED'),
    });
}

function sanitizeArguments(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
    const sanitized = { ...args };
    delete sanitized.company_id;
    delete sanitized.companyId;
    return sanitized;
}

module.exports = {
    canInvoke,
    filterTools,
    hasRequiredOAuthScopes,
    requireToolAccess,
    requiredOAuthScopes,
    requiredPermissions,
    sanitizeArguments,
};
