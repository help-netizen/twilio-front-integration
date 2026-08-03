'use strict';

const authorizationService = require('./authorizationService');
const readService = require('./chatgptMcpReadService');
const taskService = require('./appRuntimeTaskService');
const noteService = require('./appRuntimeNoteService');
const catalog = require('./appRuntimeToolCatalog');
const tokenService = require('./appRuntimeTokenService');
const requestValidator = require('./appRuntimeRequestValidator');
const { appRuntimeError } = require('./appRuntimeErrors');

async function resolveLiveAuthorization(context) {
    if (!context?.company_id || !context?.delegated_by_user_id) {
        throw appRuntimeError(
            'APP_RUNTIME_INACTIVE',
            'App runtime authorization is not active.',
            403
        );
    }
    try {
        return await authorizationService.resolveCompanyUserAuthz(
            context.company_id,
            context.delegated_by_user_id
        );
    } catch (_error) {
        throw appRuntimeError(
            'APP_RUNTIME_INACTIVE',
            'App runtime authorization is not active.',
            403
        );
    }
}

function requireToolConsent(context, toolName) {
    const consent = tokenService.parseConsent(context.installation_metadata);
    const allowedTools = new Set(context.allowed_tools || []);
    if (consent?.versionId !== String(context.version_id)
        || !consent.tools.has(toolName)
        || !allowedTools.has(toolName)) {
        throw appRuntimeError(
            'TOOL_NOT_CONSENTED',
            'Tool is not consented for this installation.',
            403
        );
    }
}

function permissionRule(tool, args = null) {
    const declared = tool?.businessPermissions;
    if (declared?.byParent && args?.parent_type) {
        return declared.byParent[args.parent_type] || null;
    }
    return declared || null;
}

function hasBusinessPermission(authz, tool, args = null) {
    const permissions = new Set(authz?.permissions || []);
    const rule = permissionRule(tool, args);
    if (!rule) return false;
    const every = Array.isArray(rule.every) ? rule.every : [];
    const any = Array.isArray(rule.any) ? rule.any : [];
    return every.every(permission => permissions.has(permission))
        && (any.length === 0 || any.some(permission => permissions.has(permission)));
}

function requireBusinessPermission(authz, tool, args = null) {
    if (!hasBusinessPermission(authz, tool, args)) {
        throw appRuntimeError('ACCESS_DENIED', 'Access denied.', 403);
    }
}

function requireExecutionAuthorization(context, authz) {
    const consent = tokenService.parseConsent(context.installation_metadata);
    const allowedTools = new Set(context.allowed_tools || []);
    const consentedTools = catalog.TOOL_NAMES.filter(toolName => (
        consent?.versionId === String(context.version_id)
        && consent.tools.has(toolName)
        && allowedTools.has(toolName)
    ));
    if (consentedTools.length === 0) {
        throw appRuntimeError(
            'TOOL_NOT_CONSENTED',
            'No app runtime tools are consented.',
            403
        );
    }
    const effectiveTools = consentedTools.filter(toolName => (
        hasBusinessPermission(authz, catalog.requireTool(toolName))
    ));
    if (effectiveTools.length === 0) {
        throw appRuntimeError('ACCESS_DENIED', 'Access denied.', 403);
    }
    return effectiveTools;
}

function buildReadContext(context, authz) {
    if (!context?.delegated_by_user_id) {
        throw appRuntimeError(
            'APP_RUNTIME_INACTIVE',
            'App runtime authorization is not active.',
            403
        );
    }
    return {
        appRuntime: true,
        companyId: context.company_id,
        companyTimezone: context.company_timezone,
        ownerUserId: context.delegated_by_user_id,
        ownerRoleKey: authz.role_key,
        ownerPermissions: authz.permissions || [],
        ownerScopes: authz.scopes || {},
    };
}

async function execute(context, authz, toolName, args) {
    requestValidator.rejectTenantSelectors(args);
    const tool = catalog.requireTool(toolName);
    requireToolConsent(context, toolName);
    requestValidator.validateArguments(tool, args);
    requireBusinessPermission(authz, tool, args);
    if (tool.kind === 'write' && tool.handler === 'createTask') {
        return taskService.createTask(context, args);
    }
    if (tool.kind === 'write' && tool.handler === 'addNote') {
        return noteService.addNote(context, args, {
            ownerUserId: context.delegated_by_user_id,
            ownerScopes: authz.scopes,
        });
    }
    return readService.execute(tool.handler, buildReadContext(context, authz), args);
}

module.exports = {
    resolveLiveAuthorization,
    requireToolConsent,
    hasBusinessPermission,
    requireBusinessPermission,
    requireExecutionAuthorization,
    buildReadContext,
    execute,
};
