'use strict';

/**
 * agentSkillsMcpExecutor — the service-CRM (`svc.*`) MCP executor.
 *
 * AGENT-SKILLS-001, AR-3 / spec §8 / architecture §4. MIRRORS
 * `crmMcpToolExecutor.js` but dispatches into the PROVIDER-NEUTRAL SKILL LAYER
 * (`agentSkills.runSkill`) instead of the sales services. It REUSES the two
 * genuinely-generic framework halves UNCHANGED:
 *   - `crmMcpSchemaValidator.validateArguments` (arg validation),
 *   - `crmMcpResponse` (`mcpError`, and — via the protocol/route — `mapError`
 *     + `sanitizeDetails`, so the sanitized-error contract is inherited, G6).
 *
 * Guarantees (P0):
 *   - **Tenant from context only.** `buildContext(req)` takes `companyId` from
 *     `req.companyFilter?.company_id` (authed route) or the env-bound public
 *     context — NEVER from the client payload/`arguments`.
 *   - **Composing write gates.** Legacy skills keep `service.crm.write` plus
 *     their L0/L1/L2 verification. ChatGPT dispatcher writes require their
 *     entity + exact grants, OAuth write scope, explicit confirmation, and a
 *     same-transaction live-binding/grant recheck.
 *   - **Thin dispatch.** Legacy tools funnel into `runSkill`; ChatGPT dispatcher
 *     descriptors funnel into dedicated company-required read/write services.
 *   - **Sanitized errors.** `runSkill` itself never throws internals (it returns
 *     a safe-fallback / soft-refusal shape); framework/validation errors flow
 *     through `crmMcpResponse` sanitization on the transport.
 *
 * The sales executor (`crmMcpToolExecutor.js`) is UNTOUCHED — additive only.
 */

const crypto = require('crypto');
const db = require('../db/connection');
const registry = require('./agentSkillsMcpRegistry');
const mcpResponse = require('./crmMcpResponse');
const mcpToolAuthorization = require('./mcpToolAuthorization');
const { validateArguments } = require('./crmMcpSchemaValidator');
const agentSkills = require('./agentSkills');
const chatgptMcpReadService = require('./chatgptMcpReadService');
const chatgptMcpIdentityService = require('./chatgptMcpIdentityService');
const chatgptMcpWriteService = require('./chatgptMcpWriteService');

const WRITE_PERMISSION = registry.SERVICE_WRITE_PERMISSION;
const S2B_TOOL_NAMES = new Set([
    'svc.create_estimate',
    'svc.update_estimate',
    'svc.create_invoice',
    'svc.update_invoice',
]);

function auditStage(tool) {
    if (tool.kind !== 'write') return 'S1';
    return S2B_TOOL_NAMES.has(tool.name) ? 'S2b' : 'S2a';
}

function ensureRequestId(req) {
    const existing = req.requestId || req.traceId || null;
    if (existing) return existing;
    const generated = `svc-mcp-${crypto.randomUUID()}`;
    req.requestId = generated;
    req.traceId = generated;
    return generated;
}

/**
 * Build the server-trusted MCP context. `companyId` comes from
 * `req.companyFilter?.company_id` (context/env), never the client — identical
 * rule to the sales executor.
 * @param {Object} req Express-like request (real, public, or stdio-shaped).
 * @returns {Object} Context object handed to the skill layer as `rawContext`.
 */
function buildContext(req) {
    const requestId = ensureRequestId(req);
    return {
        // Tenant scope — ONLY from context/env, never from the client payload.
        companyId: req.companyFilter?.company_id || null,
        actorId: req.user?.crmUser?.id || null,
        actorEmail: req.user?.email || null,
        actorIp: req.ip || null,
        requestId,
        companyTimezone: req.authz?.company?.timezone || null,
        source: 'Service CRM MCP',
        createdBy: req.user ? 'user' : 'system',
        permissions: req.authz?.permissions || [],
        oauthScopes: req.authz?.oauthScopes || [],
        bindingId: req.chatgptMcpBinding?.id || null,
        authorizerId: req.chatgptMcpBinding?.authorizerId || req.user?.oauthAuthorizerId || null,
    };
}

function contextWithConfirmation(context, confirmation) {
    if (!confirmation) return context;
    return {
        ...context,
        confirmation: {
            confirmationId: confirmation.confirmation_id || null,
            reason: confirmation.reason || null,
        },
    };
}

function requireCompanyContext(context) {
    if (!context.companyId) {
        throw mcpResponse.mcpError('access_denied', 'Company context required', {
            reason: 'TENANT_CONTEXT_REQUIRED',
        });
    }
}

/**
 * Confirmation gate shared by all writes. Legacy skills additionally require
 * service.crm.write; bound dispatcher writes instead use the exact deny-by-
 * default grants checked before and inside their transaction.
 * @param {Object} context Built context (carries `permissions`).
 * @param {Object} tool The resolved tool descriptor.
 * @param {Object|null} confirmation The client-supplied confirmation envelope.
 */
function requireWriteAccess(context, tool, confirmation) {
    if (tool.kind !== 'write') return;
    // Legacy caller-verification skills keep their framework permission. The
    // bound dispatcher surface instead uses its deny-by-default entity + exact
    // grants and the S2 consent bundle.
    if (!tool.handler && !context.permissions.includes(WRITE_PERMISSION)) {
        throw mcpResponse.mcpError('access_denied', 'Insufficient service CRM write permission', {
            required_permission: WRITE_PERMISSION,
        });
    }
    if (!confirmation?.confirmed || !confirmation?.confirmation_id) {
        throw mcpResponse.mcpError('confirmation_required', 'Write tool requires explicit confirmation', {
            required: ['confirmed', 'confirmation_id'],
        });
    }
}

/**
 * Execute a `svc.*` tool call. Same shape as `crmMcpToolExecutor.execute`:
 * resolve tool → build context → require tenant → require the tool's business
 * permission → strip caller tenant selectors → validate args (reused validator)
 * → require write access (framework outer gate) → dispatch.
 * @param {Object} req Express-like request.
 * @param {string} toolName MCP tool name (`svc.*`).
 * @param {Object} [toolArguments] Client arguments (identity block + skill fields).
 * @param {Object|null} [confirmation] Write-confirmation envelope.
 * @returns {Promise<Object>} The skill layer's provider-neutral result.
 */
async function execute(req, toolName, toolArguments = {}, confirmation = null) {
    const tool = registry.getTool(toolName);
    if (!tool) {
        throw mcpResponse.mcpError('unsupported_tool', `Unsupported service CRM MCP tool: ${toolName || '(missing)'}`, {
            tool: toolName || null,
        });
    }
    const isBoundAgent = req.user?.kind === 'agent' && Boolean(req.chatgptMcpBinding?.id);
    if (tool.handler && !isBoundAgent) {
        throw mcpResponse.mcpError('access_denied', 'Dispatcher tool requires a bound AI identity', {
            tool: toolName,
            reason: 'AI_IDENTITY_REQUIRED',
        });
    }
    if (isBoundAgent && !tool.handler) {
        throw mcpResponse.mcpError('access_denied', 'Tool is not available to this AI identity', {
            tool: toolName,
            reason: 'AI_TOOL_NOT_GRANTED',
        });
    }
    const context = buildContext(req);
    requireCompanyContext(context);
    const executionContext = contextWithConfirmation(context, confirmation);
    try {
        mcpToolAuthorization.requireToolAccess(tool, context.permissions, context.oauthScopes);
        const sanitizedArguments = mcpToolAuthorization.sanitizeArguments(toolArguments);
        validateArguments(tool, sanitizedArguments);
        requireWriteAccess(context, tool, confirmation);
        const result = await dispatch(tool, executionContext, sanitizedArguments);
        if (tool.handler && executionContext.bindingId) {
            try {
                await chatgptMcpIdentityService.recordInvocation(executionContext, {
                    toolName,
                    requestId: executionContext.requestId,
                    status: 'succeeded',
                    confirmationClass: tool.confirmationClass || (tool.kind === 'write' ? 'W' : 'R'),
                    argumentHash: tool.kind === 'write'
                        ? chatgptMcpWriteService.argumentHash(sanitizedArguments)
                        : null,
                    safeMetadata: { kind: tool.kind },
                    stage: auditStage(tool),
                });
            } catch (auditErr) {
                // The domain transaction already committed. Never turn a
                // successful write into a retryable client failure solely
                // because the append-only audit sink is unavailable.
                console.error('[ChatGPT MCP] failed to record successful invocation:', auditErr.message);
            }
        }
        return result;
    } catch (err) {
        if (tool.handler && executionContext.bindingId) {
            try {
                await chatgptMcpIdentityService.recordInvocation(executionContext, {
                    toolName,
                    requestId: executionContext.requestId,
                    status: err?.mcpCode === 'access_denied'
                        || err?.code === 'NOT_FOUND'
                        || [403, 404].includes(err?.httpStatus)
                        ? 'denied'
                        : 'failed',
                    safeMetadata: { error_code: err?.code || 'INTERNAL' },
                    confirmationClass: tool.confirmationClass || (tool.kind === 'write' ? 'W' : 'R'),
                    argumentHash: tool.kind === 'write'
                        ? chatgptMcpWriteService.argumentHash(
                            mcpToolAuthorization.sanitizeArguments(toolArguments)
                        )
                        : null,
                    stage: auditStage(tool),
                });
            } catch (auditErr) {
                console.error('[ChatGPT MCP] failed to record denied/failed invocation:', auditErr.message);
            }
        }
        throw err;
    }
}

/**
 * Dispatch legacy skills through the VAPI-neutral skill layer and bound
 * ChatGPT descriptors through their dedicated data services.
 * @param {Object} tool The resolved tool descriptor (carries `skill`).
 * @param {Object} context Built context (used as `rawContext` — logging only).
 * @param {Object} args Sanitized client arguments passed through as skill `input`.
 * @returns {Promise<Object>} The skill result (already safe-shaped by `runSkill`).
 */
async function dispatch(tool, context, args) {
    if (tool.handler) {
        if (tool.kind === 'write') {
            return dispatchDispatcherWrite(tool, context, args);
        }
        return chatgptMcpReadService.execute(tool.handler, context.companyId, args);
    }
    return agentSkills.runSkill(tool.skill, context.companyId, context, args);
}

async function dispatchDispatcherWrite(tool, context, args, { beforeLiveRecheck = null } = {}) {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        if (beforeLiveRecheck) await beforeLiveRecheck(client);
        const live = await chatgptMcpIdentityService.requireLiveBinding({
            bindingId: context.bindingId,
            companyId: context.companyId,
            agentUserId: context.actorId,
            authorizerId: context.authorizerId,
        }, client);
        // Permission consent is re-derived under the same binding lock. OAuth
        // scopes remain signature-verified token claims and cannot be upgraded
        // by this transaction.
        mcpToolAuthorization.requireToolAccess(tool, live.permissions, context.oauthScopes);
        const result = await chatgptMcpWriteService.execute(
            tool.handler,
            tool.name,
            context,
            args,
            client
        );
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

module.exports = {
    WRITE_PERMISSION,
    buildContext,
    execute,
    _dispatchDispatcherWrite: dispatchDispatcherWrite,
};
