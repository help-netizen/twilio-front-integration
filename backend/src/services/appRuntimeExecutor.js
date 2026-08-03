'use strict';

const authorizationService = require('./authorizationService');
const readService = require('./chatgptMcpReadService');
const taskService = require('./appRuntimeTaskService');
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

function requireBusinessPermission(authz, permission) {
    const permissions = new Set(authz?.permissions || []);
    if (!permissions.has(permission)) {
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
    const permissions = new Set(authz?.permissions || []);
    const effectiveTools = consentedTools.filter(toolName => (
        permissions.has(catalog.requireTool(toolName).businessPermission)
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
    requireBusinessPermission(authz, tool.businessPermission);
    if (tool.kind === 'write' && tool.handler === 'createTask') {
        return taskService.createTask(context, args);
    }
    return readService.execute(tool.handler, buildReadContext(context, authz), args);
}

module.exports = {
    resolveLiveAuthorization,
    requireToolConsent,
    requireBusinessPermission,
    requireExecutionAuthorization,
    buildReadContext,
    execute,
};
