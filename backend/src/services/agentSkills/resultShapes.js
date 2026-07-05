/**
 * agentSkills / resultShapes
 *
 * Speech-safe result builders + the canonical fallback shapes for the
 * provider-neutral skill layer (AGENT-SKILLS-001, spec §6 / architecture §7).
 *
 * These are the ONLY shapes the layer may leak to a caller on an error /
 * refusal path. They guarantee no PII dump, no internal code, no stack, no SQL.
 *
 * Scope note: the 5 relocated L0 legacy tools (checkServiceArea / validateAddress /
 * checkAvailability / recommendSlots / createLead) keep their OWN legacy output
 * shapes (byte-compat, AC-11) and do NOT use these builders. resultShapes is for
 * the 9 NEW skills + the generic fallback/refusal shared by the choke-point.
 */

'use strict';

/**
 * SAFE_FALLBACK — returned by the graceful-degradation guard on ANY internal
 * error (service throw, ZB 409, unknown skill). Never a stack / SQL / PII /
 * internal code. The call always continues (spec §6, architecture §7).
 *
 * Exported frozen so no caller can mutate the shared shape.
 * @type {{ ok: false, speak: string }}
 */
const SAFE_FALLBACK = Object.freeze({
    ok: false,
    speak: 'Let me have a teammate follow up with you on that.',
});

/**
 * NEEDS_VERIFICATION — the soft refusal returned when a sensitive/write skill's
 * required level is not met (spec §6 "verification failures ... return a soft
 * shape"). No disclosure of what exists on the account; just a prompt for the
 * second factor. Never a hard 4xx to the caller.
 * @type {{ ok: false, needsVerification: true, speak: string }}
 */
const NEEDS_VERIFICATION = Object.freeze({
    ok: false,
    needsVerification: true,
    speak: "I'll need to verify a couple details first — can I get the name and ZIP on the account?",
});

/**
 * Return a fresh copy of SAFE_FALLBACK (the generic "let a teammate follow up"
 * shape). A copy — not the frozen singleton — so a caller that wants to attach
 * skill-specific speak/fields can do so without touching the shared constant.
 * @returns {{ ok: false, speak: string }}
 */
function safeFallback() {
    return { ...SAFE_FALLBACK };
}

/**
 * Return the soft "needs verification" refusal shape. Optionally override the
 * spoken prompt (speech-safe strings only — never echo account data here).
 * @param {string} [speak] Optional replacement prompt.
 * @returns {{ ok: false, needsVerification: true, speak: string }}
 */
function needsVerification(speak) {
    const shape = { ...NEEDS_VERIFICATION };
    if (typeof speak === 'string' && speak.length > 0) {
        shape.speak = speak;
    }
    return shape;
}

/**
 * Build a successful, speech-safe skill result. Merges the caller's
 * provider-neutral fields with `{ ok: true, speak }`. The caller is responsible
 * for only passing speech-safe fields (no raw PII, no internal codes) — this
 * builder just standardizes the `ok`/`speak` envelope so a swapped agent needs
 * no mapping table (spec §4).
 * @param {string} speak The phrase the agent should say (already L-level safe).
 * @param {object} [fields] Additional provider-neutral result fields.
 * @returns {{ ok: true, speak: string }}
 */
function ok(speak, fields = {}) {
    return {
        ...fields,
        ok: true,
        speak: typeof speak === 'string' ? speak : '',
    };
}

/**
 * Build a soft, non-disclosing refusal that is NOT a verification prompt
 * (e.g. "I don't see an estimate on file for that", E12). `ok:false` with a
 * speech-safe phrase and no leaked internals. Never carries a code/stack/PII.
 * @param {string} speak The (safe) phrase explaining the refusal.
 * @param {object} [fields] Additional speech-safe fields (e.g. `{ conflict: true }`).
 * @returns {{ ok: false, speak: string }}
 */
function refusal(speak, fields = {}) {
    return {
        ...fields,
        ok: false,
        speak: typeof speak === 'string' ? speak : SAFE_FALLBACK.speak,
    };
}

module.exports = {
    SAFE_FALLBACK,
    NEEDS_VERIFICATION,
    safeFallback,
    needsVerification,
    ok,
    refusal,
};
