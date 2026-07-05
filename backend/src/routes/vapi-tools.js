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
 * legacy tools (checkServiceArea / validateAddress / checkAvailability /
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

// Company is hardwired for the VAPI (voice) transport — never taken from the
// client payload. The authed MCP transport (contract B) supplies its own scope.
const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

// The 5 relocated legacy L0 tools keep byte-identical behavior (AC-11): they read
// their OWN `phone` from `args` and must NOT be perturbed by the silent caller-ID
// fallback below. The new identity/verification skills DO get the silent phone so
// an existing customer on a masked line can still be resolved.
const LEGACY_TOOLS = new Set([
    'checkServiceArea',
    'validateAddress',
    'checkAvailability',
    'recommendSlots',
    'createLead',
]);

// ─── Auth middleware ──────────────────────────────────────────────────────────

function vapiSecretAuth(req, res, next) {
    const secret = process.env.VAPI_TOOLS_SECRET;
    if (!secret) {
        // Fail closed: a public endpoint must never run unauthenticated.
        console.error('[vapi-tools] VAPI_TOOLS_SECRET not set — refusing requests (fail-closed)');
        return res.status(503).json({ error: 'vapi tools not configured' });
    }
    const header = req.headers['x-vapi-secret'];
    if (header !== secret) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

/**
 * Build the per-call skill input from the tool arguments, threading the VAPI
 * caller-ID (`message.call.customer.number`) in as the SILENT phone — a FALLBACK
 * only: anything the assistant re-sent in `args` wins (`{ phone: callerId, ...args }`).
 *
 * The silent phone is threaded ONLY for the new identity/verification skills. The
 * 5 legacy L0 tools are excluded so their observable output stays byte-identical
 * to the pre-refactor handlers (they never saw the raw caller-ID before).
 *
 * @param {string} name The tool/skill name.
 * @param {object} args Parsed tool arguments.
 * @param {object} [call] The VAPI call metadata (message.call).
 * @returns {object} The skill input (identity block + skill-specific fields).
 */
function buildSkillInput(name, args, call) {
    const callerNumber = call && call.customer && call.customer.number;
    if (LEGACY_TOOLS.has(name) || !callerNumber) {
        return args;
    }
    // Fallback only — an assistant-supplied `phone` in args is authoritative.
    return { phone: callerNumber, ...args };
}

// ─── Router ───────────────────────────────────────────────────────────────────

router.post('/', vapiSecretAuth, async (req, res) => {
    try {
        const message = req.body?.message;
        if (!message || message.type !== 'tool-calls') {
            return res.json({});
        }

        const toolCallList = message.toolCallList || [];
        const results = [];

        for (const toolCall of toolCallList) {
            const name = toolCall.function?.name;
            const args = (() => {
                try {
                    return typeof toolCall.function?.arguments === 'string'
                        ? JSON.parse(toolCall.function.arguments)
                        : (toolCall.function?.arguments || {});
                } catch {
                    return {};
                }
            })();

            // Generic dispatch — the SINGLE choke-point. No if/else per tool, no
            // business logic here. `runSkill` gates + runs the skill and degrades
            // gracefully (unknown tool / any throw → SAFE_FALLBACK); it never
            // throws and never leaks internals, so no per-tool catch is needed.
            const input = buildSkillInput(name, args, message.call);
            const result = await agentSkills.runSkill(
                name,
                DEFAULT_COMPANY_ID,
                { source: 'vapi', call: message.call },
                input,
            );

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
