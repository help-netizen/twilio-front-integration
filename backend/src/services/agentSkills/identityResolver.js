/**
 * agentSkills / identityResolver
 * (AGENT-SKILLS-001, spec §3 / architecture §6.2 · task T2)
 *
 * Resolve WHO is calling across **leads + contacts + jobs** — NOT open leads
 * alone. `verificationGate.deriveLevel` and the `identifyCaller` skill both go
 * through here; it is the DB-derived source of the caller's identity.
 *
 * WHY not `leadsService.getLeadByPhone` alone (the load-bearing real-code fact):
 *   `getLeadByPhone` / `getLeadsByPhones` deliberately RETURN NULL / suppress a
 *   matched lead once that lead's contact already has a job (leadsService.js
 *   1140–1146 / 1081–1094 — for PulsePage). That suppressed case is *exactly* the
 *   existing-customer we must catch. So when the lead getter yields nothing but a
 *   real phone was given, we bridge phone → contact (contactsService has no native
 *   phone getter, so we phone-match `contacts` directly, company-scoped) and pull
 *   that contact's jobs. A contact with jobs = an existing customer.
 *
 * P0 GUARANTEES:
 *   - Company isolation: EVERY query is scoped to `companyId`. A contact/lead/job
 *     from another company can NEVER satisfy a match (cross-company phone twins →
 *     `new`, never a cross-company `existing`).
 *   - Never silently pick one: >1 distinct contact match → `ambiguous`.
 *   - Fail-closed: any DB error → `new` (least privilege), never throws out.
 *
 * OUTPUT (provider-neutral, speech-safe — no raw PII dump):
 *   { matchType:'new'|'existing'|'ambiguous', contactId|null, customerName|null,
 *     matchedPhone|null, ambiguousCount:int, phoneCandidateCount:int, contact|null }
 *   `contact` is a small server-side record ({ id, name, zips[], streets[] }) the
 *   gate uses to confirm the L2 second factor; it is NEVER returned to a caller.
 */

'use strict';

const db = require('../../db/connection');

// Reused, called (never re-implemented) — see architecture §8 "reused unchanged".
const leadsService = require('../leadsService');
const jobsService = require('../jobsService');

/**
 * Normalize a phone claim to its last-10 digits (US), mirroring the exact
 * normalization the leads/dedupe services use (`RIGHT(REGEXP_REPLACE(...),10)`),
 * so a match here means the same as a match there.
 * @param {string} [phone]
 * @returns {string} last-10 digits, or '' when there aren't 10 usable digits.
 */
function normalizePhoneLast10(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : '';
}

/**
 * Case-insensitive, trimmed, whitespace-collapsed lower-case form for name/street
 * comparison. Empty/absent → ''.
 * @param {string} [s]
 * @returns {string}
 */
function normalizeText(s) {
    return String(s || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

/**
 * Normalize a ZIP to its first 5 digits (US 5 or ZIP+4 → 5). Empty/absent → ''.
 * @param {string} [zip]
 * @returns {string}
 */
function normalizeZip(zip) {
    const digits = String(zip || '').replace(/\D/g, '');
    return digits.length >= 5 ? digits.slice(0, 5) : digits;
}

/**
 * Build a compact display name from first/last (or a pre-joined full name).
 * @param {{ first?: string, last?: string, full?: string }} parts
 * @returns {string|null}
 */
function displayName({ first, last, full }) {
    const joined = [first, last].filter(Boolean).join(' ').trim();
    const name = (full && full.trim()) || joined;
    return name.length > 0 ? name : null;
}

/**
 * Pull every ZIP the resolved contact is associated with (from the contact's
 * leads + jobs), company-scoped, for the L2 (zip OR street) confirmation. Reads
 * are lean and existence-oriented; jobs carry a formatted `address` string, leads
 * carry a structured `postal_code`. Returns a Set of normalized 5-digit ZIPs.
 * @param {string} companyId
 * @param {number} contactId
 * @returns {Promise<Set<string>>}
 */
async function collectContactZips(companyId, contactId) {
    const zips = new Set();
    // Leads for this contact (structured postal_code), company-scoped.
    const { rows: leadRows } = await db.query(
        `SELECT postal_code, address FROM leads
         WHERE contact_id = $1 AND company_id = $2`,
        [contactId, companyId],
    );
    for (const r of leadRows) {
        const z = normalizeZip(r.postal_code);
        if (z) zips.add(z);
        // Also scan a ZIP out of the free-form address, if present.
        const m = String(r.address || '').match(/\b(\d{5})(?:-\d{4})?\b/);
        if (m) zips.add(m[1]);
    }
    // Jobs for this contact carry a formatted `address` string — scan for a ZIP.
    const { rows: jobRows } = await db.query(
        `SELECT address FROM jobs
         WHERE contact_id = $1 AND company_id = $2`,
        [contactId, companyId],
    );
    for (const r of jobRows) {
        const m = String(r.address || '').match(/\b(\d{5})(?:-\d{4})?\b/);
        if (m) zips.add(m[1]);
    }
    return zips;
}

/**
 * Pull normalized street strings the resolved contact is associated with (leads
 * `address`, jobs `address`), company-scoped, for the L2 street confirmation.
 * @param {string} companyId
 * @param {number} contactId
 * @returns {Promise<string[]>} normalized address strings (may be empty).
 */
async function collectContactStreets(companyId, contactId) {
    const streets = [];
    const { rows: leadRows } = await db.query(
        `SELECT address FROM leads WHERE contact_id = $1 AND company_id = $2`,
        [contactId, companyId],
    );
    for (const r of leadRows) {
        const a = normalizeText(r.address);
        if (a) streets.push(a);
    }
    const { rows: jobRows } = await db.query(
        `SELECT address FROM jobs WHERE contact_id = $1 AND company_id = $2`,
        [contactId, companyId],
    );
    for (const r of jobRows) {
        const a = normalizeText(r.address);
        if (a) streets.push(a);
    }
    return streets;
}

/**
 * Assemble the small server-side confirmation record for a resolved contact
 * (id + display name + the ZIP/street sets used for the L2 second factor). This
 * record NEVER leaves the server — the gate reads it, then discloses only
 * { level, contactId, customerName, matchedPhone }.
 * @param {string} companyId
 * @param {{ id: number, name: string|null }} base
 * @returns {Promise<{ id: number, name: string|null, zips: string[], streets: string[] }>}
 */
async function buildContactRecord(companyId, base) {
    const [zipSet, streets] = await Promise.all([
        collectContactZips(companyId, base.id),
        collectContactStreets(companyId, base.id),
    ]);
    return { id: base.id, name: base.name, zips: [...zipSet], streets };
}

/**
 * Company-scoped phone → contact bridge. contactsService has NO native phone
 * getter, so we phone-match the `contacts` table directly, mirroring the exact
 * normalization used elsewhere (`RIGHT(REGEXP_REPLACE(...),10)` over `phone_e164`
 * AND `secondary_phone`; contactDedupeService.js:209-210). ALWAYS company-scoped.
 * @param {string} companyId
 * @param {string} last10 Normalized last-10-digit phone.
 * @returns {Promise<{ id: number, name: string|null }[]>} distinct contact matches.
 */
async function bridgePhoneToContacts(companyId, last10) {
    const { rows } = await db.query(
        `SELECT c.id, c.full_name, c.first_name, c.last_name, c.created_at
         FROM contacts c
         WHERE c.company_id = $2
           AND (
               RIGHT(REGEXP_REPLACE(c.phone_e164, '[^0-9]', '', 'g'), 10) = $1
               OR RIGHT(REGEXP_REPLACE(COALESCE(c.secondary_phone, ''), '[^0-9]', '', 'g'), 10) = $1
           )`,
        [last10, companyId],
    );
    return rows.map((r) => ({
        id: r.id,
        name: displayName({ first: r.first_name, last: r.last_name, full: r.full_name }),
        createdAt: r.created_at != null ? r.created_at : null,
    }));
}

/**
 * Company-scoped resolve of a contact that has at least one JOB whose phone
 * matches (jobs carry `customer_phone`). Covers the existing-customer whose lead
 * was suppressed AND whose contact link is only expressed on the job side.
 * @param {string} companyId
 * @param {string} last10
 * @returns {Promise<{ id: number, name: string|null }[]>}
 */
async function contactsFromJobsByPhone(companyId, last10) {
    const { rows } = await db.query(
        `SELECT DISTINCT c.id, c.full_name, c.first_name, c.last_name, c.created_at
         FROM jobs j
         JOIN contacts c ON c.id = j.contact_id AND c.company_id = j.company_id
         WHERE j.company_id = $2
           AND j.contact_id IS NOT NULL
           AND RIGHT(REGEXP_REPLACE(COALESCE(j.customer_phone, ''), '[^0-9]', '', 'g'), 10) = $1`,
        [last10, companyId],
    );
    return rows.map((r) => ({
        id: r.id,
        name: displayName({ first: r.first_name, last: r.last_name, full: r.full_name }),
        createdAt: r.created_at != null ? r.created_at : null,
    }));
}

/**
 * Numeric epoch for a `created_at` value (Date | ISO string | null), for ranking.
 * A null/absent/unparseable timestamp → -Infinity so it sorts as OLDEST
 * (least-preferred by take-latest — §1.2(a): a null created_at sorts oldest).
 * @param {Date|string|null|undefined} createdAt
 * @returns {number}
 */
function createdAtEpoch(createdAt) {
    if (createdAt == null) return -Infinity;
    const t = new Date(createdAt).getTime();
    return Number.isNaN(t) ? -Infinity : t;
}

/**
 * De-duplicate contact candidates by id, preserving the first-seen display name.
 * When the SAME id appears from multiple sources (lead-getter / by-contact /
 * by-job), keep the MAX non-null `created_at` seen for that id so the take-latest
 * ranking (§1.2) uses the real contact-sourced timestamp even if a lead-getter
 * echo (createdAt:null) was seen first for the same id.
 * @param {{ id: number, name: string|null, createdAt?: Date|string|null }[]} candidates
 * @returns {{ id: number, name: string|null, createdAt: Date|string|null }[]}
 */
function dedupeById(candidates) {
    const byId = new Map();
    for (const c of candidates) {
        if (!c || c.id == null) continue;
        const existing = byId.get(c.id);
        if (!existing) {
            byId.set(c.id, { ...c, createdAt: c.createdAt != null ? c.createdAt : null });
            continue;
        }
        // Keep first-seen name/id; upgrade createdAt to the greater non-null one.
        if (createdAtEpoch(c.createdAt) > createdAtEpoch(existing.createdAt)) {
            existing.createdAt = c.createdAt;
        }
    }
    return [...byId.values()];
}

/**
 * Resolve by phone across leads + contacts + jobs (spec §3 steps 1–2).
 *   1. Try the lead getter (fast path — an open lead not yet converted to a job).
 *   2. ALWAYS also bridge phone → contact (direct contacts phone-match) and
 *      phone → contact-via-jobs, because the lead getter suppresses the
 *      existing-customer-with-a-job case. Union + dedupe by contact id.
 * @param {string} companyId
 * @param {string} last10
 * @returns {Promise<{ id: number, name: string|null }[]>} distinct contact candidates.
 */
async function resolveByPhone(companyId, last10) {
    const candidates = [];

    // (1) Lead getter (company-scoped). Returns a rowToLead (PascalCase) or null.
    // It suppresses leads whose contact already has a job — so this is ONE signal,
    // never the sole one.
    let lead = null;
    try {
        lead = await leadsService.getLeadByPhone(last10, companyId);
    } catch (_e) {
        lead = null; // fail-closed on this signal; the bridge below still runs.
    }
    if (lead && lead.ContactId) {
        // `getLeadByPhone` returns a rowToLead with NO created_at → tag null so this
        // lead-only echo sorts OLDEST and never beats a real contact row in ranking.
        candidates.push({ id: lead.ContactId, name: displayName({ first: lead.FirstName, last: lead.LastName, full: lead.ContactName }), createdAt: null });
    }

    // (2) Bridge phone → contact directly + phone → contact-via-jobs. This is what
    // catches the suppressed existing-customer (contact with jobs) that step (1)
    // deliberately hides.
    const [byContact, byJob] = await Promise.all([
        bridgePhoneToContacts(companyId, last10),
        contactsFromJobsByPhone(companyId, last10),
    ]);

    return dedupeById([...candidates, ...byContact, ...byJob]);
}

/**
 * Resolve by name + (zip OR street) when there is no usable phone (masked /
 * spoofed / absent). Company-scoped over contacts (+ their leads/jobs for the
 * ZIP/street). Conservative: requires a name AND at least one of zip/street, and
 * confirms the name against the row.
 * @param {string} companyId
 * @param {{ name?: string, zip?: string, street?: string }} claims
 * @returns {Promise<{ id: number, name: string|null }[]>} distinct contact candidates.
 */
async function resolveByNameAndAddress(companyId, { name, zip, street }) {
    const nameNorm = normalizeText(name);
    const zipNorm = normalizeZip(zip);
    const streetNorm = normalizeText(street);
    // Need a name AND at least one address factor to even attempt a name-based match.
    if (!nameNorm || (!zipNorm && !streetNorm)) return [];

    // Company-scoped contacts whose first/last/full name matches the claim.
    // We match on a normalized comparison of full_name and first+last.
    const { rows } = await db.query(
        `SELECT c.id, c.full_name, c.first_name, c.last_name
         FROM contacts c
         WHERE c.company_id = $1
           AND (
               LOWER(TRIM(c.full_name)) = $2
               OR LOWER(TRIM(CONCAT_WS(' ', c.first_name, c.last_name))) = $2
           )`,
        [companyId, nameNorm],
    );
    const named = rows.map((r) => ({
        id: r.id,
        name: displayName({ first: r.first_name, last: r.last_name, full: r.full_name }),
    }));

    // Keep only those whose leads/jobs corroborate the claimed zip OR street.
    const confirmed = [];
    for (const c of dedupeById(named)) {
        const rec = await buildContactRecord(companyId, c);
        const zipOk = zipNorm && rec.zips.includes(zipNorm);
        const streetOk = streetNorm && rec.streets.some((s) => s.includes(streetNorm) || streetNorm.includes(s));
        if (zipOk || streetOk) confirmed.push(c);
    }
    return confirmed;
}

/**
 * Does this candidate's stored record corroborate the claimed name AND (zip OR
 * street), using the SAME normalization the gate/L2 path uses? Used only for the
 * take-latest name+address preference on the phone path (§1.2(b) step 2). The
 * record is built lazily by the caller and passed in to bound cost.
 * @param {{ id: number, name: string|null }} candidate
 * @param {{ id: number, name: string|null, zips: string[], streets: string[] }} record buildContactRecord output
 * @param {{ name?: string, zip?: string, street?: string }} claims
 * @returns {boolean}
 */
function recordMatchesNameAndAddress(candidate, record, { name, zip, street }) {
    const nameNorm = normalizeText(name);
    const zipNorm = normalizeZip(zip);
    const streetNorm = normalizeText(street);
    // Name must be supplied AND at least one address factor (guaranteed by caller).
    if (!nameNorm || (!zipNorm && !streetNorm)) return false;
    // Name match: the candidate's display name equals the claimed name (same
    // whitespace-collapsed, lower-cased comparison used everywhere else).
    const candName = normalizeText(candidate && candidate.name);
    if (!candName || candName !== nameNorm) return false;
    const zipOk = !!zipNorm && record.zips.includes(zipNorm);
    const streetOk = !!streetNorm && record.streets.some((s) => s.includes(streetNorm) || streetNorm.includes(s));
    return zipOk || streetOk;
}

/**
 * Pick the most-recent candidate by `created_at` DESC, with a `id DESC` tiebreak
 * (a monotonic proxy for "most recently created") so the result is ALWAYS
 * deterministic and never throws (§1.2(b) step 3). Assumes >= 1 candidate.
 * @param {{ id: number, name: string|null, createdAt?: Date|string|null }[]} candidates
 * @returns {{ id: number, name: string|null, createdAt: Date|string|null }}
 */
function pickMostRecent(candidates) {
    return candidates.reduce((best, c) => {
        const bt = createdAtEpoch(best.createdAt);
        const ct = createdAtEpoch(c.createdAt);
        if (ct > bt) return c;
        if (ct === bt && Number(c.id) > Number(best.id)) return c;
        return best;
    });
}

/**
 * Phone-path deterministic take-latest resolution over >1 distinct same-phone
 * candidate (§1.2(b)). The claim-pin has ALREADY been applied by the caller.
 *   1. Name+address preference: if `name` AND (`zip` OR `street`) were supplied,
 *      lazily build each candidate's record and keep those matching name+(zip|
 *      street). Exactly one match → that one. Several → rank the matching subset.
 *   2. Most-recent fallback: greatest `created_at` (id DESC tiebreak).
 * Never returns ambiguous — the phone path always resolves to a single contact.
 * @param {string} companyId
 * @param {{ id: number, name: string|null, createdAt?: Date|string|null }[]} candidates >1
 * @param {{ name?: string, zip?: string, street?: string }} claims
 * @returns {Promise<{ id: number, name: string|null, createdAt: Date|string|null }>}
 */
async function takeLatestOnPhonePath(companyId, candidates, { name, zip, street }) {
    const nameNorm = normalizeText(name);
    const hasAddr = !!normalizeZip(zip) || !!normalizeText(street);

    // (1) Name+address preference — only worth the record-builds when both a name
    //     and an address factor were supplied (lazy; bounds cost per §1.2(b)).
    if (nameNorm && hasAddr) {
        const matched = [];
        for (const c of candidates) {
            // eslint-disable-next-line no-await-in-loop
            const rec = await buildContactRecord(companyId, c);
            if (recordMatchesNameAndAddress(c, rec, { name, zip, street })) matched.push(c);
        }
        if (matched.length === 1) return matched[0];
        if (matched.length > 1) return pickMostRecent(matched); // rank the matching subset
        // matched.length === 0 → fall through to most-recent over ALL candidates.
    }

    // (2) Most-recent fallback (created_at DESC, id DESC).
    return pickMostRecent(candidates);
}

/**
 * Resolve the caller's identity across leads + contacts + jobs, company-scoped.
 *
 * @param {string} companyId Tenant scope (hardwired DEFAULT_COMPANY_ID on voice/
 *   public-MCP, or req.companyFilter.company_id on the authed MCP route). Required.
 * @param {{ phone?: string, name?: string, zip?: string, street?: string, contactId?: string|number }} claims
 *   The identity block (claims the agent has learned so far — NOT proof).
 * @returns {Promise<{
 *   matchType: 'new'|'existing'|'ambiguous',
 *   contactId: number|null,
 *   customerName: string|null,
 *   matchedPhone: string|null,
 *   ambiguousCount: number,
 *   phoneCandidateCount: number,
 *   contact: { id: number, name: string|null, zips: string[], streets: string[] } | null
 * }>}
 */
async function resolve(companyId, claims = {}) {
    const NEW = {
        matchType: 'new',
        contactId: null,
        customerName: null,
        matchedPhone: null,
        ambiguousCount: 0,
        phoneCandidateCount: 0,
        contact: null,
    };

    // No tenant scope → resolve to nothing (fail-closed; never a cross-company match).
    if (!companyId) return NEW;

    try {
        const { phone, name, zip, street } = claims || {};
        const last10 = normalizePhoneLast10(phone);

        // ---- Path A: a usable phone was supplied → phone resolution (§3.1–3.2).
        let candidates = [];
        let fromPhonePath = false;
        let phoneCandidateCount = 0;
        if (last10) {
            candidates = await resolveByPhone(companyId, last10);
            // Preserve the pre-ranking candidate count for consumers that must
            // fail closed on shared phones (createLead), while the existing voice
            // gate keeps its AGENT-SKILLS-002 take-latest behavior.
            phoneCandidateCount = candidates.length;
            // The phone path OWNS its candidate set even if it found nothing — a
            // usable phone that matched >1 must take-latest, never fall to Path B.
            fromPhonePath = candidates.length > 0;
        }

        // ---- Path B: masked / no usable phone, OR phone matched nothing → try
        //      name + (zip OR street) (§3.3). A masked number never auto-upgrades:
        //      it simply has no phone match and falls through to this weaker path.
        if (candidates.length === 0) {
            candidates = await resolveByNameAndAddress(companyId, { name, zip, street });
            // (fromPhonePath stays false — this is the name path.)
        }

        // ---- No candidate anywhere → new caller (L0 / new-lead flow).
        if (candidates.length === 0) {
            return { ...NEW, matchedPhone: last10 || null };
        }

        // ---- Disambiguate. If a contactId claim was supplied and it matches one
        //      of the resolved candidates, prefer that single one (spec §2.2: a
        //      supplied contactId "must correspond to that same resolved contact").
        //      This runs FIRST, before the phone-path take-latest ranking.
        if (candidates.length > 1) {
            const claimedId = claims.contactId != null ? Number(claims.contactId) : null;
            if (claimedId != null && !Number.isNaN(claimedId)) {
                const pinned = candidates.find((c) => Number(c.id) === claimedId);
                if (pinned) candidates = [pinned];
            }
        }

        // ---- Still >1 distinct contact → resolve by ORIGIN (AGENT-SKILLS-002 §1).
        if (candidates.length > 1) {
            if (fromPhonePath) {
                // PHONE PATH — take-latest: name+addr preference, else most-recent
                //   by created_at (id DESC tiebreak). NEVER dead-ends to ambiguous;
                //   the phone path always resolves to a single contact (§1.2/§1.3).
                const picked = await takeLatestOnPhonePath(companyId, candidates, { name, zip, street });
                candidates = [picked];
            } else {
                // NAME PATH (no usable phone) — still AMBIGUOUS. A name-only
                //   multi-match has no "most recent by phone-ownership" semantics,
                //   so force disambiguation (§1.3 / I5). No contact record disclosed.
                return {
                    matchType: 'ambiguous',
                    contactId: null,
                    customerName: null,
                    matchedPhone: last10 || null,
                    ambiguousCount: candidates.length,
                    phoneCandidateCount,
                    contact: null,
                };
            }
        }

        // ---- Exactly one contact → EXISTING. Build the confirmation record the
        //      gate needs for the L2 second factor.
        const only = candidates[0];
        const contactRecord = await buildContactRecord(companyId, only);
        return {
            matchType: 'existing',
            contactId: only.id,
            customerName: only.name,
            matchedPhone: last10 || null,
            ambiguousCount: 0,
            phoneCandidateCount,
            contact: contactRecord,
        };
    } catch (err) {
        // Any DB error → fail-closed to least privilege (`new`), never throw out.
        // eslint-disable-next-line no-console
        console.error(`[agentSkills] identityResolver.resolve failed: ${err && err.message ? err.message : 'unknown error'}`);
        return NEW;
    }
}

module.exports = {
    resolve,
    // Exported for unit tests + reuse by the gate's normalization.
    normalizePhoneLast10,
    normalizeText,
    normalizeZip,
};
