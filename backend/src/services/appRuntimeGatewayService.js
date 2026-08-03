'use strict';

const executor = require('./appRuntimeExecutor');
const tokenService = require('./appRuntimeTokenService');
const rateLimit = require('./appRuntimeRateLimit');
const auditService = require('./appRuntimeAuditService');
const dataService = require('./appDataService');
const catalog = require('./appRuntimeToolCatalog');
const maskingService = require('./pulseMaskingService');
const { AppRuntimeError, appRuntimeError } = require('./appRuntimeErrors');

function normalizeError(error) {
    if (error instanceof AppRuntimeError) return error;
    if (error?.code === 'NOT_FOUND' || error?.httpStatus === 404) {
        return appRuntimeError('NOT_FOUND', 'Resource not found.', 404);
    }
    return appRuntimeError('INTERNAL_ERROR', 'App runtime request failed.', 500);
}

function outcomeFor(error) {
    if (!error) return 'succeeded';
    return error.httpStatus >= 500 ? 'failed' : 'denied';
}

function installRequestContext(req, context, authz) {
    req.companyFilter = { company_id: context.company_id };
    req.user = {
        kind: 'agent',
        email: context.agent_email,
        name: context.agent_full_name,
        crmUser: {
            id: context.agent_user_id,
            company_id: context.company_id,
            email: context.agent_email,
            full_name: context.agent_full_name,
            kind: 'agent',
            status: 'active',
        },
    };
    req.authz = {
        company: {
            id: context.company_id,
            name: context.company_name,
            status: 'active',
            timezone: context.company_timezone,
        },
        membership: authz.membership,
        permissions: authz.permissions || [],
        scopes: authz.scopes || {},
    };
}

async function authorizeExecution(req, sourceSha256) {
    const context = req.appRuntimeContext;
    let failure = null;
    let result;
    try {
        const authz = await executor.resolveLiveAuthorization(context);
        executor.requireExecutionAuthorization(context, authz);
        result = await tokenService.authorizeRunExecution(context, sourceSha256);
    } catch (error) {
        failure = normalizeError(error);
    }

    try {
        await auditService.recordRunAuthorization(context, {
            outcome: outcomeFor(failure),
            errorCode: failure?.code || null,
            httpStatus: failure?.httpStatus || 200,
            requestId: req.requestId,
        });
    } catch (_auditError) {
        throw appRuntimeError(
            'AUDIT_UNAVAILABLE',
            'App runtime audit is unavailable.',
            503
        );
    }

    if (failure) throw failure;
    return result;
}

async function execute(req, toolName, args) {
    const context = req.appRuntimeContext;
    let authz;
    let callOrdinal = Number(context.gateway_calls_used) + 1;
    let result;
    let failure = null;
    try {
        authz = await executor.resolveLiveAuthorization(context);
        installRequestContext(req, context, authz);

        const rate = rateLimit.consumeInstallation(context.installation_id);
        if (!rate.allowed) {
            throw appRuntimeError('RATE_LIMITED', 'Too many app runtime requests.', 429, {
                retryAfterSeconds: rate.retryAfterSeconds,
                callOrdinal,
            });
        }

        callOrdinal = await tokenService.consumeRunCall(context);
        if (catalog.getTool(toolName)?.kind === 'write') {
            await tokenService.consumeRunWriteCall(context);
        }
        result = await executor.execute(context, authz, toolName, args);
        const maskViewer = await maskingService.getMaskViewer(req);
        result = maskingService.redactPulsePayload(result, maskViewer);
    } catch (error) {
        failure = normalizeError(error);
        callOrdinal = Number(failure.details?.callOrdinal || callOrdinal);
    }

    try {
        await auditService.recordToolCall(context, {
            toolName,
            outcome: outcomeFor(failure),
            errorCode: failure?.code || null,
            httpStatus: failure?.httpStatus || 200,
            callOrdinal,
            requestId: req.requestId,
        });
    } catch (_auditError) {
        throw appRuntimeError(
            'AUDIT_UNAVAILABLE',
            'App runtime audit is unavailable.',
            503
        );
    }

    if (failure) throw failure;
    return result;
}

async function executeData(req, operation, collection, args) {
    const context = req.appRuntimeContext;
    try {
        const rate = rateLimit.consumeInstallation(context.installation_id);
        if (!rate.allowed) {
            throw appRuntimeError('RATE_LIMITED', 'Too many app runtime requests.', 429, {
                retryAfterSeconds: rate.retryAfterSeconds,
            });
        }
        await tokenService.consumeRunDataCall(context);
        if (operation === 'list') return dataService.list(context, collection, args);
        if (operation === 'upsert') return dataService.upsert(context, collection, args);
        if (operation === 'delete') return dataService.remove(context, collection, args);
        throw appRuntimeError('NOT_FOUND', 'Data operation not found.', 404);
    } catch (error) {
        throw normalizeError(error);
    }
}

module.exports = {
    normalizeError,
    installRequestContext,
    authorizeExecution,
    execute,
    executeData,
};
