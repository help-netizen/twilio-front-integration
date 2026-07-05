/**
 * agentSkills / skills / identifyCaller
 * (AGENT-SKILLS-001, spec §4.1 / architecture §6 · task T5 — FR-S1 / FR-C1)
 *
 * READ · requiredLevel L0 (this skill is HOW a level is produced — it DERIVES the
 * L1/L2 the rest of the call runs at, so it must run for anyone, including a
 * masked / brand-new caller). Registered L0 in registry.js.
 *
 * PURPOSE: the linchpin router step — resolve WHO is calling and branch new vs.
 * existing. It re-runs the DB-derived verification (`verificationGate.deriveLevel`)
 * and returns a SPEECH-SAFE match summary. NEVER a raw PII dump: `customerName` is
 * the display name only — no phone / email / address ever appears in the object or
 * in `speak`.
 *
 *   input :  { phone?, name?, zip?, street?, contactId? }   (claims, not proof)
 *   output:  { ok, matchType, contactId, customerName, verificationLevel,
 *              ambiguousCount, speak }
 *
 * matchType semantics (spec §3 / §10 E3, E11):
 *   - 'existing'  → resolved to exactly one contact → greet by name; the gate has
 *                   already set verificationLevel to L1 (phone match) or L2
 *                   (phone/identity + confirmed name + ZIP/street).
 *   - 'ambiguous' → >1 candidate matched → force disambiguation (ask ZIP / last
 *                   appointment) BEFORE any further skill; level stays L0.
 *   - 'new'       → no match → new-lead flow. A masked / no-match number does NOT
 *                   silently assume 'new' as a dead-end: `speak` prompts for name +
 *                   ZIP so an existing customer on a masked line can still be found.
 *
 * The skill NEVER trusts `input` for the level — it derives it. A client/LLM
 * `verified:true` has no effect (AC-8); `deriveLevel` ignores such fields.
 */

'use strict';

const verificationGate = require('../verificationGate');
const resultShapes = require('../resultShapes');

/**
 * Does the caller supply a name AND (zip OR street)? Used only to tune the spoken
 * prompt on a no-match — if they've already given a name + address factor and we
 * still found nothing, they are genuinely new; otherwise ask for those factors so
 * an existing customer on a masked number can be resolved within ~2 questions.
 * @param {object} input
 * @returns {boolean}
 */
function hasNameAndAddressFactor(input) {
    const src = input && typeof input === 'object' ? input : {};
    const hasName = typeof src.name === 'string' && src.name.trim().length > 0;
    const hasZip = typeof src.zip === 'string' && src.zip.trim().length > 0;
    const hasStreet = typeof src.street === 'string' && src.street.trim().length > 0;
    return hasName && (hasZip || hasStreet);
}

/**
 * Was a usable phone (>=10 digits) supplied? A masked / absent number changes the
 * spoken prompt (ask for name + ZIP rather than assuming a dead-end 'new').
 * @param {object} input
 * @returns {boolean}
 */
function hasUsablePhone(input) {
    const src = input && typeof input === 'object' ? input : {};
    return String(src.phone || '').replace(/\D/g, '').length >= 10;
}

/**
 * Resolve who is calling and produce the verification level for the rest of the
 * call. Follows the skill `run` contract: run(companyId, verifiedContext, input).
 *
 * `verifiedContext` was already built by the choke-point (index.runSkill →
 * verificationGate.deriveLevel) from the SAME identity block, so this skill simply
 * projects it into the speech-safe output shape (it does not re-resolve — one
 * DB round-trip per call). We defensively re-derive ONLY if the context is absent
 * (e.g. a direct unit call), so the skill is robust in isolation.
 *
 * @param {string} companyId Tenant scope (DEFAULT_COMPANY_ID on voice/public-MCP).
 * @param {{ level: 'L0'|'L1'|'L2', contactId: number|null, customerName: string|null, ambiguous?: boolean, ambiguousCount?: number }} verifiedContext
 * @param {{ phone?: string, name?: string, zip?: string, street?: string, contactId?: string }} input
 * @returns {Promise<{ ok: true, matchType: 'new'|'existing'|'ambiguous', contactId: string|null, customerName: string|null, verificationLevel: 'L0'|'L1'|'L2', ambiguousCount: number, speak: string }>}
 */
async function run(companyId, verifiedContext, input) {
    // Use the server-built context when present; otherwise derive it (fail-closed
    // to L0 on any error — deriveLevel never throws out).
    let ctx = verifiedContext;
    if (!ctx || typeof ctx !== 'object' || typeof ctx.level !== 'string') {
        try {
            ctx = await verificationGate.deriveLevel(companyId, input || {});
        } catch (_e) {
            ctx = { level: 'L0', contactId: null, customerName: null, ambiguous: false, ambiguousCount: 0 };
        }
    }

    const level = ctx.level || 'L0';
    const ambiguousCount = Number(ctx.ambiguousCount) || 0;

    // --- Existing customer: exactly one contact resolved (L1 or L2). Greet by name.
    if (level === 'L1' || level === 'L2') {
        const name = ctx.customerName || null;
        return resultShapes.ok(
            name ? `Thanks — I found your account, ${name}.` : 'Thanks — I found your account.',
            {
                matchType: 'existing',
                contactId: ctx.contactId != null ? String(ctx.contactId) : null,
                customerName: name,
                verificationLevel: level,
                ambiguousCount: 0,
            },
        );
    }

    // --- Ambiguous: >1 candidate. Force disambiguation before any further skill.
    if (ctx.ambiguous || ambiguousCount > 1) {
        return resultShapes.ok(
            'I see more than one account that could match — can I get the ZIP code on the account to pull up the right one?',
            {
                matchType: 'ambiguous',
                contactId: null,
                customerName: null,
                verificationLevel: 'L0',
                ambiguousCount,
            },
        );
    }

    // --- No match (L0, not ambiguous). If a masked/no-usable-phone number, or the
    //     caller hasn't yet given a name + address factor, prompt for those so an
    //     existing customer on a masked line can still be resolved (spec §4.1 / E11)
    //     — rather than dead-ending as a brand-new lead prematurely.
    if (!hasUsablePhone(input) || !hasNameAndAddressFactor(input)) {
        return resultShapes.ok(
            "I couldn't match this number to an account. Can I get the name and ZIP code on the account so I can look you up?",
            {
                matchType: 'new',
                contactId: null,
                customerName: null,
                verificationLevel: 'L0',
                ambiguousCount: 0,
            },
        );
    }

    // Genuinely new (a name + ZIP/street were given and still matched nothing).
    return resultShapes.ok(
        "I don't see an existing account — I can go ahead and get you set up as a new request.",
        {
            matchType: 'new',
            contactId: null,
            customerName: null,
            verificationLevel: 'L0',
            ambiguousCount: 0,
        },
    );
}

module.exports = { run };
