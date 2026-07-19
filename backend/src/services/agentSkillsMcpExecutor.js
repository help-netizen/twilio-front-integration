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
 *   - **Two composing gates (spec §8.2).** The framework write-gate here
 *     (`requireWriteAccess`: `service.crm.write` permission + `confirmation.confirmed`
 *     + `confirmation_id`) is the OUTER gate. The skill layer's L0/L1/L2
 *     verification (re-derived from the DB every call inside `runSkill`) is the
 *     INNER gate. A `svc.*` write must satisfy BOTH — strictly stronger.
 *   - **Zero business logic.** Every tool call funnels into `runSkill`; there is
 *     no SQL, no service composition, no verification decision here.
 *   - **Sanitized errors.** `runSkill` itself never throws internals (it returns
 *     a safe-fallback / soft-refusal shape); framework/validation errors flow
 *     through `crmMcpResponse` sanitization on the transport.
 *
 * The sales executor (`crmMcpToolExecutor.js`) is UNTOUCHED — additive only.
 */

const crypto = require('crypto');
const registry = require('./agentSkillsMcpRegistry');
const mcpResponse = require('./crmMcpResponse');
const mcpToolAuthorization = require('./mcpToolAuthorization');
const { validateArguments } = require('./crmMcpSchemaValidator');
const agentSkills = require('./agentSkills');

const WRITE_PERMISSION = registry.SERVICE_WRITE_PERMISSION;

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
 * OUTER framework write-gate (spec §8.2). For write tools: require the
 * service-CRM write permission AND an explicit confirmation
 * (`confirmed` + `confirmation_id`). Reads pass through untouched. This does NOT
 * replace the skill layer's L2 gate — both must pass for a write.
 * @param {Object} context Built context (carries `permissions`).
 * @param {Object} tool The resolved tool descriptor.
 * @param {Object|null} confirmation The client-supplied confirmation envelope.
 */
function requireWriteAccess(context, tool, confirmation) {
    if (tool.kind !== 'write') return;
    if (!context.permissions.includes(WRITE_PERMISSION)) {
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
    const context = buildContext(req);
    requireCompanyContext(context);
    mcpToolAuthorization.requireToolAccess(tool, context.permissions);
    const sanitizedArguments = mcpToolAuthorization.sanitizeArguments(toolArguments);
    validateArguments(tool, sanitizedArguments);
    requireWriteAccess(context, tool, confirmation);
    return dispatch(tool, contextWithConfirmation(context, confirmation), sanitizedArguments);
}

/**
 * Hand off to the SAME skill layer as the VAPI adapter. There is exactly one
 * behavior here: `runSkill(skillFor(toolName), companyId, mcpContext, args)`.
 * The skill layer re-derives verification from the identity block inside `args`
 * (which mirrors §4 snake_case fields), so the INNER L0/L1/L2 gate runs
 * identically to the voice transport. No per-tool branching, no CRM logic.
 * @param {Object} tool The resolved tool descriptor (carries `skill`).
 * @param {Object} context Built context (used as `rawContext` — logging only).
 * @param {Object} args Sanitized client arguments passed through as skill `input`.
 * @returns {Promise<Object>} The skill result (already safe-shaped by `runSkill`).
 */
async function dispatch(tool, context, args) {
    return agentSkills.runSkill(tool.skill, context.companyId, context, args);
}

module.exports = {
    WRITE_PERMISSION,
    buildContext,
    execute,
};
