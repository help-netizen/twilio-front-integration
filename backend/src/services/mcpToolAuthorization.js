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

function filterTools(tools, permissions = []) {
    return (tools || []).filter((tool) => canInvoke(tool, permissions));
}

function requireToolAccess(tool, permissions = []) {
    if (canInvoke(tool, permissions)) return;
    const required = requiredPermissions(tool);
    throw mcpResponse.mcpError('access_denied', 'Insufficient permission for MCP tool', {
        tool: tool?.name || null,
        required_permissions: required,
        reason: required.length > 0 ? 'TOOL_PERMISSION_REQUIRED' : 'TOOL_PERMISSION_UNMAPPED',
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
    requireToolAccess,
    requiredPermissions,
    sanitizeArguments,
};
