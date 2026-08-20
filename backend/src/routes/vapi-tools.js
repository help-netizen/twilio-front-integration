/**
 * VAPI Tool Call Handler — public endpoint, secured by x-vapi-secret header
 *
 * POST /api/vapi-tools
 *
 * THIN ADAPTER (AGENT-SKILLS-001 T4). This file is transport-only: it validates
 * the VAPI secret, unwraps the VAPI tool-calls envelope, and dispatches each tool
 * call GENERICALLY into the provider-neutral skill layer via `agentSkills.runSkill`.
 * It contains ZERO business logic — no CRM queries, no verification decisions, no
 * Google Geocoding, no slot-engine composition (all of that now lives in
 * `backend/src/services/agentSkills/skills/*`, behind the single choke-point).
 *
 * Because dispatch is generic, EVERY registered skill is exposed here — the 5
 * legacy tools (checkServiceArea / validateAddress /
 * recommendSlots / createLead) AND the new existing-customer skills — with the
 * skill name mapping 1:1 to `toolCall.function.name`.
 *
 * VAPI sends:
 *   { message: { type: "tool-calls",
 *       toolCallList: [{ id, function: { name, arguments } }],
 *       call: { customer: { number }, ... } } }
 *
 * Response format (VAPI expects):
 *   { results: [{ toolCallId, result }] }   // result = JSON.stringify(skillOutput)
 *
 * Verification, graceful degradation, and unknown-tool handling all live in the
 * skill layer: `runSkill` NEVER throws and NEVER leaks internals — an unknown or
 * errored tool returns a speech-safe SAFE_FALLBACK. So this adapter never surfaces
 * `err.message` / stacks / SQL / PII to the caller (gate G6).
 */
const express = require('express');
const router = express.Router();
const agentSkills = require('../services/agentSkills');
const resultShapes = require('../services/agentSkills/resultShapes');
const vapiCallContextService = require('../services/vapiCallContextService');
const machineCredentials = require('../services/machineCredentialService');
const inboundVoiceRecoveryService = require('../services/inboundVoiceRecoveryService');
const vapiRecommendSlotsAuditService = require('../services/vapiRecommendSlotsAuditService');
const { TRANSPORT_FIELD: INBOUND_BOOKING_GUARD_FIELD } = require('../services/inboundSlotBookingGuardService');

// The 4 relocated read-only legacy L0 tools keep byte-identical behavior (AC-11).
// createLead is deliberately NOT in this set: caller identity is server context,
// and the model consistently sends `{}` for identity fields. It therefore gets
// the same silent caller-ID fallback as identifyCaller/getCustomerOverview.
const LEGACY_TOOLS = new Set([
    'checkServiceArea',
    'validateAddress',
    'recommendSlots',
]);

// These tools cannot do their intended work from an empty model argument object.
// The diagnostic is intentionally transport-level: it tells operators whether
// Vapi sent literal `{}` or sent a non-empty string that failed JSON parsing.
// Never log parsed arguments wholesale; the raw preview is emitted only on an
// empty/invalid parse and is capped because malformed input can contain PII.
const TOOLS_EXPECTING_ARGUMENTS = new Set([
    'checkServiceArea',
    'validateAddress',
    'recommendSlots',
    'createLead',
    'recordLeadDisposition',
]);

function parseToolArguments(rawArguments) {
    let parsed;
    let state = null;
    try {
        parsed = typeof rawArguments === 'string'
            ? JSON.parse(rawArguments)
            : (rawArguments || {});
    } catch (_error) {
        parsed = {};
        state = 'parse_error';
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        parsed = {};
        state = state || 'invalid_shape';
    } else if (Object.keys(parsed).length === 0) {
        state = state || (rawArguments == null ? 'missing' : 'empty_object');
    }

    return { args: parsed, state };
}

function logEmptyRequiredArguments(name, rawArguments, state) {
    if (!TOOLS_EXPECTING_ARGUMENTS.has(name) || !state) return;
    let raw = '';
    if (typeof rawArguments === 'string') raw = rawArguments;
    else {
        try {
            raw = JSON.stringify(rawArguments ?? null);
        } catch (_error) {
            raw = '[unserializable]';
        }
    }
    console.warn('[vapi-tools] required tool arguments empty', {
        tool: name,
        argumentState: state,
        rawLength: raw.length,
        rawPrefix: raw.slice(0, 200),
    });
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

async function vapiSecretAuth(req, res, next) {
    try {
        const credential = await machineCredentials.resolveCredential(
            req.headers['x-vapi-secret'],
            {
                surface: machineCredentials.SURFACES.VAPI_TOOLS,
                requiredScope: machineCredentials.ACCESS_SCOPES.VAPI_TOOLS,
            }
        );
        req.machineCredential = credential;
        req.vapiCompanyId = credential.companyId;
        next();
    } catch (error) {
        const status = error instanceof machineCredentials.MachineCredentialError
            ? error.status
            : 503;
        return res.status(status).json({
            error: status === 403 ? 'Forbidden' : (status === 503 ? 'Authentication unavailable' : 'Unauthorized'),
            code: error.code || 'MACHINE_CREDENTIAL_UNAVAILABLE',
        });
    }
}

/**
 * Build the per-call skill input from the tool arguments, threading the VAPI
 * caller-ID (`message.call.customer.number`) in as the SILENT phone — a FALLBACK
 * only: anything the assistant re-sent in `args` wins (`{ phone: callerId, ...args }`).
 *
 * The silent phone is threaded for identity/verification skills AND createLead.
 * The 4 read-only legacy L0 tools remain excluded so their observable output stays
 * byte-identical to the pre-refactor handlers.
 *
 * OUTBOUND-PARTS-CALL-001: Vapi echoes pre-bound identity in
 * `call.assistantOverrides.variableValues`, but the public request body is not an
 * authorization source. The route repairs identity from the correlated attempt
 * and passes it as trustedValues, which wins over both model args and echoed
 * variableValues. Inbound Sara calls use the secret-bound transport company.
 *
 * @param {string} name The tool/skill name.
 * @param {object} args Parsed tool arguments.
 * @param {object} [call] The VAPI call metadata (message.call).
 * @returns {object} The skill input (identity block + skill-specific fields).
 */
function buildSkillInput(name, args, call, trustedValues = null) {
    // Echoed outbound values are body data, not authorization. Correlated
    // trustedValues are spread last and repair every ownership field.
    const variableValues =
        (call && call.assistantOverrides && call.assistantOverrides.variableValues) || null;

    const callerNumber = call && call.customer && call.customer.number;
    if (LEGACY_TOOLS.has(name) || !callerNumber) {
        // Legacy L0 tools stay byte-identical except for the additive trusted
        // tenant/subject values supplied by the transport.
        return trustedValues
            ? { ...args, ...(variableValues || {}), ...trustedValues }
            : (variableValues ? { ...args, ...variableValues } : args);
    }
    // Silent caller-ID is a fallback; correlated trustedValues are authoritative.
    return {
        phone: callerNumber,
        ...args,
        ...(variableValues || {}),
        ...(trustedValues || {}),
    };
}

// ─── Router ───────────────────────────────────────────────────────────────────

router.post('/', vapiSecretAuth, async (req, res) => {
    try {
        const message = req.body?.message;
        if (!message || message.type !== 'tool-calls') {
            // The live inbound assistant historically uses this endpoint as its
            // top-level server URL. Keep end-of-call recovery here as well as on
            // /api/vapi/call-status: provider delivery can overlap, and the
            // provider-call key makes that overlap exactly-once. This side path
            // must never change the provider webhook response.
            if (message?.type === 'end-of-call-report') {
                try {
                    await vapiRecommendSlotsAuditService.recordEndOfCall({
                        companyId: req.machineCredential.companyId,
                        message,
                    });
                } catch (auditError) {
                    console.error('[vapi-tools] recommendSlots transcript audit unavailable (non-fatal)', {
                        companyId: req.machineCredential.companyId,
                        providerCallId: message.call?.id || null,
                        code: auditError?.code || 'VAPI_RECOMMEND_AUDIT_UNAVAILABLE',
                    });
                }
                try {
                    await inboundVoiceRecoveryService.handleEndOfCall({
                        companyId: req.machineCredential.companyId,
                        message,
                    });
                } catch (recoveryError) {
                    console.error('[vapi-tools] inbound recovery unavailable (non-fatal)', {
                        companyId: req.machineCredential.companyId,
                        providerCallId: message.call?.id || null,
                        code: recoveryError?.code || 'VOICE_RECOVERY_UNAVAILABLE',
                    });
                }
            }
            return res.json({});
        }

        const toolCallList = message.toolCallList || [];
        const results = [];
        const callContext = await vapiCallContextService.resolve(message.call);
        const transportCompanyId = req.vapiCompanyId;
        const outboundClaimed = vapiCallContextService.looksLikeOutbound(message.call);

        if (
            callContext.ambiguous
            || (outboundClaimed && !callContext.matched)
            || (callContext.matched && callContext.companyId !== transportCompanyId)
        ) {
            const refusal = resultShapes.safeFallback();
            return res.json({
                results: toolCallList.map((toolCall) => ({
                    toolCallId: toolCall.id,
                    result: JSON.stringify(refusal),
                })),
            });
        }

        for (const toolCall of toolCallList) {
            const name = toolCall.function?.name;
            const rawArguments = toolCall.function?.arguments;
            const parsedArguments = parseToolArguments(rawArguments);
            const args = parsedArguments.args;
            logEmptyRequiredArguments(name, rawArguments, parsedArguments.state);

            // Generic dispatch — the SINGLE choke-point. No if/else per tool, no
            // business logic here. `runSkill` gates + runs the skill and degrades
            // gracefully (unknown tool / any throw → SAFE_FALLBACK); it never
            // throws and never leaks internals, so no per-tool catch is needed.
            const input = buildSkillInput(
                name,
                args,
                message.call,
                {
                    ...(callContext.matched ? callContext.values : {}),
                    companyId: transportCompanyId,
                    ...(!outboundClaimed ? {
                        [INBOUND_BOOKING_GUARD_FIELD]: {
                            required: true,
                            providerCallId: message.call?.id || null,
                        },
                    } : {}),
                },
            );
            const result = await agentSkills.runSkill(
                name,
                transportCompanyId,
                { source: 'vapi', call: message.call },
                input,
            );

            if (name === 'recommendSlots') {
                try {
                    await vapiRecommendSlotsAuditService.recordInvocation({
                        companyId: transportCompanyId,
                        providerCallId: message.call?.id,
                        toolCallId: toolCall.id,
                        arguments: args,
                        result,
                        call: message.call,
                        inbound: !outboundClaimed,
                    });
                } catch (auditError) {
                    console.error('[vapi-tools] recommendSlots audit unavailable (non-fatal)', {
                        companyId: transportCompanyId,
                        providerCallId: message.call?.id || null,
                        toolCallId: toolCall.id || null,
                        code: auditError?.code || 'VAPI_RECOMMEND_AUDIT_UNAVAILABLE',
                    });
                }
            }

            // A lead born on this call adopts the callback task the slot-unavailable
            // path had to open before it existed — otherwise the dispatcher's task
            // hangs on the conversation instead of on the request to act upon.
            if (name === 'createLead' && result && result.leadId) {
                try {
                    await vapiRecommendSlotsAuditService.attachLeadToCallbackTask({
                        companyId: transportCompanyId,
                        providerCallId: message.call?.id,
                        leadRef: result.leadId,
                    });
                } catch (attachError) {
                    console.error('[vapi-tools] callback task lead attach unavailable (non-fatal)', {
                        companyId: transportCompanyId,
                        providerCallId: message.call?.id || null,
                        code: attachError?.code || 'VAPI_CALLBACK_TASK_ATTACH_UNAVAILABLE',
                    });
                }
            }

            results.push({
                toolCallId: toolCall.id,
                result: JSON.stringify(result),
            });
        }

        res.json({ results });
    } catch (err) {
        // Thin backstop: the skill layer already degrades gracefully per tool, so
        // this only fires on a malformed-envelope / framework fault. Stay
        // well-formed and NEVER surface err.message / internals to the caller.
        console.error('[vapi-tools] Handler error:', err && err.message ? err.message : 'unknown error');
        res.status(500).json({ error: 'vapi tools handler error' });
    }
});

module.exports = router;
// Exported additively for unit tests (variableValues anti-spoof precedence). The
// router remains the default export; this does not alter the mount behavior.
module.exports.buildSkillInput = buildSkillInput;
module.exports.parseToolArguments = parseToolArguments;
