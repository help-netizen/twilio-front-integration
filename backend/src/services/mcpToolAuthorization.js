'use strict';

const mcpResponse = require('./crmMcpResponse');
const {
    READ_TOOL_PERMISSIONS,
    WRITE_TOOL_PERMISSIONS,
    SEND_TOOL_PERMISSIONS,
} = require('./chatgptMcpPermissions');

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

function avatarToolTier(tool) {
    if (Object.prototype.hasOwnProperty.call(READ_TOOL_PERMISSIONS, tool?.name)) return 'read';
    if (Object.prototype.hasOwnProperty.call(WRITE_TOOL_PERMISSIONS, tool?.name)) return 'write';
    if (Object.prototype.hasOwnProperty.call(SEND_TOOL_PERMISSIONS, tool?.name)) return 'send';
    return null;
}

function avatarBusinessPermissions(tool, args = null) {
    if (!tool?.name) return null;
    if (tool.name === 'svc.list_entity_tasks') {
        if (!args) return { every: ['tasks.view'], any: ['jobs.view', 'leads.view'] };
        if (args.parent_type === 'job') return { every: ['tasks.view', 'jobs.view'], any: [] };
        if (args.parent_type === 'lead') return { every: ['tasks.view', 'leads.view'], any: [] };
        return null;
    }
    if (tool.name === 'svc.add_note') {
        if (!args) return { every: [], any: ['jobs.edit', 'leads.edit', 'contacts.edit'] };
        const permissionByParent = {
            job: 'jobs.edit',
            lead: 'leads.edit',
            contact: 'contacts.edit',
        };
        const permission = permissionByParent[args.parent_type];
        return permission ? { every: [permission], any: [] } : null;
    }
    const required = READ_TOOL_PERMISSIONS[tool.name]
        || WRITE_TOOL_PERMISSIONS[tool.name]
        || SEND_TOOL_PERMISSIONS[tool.name];
    return required ? { every: required, any: [] } : null;
}

function avatarTierEnabled(tool, ownerAuthz = {}) {
    const tier = avatarToolTier(tool);
    if (tier === 'read') return true;
    if (tier === 'write') return ownerAuthz.writes_enabled === true;
    if (tier === 'send') return ownerAuthz.sends_enabled === true;
    return false;
}

function canInvokeAvatar(tool, ownerAuthz = {}, oauthScopes = [], args = null) {
    const required = avatarBusinessPermissions(tool, args);
    if (!required || !avatarTierEnabled(tool, ownerAuthz)) return false;
    const granted = new Set(Array.isArray(ownerAuthz.owner_permissions)
        ? ownerAuthz.owner_permissions
        : []);
    return required.every.every((permission) => granted.has(permission))
        && (required.any.length === 0 || required.any.some((permission) => granted.has(permission)))
        && hasRequiredOAuthScopes(tool, oauthScopes);
}

function filterAvatarTools(tools, ownerAuthz = {}, oauthScopes = []) {
    return (tools || []).filter((tool) => canInvokeAvatar(tool, ownerAuthz, oauthScopes));
}

function requireAvatarToolAccess(tool, ownerAuthz = {}, oauthScopes = [], args = null) {
    if (canInvokeAvatar(tool, ownerAuthz, oauthScopes, args)) return;
    const required = avatarBusinessPermissions(tool, args);
    throw mcpResponse.mcpError('access_denied', 'Insufficient permission for MCP tool', {
        tool: tool?.name || null,
        required_permissions: required
            ? [...required.every, ...required.any]
            : [],
        required_oauth_scopes: requiredOAuthScopes(tool),
        reason: required
            ? (avatarTierEnabled(tool, ownerAuthz)
                ? (hasRequiredOAuthScopes(tool, oauthScopes)
                    ? 'OWNER_PERMISSION_REQUIRED'
                    : 'OAUTH_SCOPE_REQUIRED')
                : 'OWNER_TIER_REQUIRED')
            : 'TOOL_PERMISSION_UNMAPPED',
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
    avatarBusinessPermissions,
    avatarTierEnabled,
    canInvoke,
    canInvokeAvatar,
    filterAvatarTools,
    filterTools,
    hasRequiredOAuthScopes,
    requireAvatarToolAccess,
    requireToolAccess,
    requiredOAuthScopes,
    requiredPermissions,
    sanitizeArguments,
};
