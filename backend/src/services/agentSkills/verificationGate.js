/**
 * agentSkills / verificationGate
 * (AGENT-SKILLS-001, spec §2 / architecture §5 · task T2 — P0 gate G1)
 *
 * THE SINGLE server-side L0/L1/L2 enforcement point. Both adapters (VAPI
 * `vapi-tools.js` and the `svc.*` MCP triplet) inherit it for free, because
 * `index.runSkill` calls `deriveLevel` then `assert` on EVERY invocation.
 *
 * TWO responsibilities:
 *   - `deriveLevel(companyId, identityBlock)` → { level, contactId, customerName,
 *     matchedPhone } — RE-DERIVED FROM THE DB every call via `identityResolver`.
 *     Never reads a caller/LLM "verified"/"level"/"isVerified" claim.
 *   - `assert(requiredLevel, verifiedContext)` — throws a typed
 *     `verification_required` when the derived level ranks below what the skill
 *     requires (index.js catches it → soft `needsVerification`, no disclosure).
 *
 * L0/L1/L2 DERIVATION (spec §2.2):
 *   L0 — no confident single match (resolver `new`, OR `ambiguous`). Only an
 *        L0-required skill (identifyCaller + the 5 legacy tools) passes `assert`.
 *   L1 — a real phone match to EXACTLY ONE contact in the company (resolver
 *        `existing` via a phone signal). If a `contactId` claim was supplied it
 *        must be the same resolved contact (the resolver already pins/ambiguates
 *        on that).
 *   L2 — L1 AND a server-confirmed `name` match against the contact AND
 *        (`zip` OR `street`) matches that contact's stored record. Comparison is
 *        case-insensitive/trimmed; ZIP is exact on 5 digits; name is a
 *        conservative match (exact-normalized, or a clean first/last containment).
 *
 * THE LOAD-BEARING SECURITY INVARIANT (AC-8): a client/LLM `verified:true` (or
 * `level:'L2'`, `isVerified`, …) NEVER raises the level. `deriveLevel` reads ONLY
 * the DB-derived resolver result + re-confirms name/zip/street against the stored
 * record — it never so much as looks at those claim fields. See `deriveLevel`:
 * the identity block is destructured to { phone, name, zip, street, contactId }
 * and nothing else is read (the "IGNORE self-asserted verification" line).
 *
 * FAIL-CLOSED: any DB error inside `deriveLevel` → L0 (least privilege), never
 * throws out. Ambiguous or masked identity NEVER auto-upgrades to L1/L2.
 */

'use strict';

const identityResolver = require('./identityResolver');

/**
 * Ordinal rank of each level for the `assert` comparison. Higher = more unlocked.
 * @type {{ L0: number, L1: number, L2: number }}
 */
const LEVEL_RANK = Object.freeze({ L0: 0, L1: 1, L2: 2 });

/**
 * Rank a level string, defaulting unknown/absent to L0 (fail-closed).
 * @param {string} level
 * @returns {number}
 */
function rankOf(level) {
    return Object.prototype.hasOwnProperty.call(LEVEL_RANK, level) ? LEVEL_RANK[level] : LEVEL_RANK.L0;
}

/**
 * The L0 verified-context shape (no confident single match). Reused for `new`,
 * `ambiguous`, and every fail-closed path.
 * @param {{ matchedPhone?: string|null, ambiguous?: boolean, ambiguousCount?: number }} [extra]
 * @returns {{ level: 'L0', contactId: null, customerName: null, matchedPhone: string|null, ambiguous: boolean, ambiguousCount: number }}
 */
function l0Context(extra = {}) {
    return {
        level: 'L0',
        contactId: null,
        customerName: null,
        matchedPhone: extra.matchedPhone != null ? extra.matchedPhone : null,
        ambiguous: Boolean(extra.ambiguous),
        ambiguousCount: extra.ambiguousCount || 0,
    };
}

/**
 * Conservative server-side name confirmation: does the caller-CLAIMED name match
 * the contact's STORED name? Case-insensitive, trimmed, whitespace-collapsed.
 * Accepts an exact normalized match, or a clean containment either way (e.g.
 * stored "Jane Q Smith" vs claimed "Jane Smith" both-tokens present) — but never
 * an empty claim, and never a single-character sliver.
 * @param {string} claimedName
 * @param {string|null} storedName
 * @returns {boolean}
 */
function nameMatches(claimedName, storedName) {
    const claim = identityResolver.normalizeText(claimedName);
    const stored = identityResolver.normalizeText(storedName);
    if (!claim || !stored) return false;
    if (claim.length < 2) return false;
    if (claim === stored) return true;
    // Token-subset containment: every token of the SHORTER name must appear in the
    // longer one (handles middle names / "First Last" vs "First M Last"). This is
    // conservative — it never matches on a single shared token like a common first
    // name alone, because the shorter list must be FULLY contained.
    const claimTokens = claim.split(' ').filter(Boolean);
    const storedTokens = stored.split(' ').filter(Boolean);
    if (claimTokens.length === 0 || storedTokens.length === 0) return false;
    const [shorter, longer] =
        claimTokens.length <= storedTokens.length ? [claimTokens, storedTokens] : [storedTokens, claimTokens];
    // Require at least two tokens (a full "First Last") on the shorter side, so a
    // lone first name can never confirm identity.
    if (shorter.length < 2) return false;
    const longerSet = new Set(longer);
    return shorter.every((t) => longerSet.has(t));
}

/**
 * Does the caller-CLAIMED zip/street confirm against the contact's stored record?
 * ZIP is an exact 5-digit compare; street is a normalized containment either way.
 * At least one must be present AND match.
 * @param {{ zip?: string, street?: string }} claims
 * @param {{ zips: string[], streets: string[] }} record
 * @returns {boolean}
 */
function addressFactorMatches(claims, record) {
    const zipNorm = identityResolver.normalizeZip(claims.zip);
    const streetNorm = identityResolver.normalizeText(claims.street);
    const zipOk = Boolean(zipNorm) && Array.isArray(record.zips) && record.zips.includes(zipNorm);
    const streetOk =
        Boolean(streetNorm) &&
        Array.isArray(record.streets) &&
        record.streets.some((s) => s.includes(streetNorm) || streetNorm.includes(s));
    return zipOk || streetOk;
}

/**
 * RE-DERIVE the verification level from the DB for this exact call. Called by
 * `index.runSkill` on EVERY invocation (verification is stateless-per-call).
 *
 * @param {string} companyId Tenant scope (required; a missing scope → L0).
 * @param {{ phone?: string, name?: string, zip?: string, street?: string, contactId?: string|number }} identityBlock
 *   The identity block (claims). Self-asserted verification fields (verified/
 *   level/isVerified) are IGNORED — see the destructure below.
 * @returns {Promise<{ level: 'L0'|'L1'|'L2', contactId: number|null, customerName: string|null, matchedPhone: string|null, ambiguous: boolean, ambiguousCount: number }>}
 */
async function deriveLevel(companyId, identityBlock) {
    // --- AC-8 (THE load-bearing security invariant): read ONLY the claim fields.
    // Destructuring exactly these five means `verified` / `level` / `isVerified`
    // and any other self-asserted verification field on `identityBlock` are never
    // read. The level comes solely from the DB-derived resolver + server-side
    // re-confirmation below. A client/LLM claim of verification CANNOT raise it.
    const src = identityBlock && typeof identityBlock === 'object' ? identityBlock : {};
    const { phone, name, zip, street, contactId } = src;

    if (!companyId) return l0Context();

    let resolution;
    try {
        resolution = await identityResolver.resolve(companyId, { phone, name, zip, street, contactId });
    } catch (err) {
        // Fail-closed: resolver blew up → least privilege.
        // eslint-disable-next-line no-console
        console.error(`[agentSkills] verificationGate.deriveLevel resolve failed: ${err && err.message ? err.message : 'unknown error'}`);
        return l0Context();
    }

    // No confident single match → L0. `ambiguous` carries a marker so
    // identifyCaller can force disambiguation; it NEVER rises to L1/L2.
    if (!resolution || resolution.matchType !== 'existing' || resolution.contactId == null) {
        return l0Context({
            matchedPhone: resolution ? resolution.matchedPhone : null,
            ambiguous: Boolean(resolution && resolution.matchType === 'ambiguous'),
            ambiguousCount: resolution ? resolution.ambiguousCount || 0 : 0,
        });
    }

    // Exactly one contact resolved → at least L1.
    const base = {
        contactId: resolution.contactId,
        customerName: resolution.customerName || null,
        matchedPhone: resolution.matchedPhone || null,
        ambiguous: false,
        ambiguousCount: 0,
    };

    // --- L2 test: server-confirmed name AND (zip OR street) against the stored
    //     record. Both factors are compared to the DB row the resolver built —
    //     the LLM merely surfaces the claim; the server confirms it.
    const record = resolution.contact || { zips: [], streets: [] };
    const nameOk = nameMatches(name, resolution.customerName);
    const addrOk = addressFactorMatches({ zip, street }, record);

    if (nameOk && addrOk) {
        return { level: 'L2', ...base };
    }

    // Phone/identity matched exactly one contact but the L2 second factor is not
    // (yet) confirmed → L1. A wrong ZIP with a right name stays L1, never L2.
    return { level: 'L1', ...base };
}

/**
 * A typed verification error the skill layer recognizes (index.js turns it into
 * the soft `needsVerification` shape). Carries the required + actual level so a
 * caller/log can see the gap, but NEVER any account data.
 */
class VerificationRequiredError extends Error {
    /**
     * @param {'L0'|'L1'|'L2'} requiredLevel
     * @param {'L0'|'L1'|'L2'} have
     */
    constructor(requiredLevel, have) {
        super(`verification_required: need ${requiredLevel}, have ${have}`);
        this.name = 'verification_required';
        this.code = 'verification_required';
        this.verificationRequired = true;
        this.requiredLevel = requiredLevel;
        this.have = have;
    }
}

/**
 * Enforce a skill's required level against the server-derived context. Throws a
 * typed `verification_required` when the derived level ranks BELOW the required
 * one; an equal-or-higher level passes silently. L0-required skills always pass.
 *
 * Accepts either the full verifiedContext object ({ level, ... }) or a bare level
 * string, so both `index.runSkill` (passes the object) and unit tests are ergonomic.
 *
 * @param {'L0'|'L1'|'L2'} requiredLevel The skill's declared requiredLevel.
 * @param {{ level: 'L0'|'L1'|'L2' }|string} verifiedContext Server-derived context (or its level).
 * @returns {true} when the gate passes.
 * @throws {VerificationRequiredError} when derived < required.
 */
function assert(requiredLevel, verifiedContext) {
    const required = Object.prototype.hasOwnProperty.call(LEVEL_RANK, requiredLevel) ? requiredLevel : 'L0';
    const have =
        typeof verifiedContext === 'string'
            ? verifiedContext
            : (verifiedContext && verifiedContext.level) || 'L0';

    if (rankOf(have) < rankOf(required)) {
        throw new VerificationRequiredError(required, have);
    }
    return true;
}

/**
 * True when `have` satisfies `required` (rank ≥). A non-throwing companion to
 * `assert`, handy for callers/tests that want a boolean.
 * @param {'L0'|'L1'|'L2'} requiredLevel
 * @param {'L0'|'L1'|'L2'} have
 * @returns {boolean}
 */
function satisfies(requiredLevel, have) {
    return rankOf(have) >= rankOf(requiredLevel);
}

module.exports = {
    deriveLevel,
    assert,
    satisfies,
    LEVEL_RANK,
    VerificationRequiredError,
};
