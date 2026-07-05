/**
 * agentSkills / index — the public façade of the provider-neutral skill layer
 * (AGENT-SKILLS-001, spec §2.1 / architecture §1).
 *
 * `runSkill` is the SINGLE choke-point BOTH adapters (VAPI `vapi-tools.js` and
 * the `svc.*` MCP triplet) go through. All verification gating + graceful
 * degradation + unknown-tool handling lives here, so a swapped agent inherits it
 * for free and the adapters carry ZERO business logic.
 *
 * ---------------------------------------------------------------------------
 * SKILL `run` CONTRACT (every module under ./skills follows this):
 *
 *   async function run(companyId, verifiedContext, input) -> resultObject
 *
 *   - companyId:        string — the tenant scope. ALWAYS the hardwired
 *                       DEFAULT_COMPANY_ID on voice/public-MCP, or
 *                       req.companyFilter.company_id on the authed MCP route.
 *                       NEVER taken from the client payload.
 *   - verifiedContext:  server-built object from verificationGate.deriveLevel,
 *                       { level, contactId, customerName, matchedPhone }. A skill
 *                       NEVER trusts `input` for verification / company / entity
 *                       ownership — it re-checks ownership by scoping every
 *                       reused-service call to companyId + the verified contactId.
 *   - input:            the adapter's per-call payload — the identity block
 *                       { phone?, name?, zip?, street?, contactId? } (claims, not
 *                       proof) PLUS any skill-specific fields. Self-asserted
 *                       verification fields (verified/level) are IGNORED here;
 *                       the gate re-derives the level from the DB.
 *
 *   Returns a provider-neutral, speech-safe object (from resultShapes for the 9
 *   new skills; the 5 legacy L0 tools return their OWN frozen legacy shapes).
 *   Never a raw PII dump, internal code, SQL, or stack.
 * ---------------------------------------------------------------------------
 *
 * The verificationGate is required LAZILY (it is implemented in T2). Do NOT
 * hard-require it at module load, or the scaffold won't load until T2 lands.
 */

'use strict';

const registry = require('./registry');
const resultShapes = require('./resultShapes');

/**
 * Lazily load the verification gate. Kept lazy so this scaffold loads before the
 * gate module (T2) exists; a missing gate at CALL time is caught by the guard in
 * `runSkill` and degrades to SAFE_FALLBACK.
 * @returns {{ deriveLevel: Function, assert: Function }}
 */
function getVerificationGate() {
    return require('./verificationGate');
}

/**
 * Extract the identity block (claims) from a skill `input`. Verification fields
 * the client/LLM may have set (verified/level) are intentionally NOT read — the
 * gate re-derives the level from the DB (spec §2.3, AC-8).
 * @param {object} input The adapter's per-call payload.
 * @returns {{ phone?: string, name?: string, zip?: string, street?: string, contactId?: string }}
 */
function identityBlockFrom(input) {
    const src = input && typeof input === 'object' ? input : {};
    const { phone, name, zip, street, contactId } = src;
    return { phone, name, zip, street, contactId };
}

/**
 * Is this thrown error a soft "needs verification" signal? The gate throws a
 * typed error (name/code === 'verification_required') when the derived level is
 * below the skill's requiredLevel. On a sensitive/write skill we turn that into
 * a soft prompt rather than the generic fallback (spec §6).
 * @param {*} err
 * @returns {boolean}
 */
function isVerificationRequired(err) {
    return Boolean(
        err &&
            (err.code === 'verification_required' ||
                err.name === 'verification_required' ||
                err.verificationRequired === true),
    );
}

/**
 * THE choke-point. Every adapter calls this and nothing else.
 *
 * Order (spec §2.1):
 *   1. Resolve the skill from the registry. Unknown → SAFE_FALLBACK (never throw).
 *   2. verifiedContext = verificationGate.deriveLevel(companyId, identityBlock)
 *      — recompute the level from scratch against the DB (never a claimed level).
 *   3. verificationGate.assert(skill.requiredLevel, verifiedContext) — throws a
 *      typed `verification_required` when derived < required.
 *   4. raw = await skill.run(companyId, verifiedContext, input).
 *   5. Everything is wrapped in a guard: any throw → SAFE_FALLBACK; a soft
 *      `verification_required` on a sensitive skill → the soft needsVerification
 *      shape. NEVER re-throw, NEVER leak err.message / stack / SQL / PII.
 *
 * @param {string} name The skill name (VAPI tool name or the mapped MCP name).
 * @param {string} companyId Tenant scope (DEFAULT_COMPANY_ID or req company).
 * @param {object} rawContext Transport context ({ source:'vapi'|'mcp', call?, req? }) — LOGGING only, never authorization.
 * @param {object} input The identity block + skill-specific fields.
 * @returns {Promise<object>} A provider-neutral, speech-safe result (or a safe fallback / refusal).
 */
async function runSkill(name, companyId, rawContext, input) {
    // (1) Unknown skill → SAFE_FALLBACK. Resolved, not thrown (spec E13).
    const skill = registry.getSkill(name);
    if (!skill) {
        return resultShapes.safeFallback();
    }

    try {
        const gate = getVerificationGate();
        const identityBlock = identityBlockFrom(input);

        // (2) Re-derive the verification level from the DB every call.
        const verifiedContext = await gate.deriveLevel(companyId, identityBlock);

        // (3) Enforce the skill's required level. Throws `verification_required`
        //     when derived < required (an equal/higher level does not throw).
        gate.assert(skill.requiredLevel, verifiedContext);

        // (4) Run the skill with the SERVER-built verifiedContext.
        const raw = await skill.run(companyId, verifiedContext, input);
        return raw;
    } catch (err) {
        // (5) Graceful degradation. A gate-level verification failure on a
        //     sensitive/write skill → soft prompt; anything else → SAFE_FALLBACK.
        //     Never re-throw, never surface err.message.
        if (isVerificationRequired(err)) {
            return resultShapes.needsVerification();
        }
        // Internal-only log (safe): name + a short reason, never returned to caller.
        // eslint-disable-next-line no-console
        console.error(
            `[agentSkills] skill "${name}" failed: ${err && err.message ? err.message : 'unknown error'}`,
        );
        return resultShapes.safeFallback();
    }
}

/**
 * List all registered skills' public metadata (name/kind/requiredLevel).
 * Thin re-export of the registry's projection.
 * @returns {{ name: string, kind: 'read'|'write', requiredLevel: 'L0'|'L1'|'L2' }[]}
 */
function listSkills() {
    return registry.listSkills();
}

module.exports = {
    runSkill,
    listSkills,
};
