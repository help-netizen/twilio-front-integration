/**
 * Contact Email Merge Service (CONTACT-EMAIL-MERGE-001)
 *
 * The email analogue of `timelineMergeService.js` (which handles the phone side).
 * When a user adds an email address to a contact, this resolves who currently
 * owns that address's correspondence within the SAME company and folds it onto
 * the target contact's timeline — linking inbox-only messages silently, while
 * ANY separate-owner case throws the ContactConflictError sentinel so the PATCH
 * route can 409 into the user-confirmed merge/transfer round-trip
 * (CONTACT-MERGE-001 — the old silent D2a auto-merge / D2b re-point are gone).
 *
 * CONTACT-MERGE-001 additions: `detectAttributeConflicts` (locking conflict
 * detection for phones + emails, grouped by owner, FR-3 `transfer_allowed`),
 * `transferPhone` / `transferEmail` (single-attribute moves; the owner
 * survives), `assertTransferAllowed` (FR-3 execution-time re-check) and the
 * `mergeContacts` steps 3b (calls re-point BEFORE the dup-timeline delete —
 * calls.timeline_id has no ON DELETE action) and 3c (OQ-2 phone-slot fill +
 * `contact_merged` audit event; survivor scalars never overwritten).
 *
 * Contract for every exported function:
 *   • synchronous  — awaited in-request (the PATCH handler runs it inside its tx).
 *   • tx-aware     — optional trailing `client`; falls back to the `db` pool.
 *   • company-scoped — EVERY SQL leg is filtered by `companyId` (or, for the few
 *     child tables that carry no `company_id` column — contact_addresses,
 *     portal_sessions, portal_events — scoped through `contact_id`, which is
 *     itself company-verified before any write). No cross-tenant read/move/delete.
 *     (leads DOES carry company_id — added NOT NULL by migration 012 — so its legs
 *     are company-scoped like the other identity tables.)
 *   • idempotent   — re-running the same add is a no-op (re-link is a no-op
 *     UPDATE; the owner==target branch does nothing; a merged dup is gone so the
 *     address resolves to the target on the next run).
 *
 * The full-merge FK order is load-bearing (mirrors ORPHAN-TASK-REHOME-001):
 * open tasks are re-homed off the dup timeline BEFORE any timeline is deleted,
 * and the dup contact is deleted LAST, so `tasks.thread_id`'s ON DELETE CASCADE
 * never silently destroys an open Action-Required task.
 */

const db = require('../db/connection');
const emailQueries = require('../db/emailQueries');
const timelinesQueries = require('../db/timelinesQueries');

/**
 * ContactConflictError (CONTACT-MERGE-001, Decision B) — the "no silent path
 * left" sentinel. Thrown instead of any silent destructive action against a
 * SEPARATE owner (old D2a auto-merge / old D2b re-point of resolveAddedEmail,
 * and the FR-3 execution-time transfer gate). Its only intended catcher is the
 * `PATCH /api/contacts/:id` handler, which ROLLBACKs and answers a fresh 409
 * `CONTACT_ATTRIBUTE_CONFLICT`. Carries enough to rebuild the conflict payload:
 * the owner contact id + the conflicting attribute descriptors.
 */
class ContactConflictError extends Error {
    /**
     * @param {number|string} ownerContactId
     * @param {Array<{kind:'phone'|'email', value:string, normalized:string}>} attributes
     * @param {string} [message]
     */
    constructor(ownerContactId, attributes = [], message) {
        super(message || `contact attribute conflict: attribute(s) owned by contact ${ownerContactId}`);
        this.name = 'ContactConflictError';
        this.ownerContactId = ownerContactId;
        this.attributes = attributes;
    }
}

// ─── small shared normalizers (CONTACT-MERGE-001) ────────────────────────────

/** '+1 (617) 555-0022' → '16175550022'; empty/nullish → null. */
const digitsOf = (v) => String(v || '').replace(/\D/g, '') || null;

/** lower(trim(v)) or null. Mirrors the write-time contact_emails normalization. */
const normEmail = (v) => (String(v || '').trim().toLowerCase() || null);

/**
 * Read one contact row (company-scoped), optionally locked `FOR UPDATE`.
 * Returns the composition-bearing columns or null for a foreign/absent id —
 * never throws, so callers decide (detection skips; transfers no-op; the
 * route 404-guards).
 */
async function readContactRow(contactId, companyId, client = db, forUpdate = false) {
    const { rows } = await client.query(
        `SELECT id, full_name, company_name, email,
                phone_e164, secondary_phone, secondary_phone_name
           FROM contacts
          WHERE id = $1 AND company_id = $2` + (forUpdate ? `
            FOR UPDATE` : ''),
        [contactId, companyId]
    );
    return rows[0] || null;
}

/** Lock + read one contact row (company-scoped) `FOR UPDATE`. */
async function lockContactRow(contactId, companyId, client = db) {
    return readContactRow(contactId, companyId, client, true);
}

/**
 * All contact_emails rows of one contact, primary-first. contact_emails carries
 * no company_id (mig 025) — scoped through a contact id the caller has already
 * company-verified (lockContactRow / the PATCH 404 guard).
 */
async function listContactEmails(contactId, client = db) {
    const { rows } = await client.query(
        `SELECT email, email_normalized, is_primary
           FROM contact_emails
          WHERE contact_id = $1
          ORDER BY is_primary DESC, id ASC`,
        [contactId]
    );
    return rows;
}

/**
 * The dialog composition of one contact (spec §API contract): name + ALL phones
 * `{value,label,slot}` + ALL emails `{email,is_primary}`. Only data that exists —
 * no empty rows. The scalar email is included when it has no contact_emails row
 * (legacy pre-mig-025 shape / the not-yet-closed scalar hole).
 */
function contactComposition(row, emailRows) {
    const phones = [];
    if (row.phone_e164) {
        phones.push({ value: row.phone_e164, label: null, slot: 'primary' });
    }
    if (row.secondary_phone) {
        phones.push({ value: row.secondary_phone, label: row.secondary_phone_name || null, slot: 'secondary' });
    }
    const emails = emailRows.map(r => ({ email: r.email, is_primary: r.is_primary === true }));
    const scalarNorm = normEmail(row.email);
    if (scalarNorm && !emailRows.some(r => r.email_normalized === scalarNorm)) {
        emails.push({ email: row.email, is_primary: emails.length === 0 });
    }
    return {
        id: row.id,
        full_name: row.full_name || null,
        company_name: row.company_name || null,
        phones,
        emails,
    };
}

/**
 * FR-3 single-attribute gate: simulate removing ALL conflicting attributes of
 * THIS dialog from the owner's inventory ({phone_e164, secondary_phone} ∪
 * {scalar email + all contact_emails}); transferable only when ≥ 1 attribute
 * remains. NOTE the U05c trap: the subtraction is the WHOLE attribute set of
 * the dialog, never per-attribute.
 */
function computeTransferAllowed(ownerRow, ownerEmailRows, attributes) {
    const conflictDigits = attributes
        .filter(a => a.kind === 'phone')
        .map(a => digitsOf(a.normalized || a.value))
        .filter(Boolean);
    const conflictEmails = new Set(attributes
        .filter(a => a.kind === 'email')
        .map(a => normEmail(a.normalized || a.value))
        .filter(Boolean));
    // A stored number "matches" a conflicting one on full digits OR last-10
    // (the same tolerance the detection legs use for legacy non-E.164 rows).
    const inConflict = (d) => conflictDigits.some(cd => cd === d || cd.slice(-10) === d.slice(-10));

    const phones = [...new Set([digitsOf(ownerRow.phone_e164), digitsOf(ownerRow.secondary_phone)].filter(Boolean))];
    const emails = [...new Set([normEmail(ownerRow.email), ...ownerEmailRows.map(r => r.email_normalized)].filter(Boolean))];

    const remaining = phones.filter(d => !inConflict(d)).length
        + emails.filter(e => !conflictEmails.has(e)).length;
    return remaining >= 1;
}

/**
 * assertTransferAllowed — the FR-3 EXECUTION-TIME re-check (Decision D). The
 * route calls this right before running a `transfer` resolution: the owner is
 * re-read under FOR UPDATE and the gate re-simulated against current reality.
 * A stale-allowed transfer (owner lost other attributes between rounds) throws
 * the sentinel → ROLLBACK → fresh 409. An owner that vanished entirely is NOT
 * an error (S13) — the transfer legs will 0-row no-op.
 *
 * @param {number|string} ownerId
 * @param {Array<{kind:'phone'|'email', value:string, normalized?:string}>} attributes
 * @param {string} companyId
 * @param {{query: Function}} [client=db]
 */
async function assertTransferAllowed(ownerId, attributes, companyId, client = db) {
    const owner = await lockContactRow(ownerId, companyId, client);
    if (!owner) return; // owner gone between rounds (S13) — nothing to strip
    const ownerEmailRows = await listContactEmails(ownerId, client);
    if (!computeTransferAllowed(owner, ownerEmailRows, attributes)) {
        throw new ContactConflictError(ownerId, attributes,
            'transfer would leave the contact with no phone and no email');
    }
}

/**
 * detectAttributeConflicts (CONTACT-MERGE-001, Decision B) — called FIRST inside
 * the PATCH tx, before ANY write.
 *
 * Added-sets semantics (S12): values already on the target — by digits for
 * phones (full or last-10), by normalized address for emails (scalar OR
 * contact_emails) — are excluded up front, so an idempotent re-save triggers
 * ZERO owner lookups and no dialog.
 *
 * Phone owner lookup: company-scoped, `id <> target`; the full-digit equality
 * legs use the EXACT mig-149 expression (`NULLIF(regexp_replace(…,'\D','','g'),'')`)
 * so the expression indexes serve them verbatim; the `RIGHT(…,10)` legs are the
 * correctness fallback for legacy non-E.164 rows (bounded per-Save lookup).
 * `ORDER BY updated_at DESC LIMIT 1` = take-latest on legacy multi-owner dirt
 * (the next Save surfaces the next owner). Email owner lookup = the reused
 * `findEmailContact` (take-latest built in).
 *
 * Locking (deadlock-safe, review fix a): candidate owners are DISCOVERED
 * without row locks first; then the target + every candidate owner are locked
 * `FOR UPDATE` in ASCENDING id order (deterministic order = two concurrent
 * PATCHes editing each other's contacts can never deadlock, code 40P01);
 * ownership is then RE-VALIDATED against the locked rows (a row that changed
 * between discovery and lock simply drops out — mirrors S9/S13 semantics).
 * Detection + resolution execution therefore serialize against a concurrent
 * PATCH (AC-10).
 *
 * @param {number|string} targetContactId
 * @param {{phones?: string[], emails?: string[]}} added  submitted candidate values
 * @param {string} companyId
 * @param {{query: Function}} [client=db]
 * @returns {Promise<Array<{owner:object, editing:object, attributes:Array, transfer_allowed:boolean}>>}
 *          conflicts grouped by owner (several attributes of ONE owner = one entry)
 */
async function detectAttributeConflicts(targetContactId, added = {}, companyId, client = db) {
    // Normalize + dedupe the submitted candidates, keeping the raw value for the payload.
    const phoneAdds = [];
    const seenPhones = new Set();
    for (const raw of (added.phones || [])) {
        const d = digitsOf(raw);
        if (!d || seenPhones.has(d)) continue;
        seenPhones.add(d);
        phoneAdds.push({ value: String(raw), normalized: d });
    }
    const emailAdds = [];
    const seenEmails = new Set();
    for (const raw of (added.emails || [])) {
        const e = normEmail(raw);
        if (!e || seenEmails.has(e)) continue;
        seenEmails.add(e);
        emailAdds.push({ value: String(raw), normalized: e });
    }
    if (phoneAdds.length === 0 && emailAdds.length === 0) return [];

    // ── Phase 1 — DISCOVERY (no row locks). Read the target and find candidate
    // owners. Locks are deliberately NOT taken here so they can be acquired in
    // ascending-id order below (review fix a — deadlock-safe deterministic order).
    const probe = await readContactRow(targetContactId, companyId, client);
    if (!probe) return []; // foreign/absent target → the route's 404 guard owns the error
    const probeEmailRows = await listContactEmails(targetContactId, client);

    // Exclusion sets: what the target already holds (S12 — re-save = no dialog,
    // and no owner lookup is even issued for an already-owned value).
    const probeDigits = [digitsOf(probe.phone_e164), digitsOf(probe.secondary_phone)].filter(Boolean);
    const onProbe = (d) => probeDigits.some(td => td === d || td.slice(-10) === d.slice(-10));
    const probeEmailSet = new Set(
        [normEmail(probe.email), ...probeEmailRows.map(r => r.email_normalized)].filter(Boolean)
    );

    // Owner lookup is TWO queries, not one 4-leg OR (CM1-T5 review finding #5,
    // EXPLAIN-proven): a single query OR-ing the mig-149 expression legs with the
    // RIGHT(…,10) legs is fundamentally non-indexable — the un-indexed last-10
    // legs force the planner off idx_contacts_phone_digits /
    // idx_contacts_secondary_phone_digits onto a whole-tenant scan even with
    // enable_seqscan=off. Split form: query 1 = the full-digit legs ONLY (served
    // verbatim by the mig-149 expression indexes, BitmapOr); on a miss, query 2 =
    // the RIGHT(…,10) fallback legs (legacy non-E.164 rows; the documented,
    // accepted bounded per-Save cost — architecture "not a hot path"). Take-latest
    // (ORDER BY updated_at DESC LIMIT 1) is preserved within each tier; an exact
    // full-digit owner deliberately wins over a last-10-only legacy row.
    const PHONE_OWNER_LOOKUP_FULL = `
        SELECT id
          FROM contacts
         WHERE company_id = $1
           AND id <> $2
           AND (NULLIF(regexp_replace(phone_e164, '\\D', '', 'g'), '') = $3
             OR NULLIF(regexp_replace(secondary_phone, '\\D', '', 'g'), '') = $3)
         ORDER BY updated_at DESC NULLS LAST, id ASC
         LIMIT 1`;
    const PHONE_OWNER_LOOKUP_LAST10 = `
        SELECT id
          FROM contacts
         WHERE company_id = $1
           AND id <> $2
           AND (RIGHT(NULLIF(regexp_replace(phone_e164, '\\D', '', 'g'), ''), 10) = $3
             OR RIGHT(NULLIF(regexp_replace(secondary_phone, '\\D', '', 'g'), ''), 10) = $3)
         ORDER BY updated_at DESC NULLS LAST, id ASC
         LIMIT 1`;
    const phoneCandidates = []; // { add, ownerId }
    for (const p of phoneAdds) {
        if (onProbe(p.normalized)) continue; // already the target's own number
        const { rows } = await client.query(
            PHONE_OWNER_LOOKUP_FULL, [companyId, targetContactId, p.normalized]
        );
        let ownerRow = rows[0] || null;
        if (!ownerRow) {
            const { rows: fallback } = await client.query(
                PHONE_OWNER_LOOKUP_LAST10,
                [companyId, targetContactId, p.normalized.slice(-10)]
            );
            ownerRow = fallback[0] || null;
        }
        if (ownerRow) phoneCandidates.push({ add: p, ownerId: ownerRow.id });
    }

    const emailCandidates = []; // { add, ownerId }
    for (const e of emailAdds) {
        if (probeEmailSet.has(e.normalized)) continue; // already the target's own address
        const found = await emailQueries.findEmailContact(e.normalized, companyId, client);
        if (!found || String(found.id) === String(targetContactId)) continue; // inbox-only / self — silent branches
        emailCandidates.push({ add: e, ownerId: found.id });
    }

    if (phoneCandidates.length === 0 && emailCandidates.length === 0) return [];

    // ── Phase 2 — LOCK target + candidate owners FOR UPDATE in ASCENDING id
    // order (review fix a). lockContactRow is company-scoped, so a foreign id
    // can never be locked/read here.
    const idsToLock = [...new Set([
        Number(targetContactId),
        ...phoneCandidates.map(c => Number(c.ownerId)),
        ...emailCandidates.map(c => Number(c.ownerId)),
    ])].sort((a, b) => a - b);
    const lockedById = new Map();
    for (const cid of idsToLock) {
        lockedById.set(String(cid), await lockContactRow(cid, companyId, client));
    }

    const target = lockedById.get(String(Number(targetContactId)));
    if (!target) return []; // target vanished under our feet — nothing to conflict with
    const targetEmailRows = await listContactEmails(targetContactId, client);
    const targetDigits = [digitsOf(target.phone_e164), digitsOf(target.secondary_phone)].filter(Boolean);
    const onTarget = (d) => targetDigits.some(td => td === d || td.slice(-10) === d.slice(-10));
    const targetEmailSet = new Set(
        [normEmail(target.email), ...targetEmailRows.map(r => r.email_normalized)].filter(Boolean)
    );

    // ── Phase 3 — RE-VALIDATE ownership against the LOCKED rows (a row that
    // changed between discovery and lock silently drops out) and group by owner.
    const groups = new Map(); // ownerId → { owner: locked row, attributes: [...] } (S7)
    const addConflict = (ownerRow, attribute) => {
        const key = String(ownerRow.id);
        if (!groups.has(key)) groups.set(key, { owner: ownerRow, attributes: [] });
        groups.get(key).attributes.push(attribute);
    };
    const ownerEmailRowsCache = new Map();
    const emailRowsOf = async (ownerId) => {
        const key = String(ownerId);
        if (!ownerEmailRowsCache.has(key)) {
            ownerEmailRowsCache.set(key, await listContactEmails(ownerId, client));
        }
        return ownerEmailRowsCache.get(key);
    };

    for (const { add, ownerId } of phoneCandidates) {
        if (onTarget(add.normalized)) continue; // re-check against the locked target
        const ownerRow = lockedById.get(String(Number(ownerId)));
        if (!ownerRow) continue; // owner vanished before we could lock it
        const ownerDigits = [digitsOf(ownerRow.phone_e164), digitsOf(ownerRow.secondary_phone)].filter(Boolean);
        const stillOwns = ownerDigits.some(od => od === add.normalized || od.slice(-10) === add.normalized.slice(-10));
        if (!stillOwns) continue; // number moved away between discovery and lock
        addConflict(ownerRow, { kind: 'phone', value: add.value, normalized: add.normalized });
    }

    for (const { add, ownerId } of emailCandidates) {
        if (targetEmailSet.has(add.normalized)) continue; // re-check against the locked target
        const ownerRow = lockedById.get(String(Number(ownerId)));
        if (!ownerRow) continue;
        const ownerEmailRows = await emailRowsOf(ownerRow.id);
        const stillOwns = ownerEmailRows.some(r => r.email_normalized === add.normalized)
            || normEmail(ownerRow.email) === add.normalized;
        if (!stillOwns) continue; // address moved away between discovery and lock
        addConflict(ownerRow, { kind: 'email', value: add.value, normalized: add.normalized });
    }

    if (groups.size === 0) return [];

    const editing = contactComposition(target, targetEmailRows);
    const conflicts = [];
    for (const { owner, attributes } of groups.values()) {
        const ownerEmailRows = await emailRowsOf(owner.id);
        conflicts.push({
            owner: contactComposition(owner, ownerEmailRows),
            editing,
            attributes,
            transfer_allowed: computeTransferAllowed(owner, ownerEmailRows, attributes),
        });
    }
    return conflicts;
}

/**
 * The 14 identity tables carrying a `contact_id` FK to contacts(id), split by
 * whether the table also carries a `company_id` column (verified against the
 * migrations). A table WITHOUT company_id is scoped through contact_id only — the
 * dup contact is company-verified up front, so a contact_id match cannot straddle
 * tenants. EXCLUDED on purpose (they ARE the email footprint being moved, so
 * their presence must NOT block a delete): contact_emails, email_messages,
 * timelines.
 */
const IDENTITY_TABLES = [
    { table: 'jobs', hasCompanyId: true },
    { table: 'leads', hasCompanyId: true }, // leads.company_id is NOT NULL (mig 012)
    { table: 'estimates', hasCompanyId: true },
    { table: 'invoices', hasCompanyId: true },
    { table: 'payment_transactions', hasCompanyId: true },
    { table: 'stripe_payment_sessions', hasCompanyId: true },
    { table: 'portal_access_tokens', hasCompanyId: true },
    { table: 'portal_sessions', hasCompanyId: false }, // no company_id column
    { table: 'portal_events', hasCompanyId: false }, // no company_id column
    { table: 'crm_account_contacts', hasCompanyId: true },
    { table: 'crm_deal_contacts', hasCompanyId: true },
    { table: 'crm_activities', hasCompanyId: true },
    { table: 'tasks', hasCompanyId: true },
    { table: 'contact_addresses', hasCompanyId: false }, // no company_id column
];

/**
 * isContactEmailOnly — the D2a↔D2b gate.
 *
 * Returns TRUE only when the contact has NO phone_e164 AND NO secondary_phone AND
 * zero referencing rows in EVERY table of IDENTITY_TABLES — i.e. it exists solely
 * to hold email(s) and can be safely deleted by a full merge. Any phone or any
 * business row → FALSE (degrade to D2b re-point, never a wrong delete).
 *
 * Bias: err toward NOT empty. A missing contact returns FALSE (nothing to merge
 * away). Evaluated as ONE SELECT of OR-ed EXISTS(...) probes inside the tx.
 *
 * @param {number|string} contactId
 * @param {string} companyId
 * @param {{query: Function}} [client=db]
 * @returns {Promise<boolean>}
 */
async function isContactEmailOnly(contactId, companyId, client = db) {
    if (!contactId) return false;

    // The contact must live in this company; also read the phones (identity).
    const { rows: cRows } = await client.query(
        `SELECT phone_e164, secondary_phone
         FROM contacts WHERE id = $1 AND company_id = $2`,
        [contactId, companyId]
    );
    const contact = cRows[0];
    if (!contact) return false; // unknown / foreign contact → not a deletable dup
    if (contact.phone_e164 || contact.secondary_phone) return false;

    // Build one `EXISTS(...) OR EXISTS(...) …` over every identity table. $1 =
    // contactId, $2 = companyId (referenced only by the company-scoped legs).
    const existsLegs = IDENTITY_TABLES.map(({ table, hasCompanyId }) =>
        hasCompanyId
            ? `EXISTS (SELECT 1 FROM ${table} WHERE contact_id = $1 AND company_id = $2)`
            : `EXISTS (SELECT 1 FROM ${table} WHERE contact_id = $1)`
    );

    const { rows } = await client.query(
        `SELECT (${existsLegs.join(' OR ')}) AS has_identity`,
        [contactId, companyId]
    );

    // has_identity=true → the contact has real activity → NOT email-only.
    return rows[0].has_identity === false;
}

/**
 * linkInboxMessages — the shared message loop for the inbox-only and D2b re-point
 * branches. Resolves the target's timeline (adopting orphans / re-homing shadow
 * open tasks via findOrCreateTimelineByContact, inside the tx) and links every
 * message for `emailNormalized` (company-scoped) onto it. Idempotent (re-link is
 * a no-op UPDATE per linkMessageToContact semantics).
 *
 * @param {number|string} targetContactId
 * @param {string} emailNormalized
 * @param {string} companyId
 * @param {{query: Function}} [client=db]
 * @returns {Promise<number>} number of messages linked
 */
async function linkInboxMessages(targetContactId, emailNormalized, companyId, client = db) {
    const timeline = await timelinesQueries.findOrCreateTimelineByContact(
        targetContactId, companyId, client
    );
    if (!timeline) return 0; // foreign/absent target — never happens via PATCH guard

    const messageIds = await emailQueries.listMessageIdsForAddress(
        emailNormalized, companyId, client
    );
    if (messageIds.length === 0) return 0;

    for (const providerMessageId of messageIds) {
        await emailQueries.linkMessageToContact(providerMessageId, companyId, {
            contact_id: targetContactId,
            timeline_id: timeline.id,
            on_timeline: true,
        }, client);
    }
    return messageIds.length;
}

/**
 * mergeContacts — the codified full-merge dedup recipe. Re-points every contact_id
 * child from `dupId` → `survivorId`, adopts/merges the timeline, and deletes the
 * dup LAST. Generic (a future manual-merge action can reuse it); in v1 reached
 * only via resolveAddedEmail's D2a branch.
 *
 * FK order (load-bearing — CASCADE trap = ORPHAN-TASK-REHOME-001):
 *   1. Adopt/merge the survivor timeline FIRST (re-homes shadow-orphan open tasks).
 *   2. Re-home OPEN tasks off the dup timeline BEFORE any timeline delete; also
 *      re-point tasks.contact_id and tasks.subject_id (subject_type='contact').
 *   3. Re-point email_messages (contact_id + timeline_id + on_timeline).
 *   4. Re-point the SET-NULL history children (contact_id).
 *   5. Move M2M / CASCADE children with NOT-EXISTS guards (dodge unique clashes).
 *   6. DELETE the dup's timeline(s), then DELETE the dup contact LAST.
 *
 * Guard: survivor.company_id === dup.company_id === companyId, or throw — NO
 * cross-tenant merge under any circumstance.
 *
 * Return value (review fix c — the `contact_merged` audit event must NOT be
 * emitted inside the tx, or it would survive a ROLLBACK): returns the event
 * PAYLOAD `{ merged_contact_id, merged_name, dropped_phones }` (or null for
 * the self-merge no-op) — the caller (the PATCH route) emits
 * `eventService.logEvent(companyId, 'contact', survivorId, 'contact_merged', payload)`
 * strictly AFTER COMMIT. Additive: pre-existing callers that ignore the
 * return value keep working (they just don't emit the event).
 *
 * @param {number|string} survivorId
 * @param {number|string} dupId
 * @param {string} companyId
 * @param {{query: Function}} [client=db]
 * @returns {Promise<{merged_contact_id:(number|string), merged_name:(string|null), dropped_phones:string[]}|null>}
 */
async function mergeContacts(survivorId, dupId, companyId, client = db) {
    if (String(survivorId) === String(dupId)) return null; // nothing to merge into self

    // ── Tenant guard: both contacts must belong to `companyId`. A single query
    // fetches both so a foreign/absent id is caught before ANY mutation.
    const { rows: pair } = await client.query(
        `SELECT id, company_id FROM contacts WHERE id IN ($1, $2)`,
        [survivorId, dupId]
    );
    const survivor = pair.find(r => String(r.id) === String(survivorId));
    const dup = pair.find(r => String(r.id) === String(dupId));
    if (!survivor || !dup) {
        throw new Error(`[ContactEmailMerge] merge aborted: contact not found (survivor=${survivorId}, dup=${dupId})`);
    }
    if (String(survivor.company_id) !== String(companyId) ||
        String(dup.company_id) !== String(companyId)) {
        throw new Error('[ContactEmailMerge] cross-tenant merge blocked: survivor/dup company mismatch');
    }

    // 1. Adopt/merge the survivor's timeline FIRST (inside the tx). This also
    //    re-homes shadow-orphan open tasks on the survivor's own number(s).
    const survivorTl = await timelinesQueries.findOrCreateTimelineByContact(
        survivorId, companyId, client
    );
    const survivorTlId = survivorTl ? survivorTl.id : null;

    // Find the dup's own timeline(s) (dup is email-only, so contact-linked).
    const { rows: dupTls } = await client.query(
        `SELECT id FROM timelines WHERE contact_id = $1 AND company_id = $2`,
        [dupId, companyId]
    );
    const dupTlIds = dupTls.map(r => r.id);

    // 2. Re-home OPEN tasks off EACH dup timeline BEFORE deleting any timeline —
    //    tasks.thread_id is ON DELETE CASCADE, so skipping this destroys an open
    //    Action-Required task (ORPHAN-TASK-REHOME-001). Guarded on survivorTlId so
    //    we never NULL a thread_id that is NOT NULL-able historically.
    if (survivorTlId && dupTlIds.length > 0) {
        await client.query(
            `UPDATE tasks SET thread_id = $1, updated_at = now()
             WHERE thread_id = ANY($2) AND status = 'open' AND company_id = $3`,
            [survivorTlId, dupTlIds, companyId]
        );
    }
    // Re-point task ownership so history follows the survivor (contact_id is
    // SET NULL; subject_id is the CRM/Pulse subject when subject_type='contact').
    await client.query(
        `UPDATE tasks SET contact_id = $1, updated_at = now()
         WHERE contact_id = $2 AND company_id = $3`,
        [survivorId, dupId, companyId]
    );
    await client.query(
        `UPDATE tasks SET subject_id = $1, updated_at = now()
         WHERE subject_type = 'contact' AND subject_id = $2 AND company_id = $3`,
        [survivorId, dupId, companyId]
    );

    // 3. Re-point the dup's email_messages onto the survivor + its timeline.
    //    (email_threads has NO contact_id — linkage lives on the messages.)
    await client.query(
        `UPDATE email_messages
            SET contact_id = $1, timeline_id = $2, on_timeline = true, updated_at = now()
          WHERE contact_id = $3 AND company_id = $4`,
        [survivorId, survivorTlId, dupId, companyId]
    );

    // 3b. (CONTACT-MERGE-001, Decision C2) Re-point CALLS off the dup timeline(s)
    //     BEFORE any timeline delete — calls.timeline_id has NO ON DELETE action,
    //     so deleting a dup timeline still holding calls violates the FK (v1's
    //     email-only dups never had calls; a generic phone-world dup does).
    //     Served by idx_calls_timeline_id; calls carry company_id since mig 012.
    if (survivorTlId && dupTlIds.length > 0) {
        await client.query(
            `UPDATE calls
                SET timeline_id = $1, contact_id = $2
              WHERE timeline_id = ANY($3) AND company_id = $4`,
            [survivorTlId, survivorId, dupTlIds, companyId]
        );
    }
    // Sweep any remaining dup-owned calls (contact-linked without a dup timeline).
    await client.query(
        `UPDATE calls SET contact_id = $1 WHERE contact_id = $2 AND company_id = $3`,
        [survivorId, dupId, companyId]
    );

    // 3c. (CONTACT-MERGE-001, OQ-2 default) Phone-slot fill: the dup's numbers
    //     land in the survivor's FREE slots only (phone_e164 first, then
    //     secondary_phone, carrying secondary_phone_name when the filled slot is
    //     secondary and the number had a label). Overflow numbers are NOT
    //     persisted — audited via the `contact_merged` event + a warn log.
    //     Survivor scalars (full_name, company_name, notes, email,
    //     zenbooker_customer_id) are NEVER overwritten — the editor's fields
    //     win; the dup's ZB linkage dies with the dup row; NO ZB API call.
    const { rows: mergePhoneRows } = await client.query(
        `SELECT id, full_name, phone_e164, secondary_phone, secondary_phone_name
           FROM contacts
          WHERE id IN ($1, $2) AND company_id = $3`,
        [survivorId, dupId, companyId]
    );
    const survPhones = mergePhoneRows.find(r => String(r.id) === String(survivorId));
    const dupPhones = mergePhoneRows.find(r => String(r.id) === String(dupId));
    let mergedEvent = null;
    if (survPhones && dupPhones) {
        const donorNumbers = [];
        if (dupPhones.phone_e164) {
            donorNumbers.push({ value: dupPhones.phone_e164, label: null });
        }
        if (dupPhones.secondary_phone) {
            donorNumbers.push({ value: dupPhones.secondary_phone, label: dupPhones.secondary_phone_name || null });
        }

        const survDigits = new Set(
            [digitsOf(survPhones.phone_e164), digitsOf(survPhones.secondary_phone)].filter(Boolean)
        );
        let primaryFree = !survPhones.phone_e164;
        let secondaryFree = !survPhones.secondary_phone;
        const setClauses = [];
        const setParams = [];
        const droppedPhones = [];
        for (const num of donorNumbers) {
            const d = digitsOf(num.value);
            if (!d || survDigits.has(d)) continue; // survivor already holds it — neither fill nor drop
            if (primaryFree) {
                setParams.push(num.value);
                setClauses.push(`phone_e164 = $${setParams.length}`);
                primaryFree = false;
                survDigits.add(d);
            } else if (secondaryFree) {
                setParams.push(num.value);
                setClauses.push(`secondary_phone = $${setParams.length}`);
                if (num.label) {
                    setParams.push(num.label);
                    setClauses.push(`secondary_phone_name = $${setParams.length}`);
                }
                secondaryFree = false;
                survDigits.add(d);
            } else {
                droppedPhones.push(num.value);
            }
        }
        if (setClauses.length > 0) {
            setParams.push(survivorId, companyId);
            await client.query(
                `UPDATE contacts SET ${setClauses.join(', ')}, updated_at = now()
                  WHERE id = $${setParams.length - 1} AND company_id = $${setParams.length}`,
                setParams
            );
        }
        if (droppedPhones.length > 0) {
            // Documented v1 limitation: a dropped number's CALLS still moved (3b,
            // timeline-bound), but its SMS conversation stops surfacing on the
            // survivor row (query-time digit match; rows NOT deleted).
            console.warn(
                `[ContactEmailMerge] merge ${dupId}→${survivorId}: overflow phone(s) not persisted: ${droppedPhones.join(', ')} (no free slot; recorded in contact_merged event)`
            );
        }
        // Audit-event PAYLOAD (visible in contact history). NOT emitted here —
        // returned to the caller so the route logs it AFTER COMMIT (review fix c:
        // an in-tx emission would survive a ROLLBACK, since logEvent writes on
        // the pool, not the tx client).
        mergedEvent = {
            merged_contact_id: dupId,
            merged_name: dupPhones.full_name || null,
            dropped_phones: droppedPhones,
        };
    }

    // 4. Re-point the SET-NULL history children (contact_id follows the survivor).
    //    In the D2a path these are all empty by the emptiness test → 0 rows; done
    //    unconditionally so the recipe is safe for a future generic manual-merge.
    //    leads carries company_id (NOT NULL, mig 012) → company-scoped like the rest.
    await client.query(`UPDATE jobs      SET contact_id = $1 WHERE contact_id = $2 AND company_id = $3`, [survivorId, dupId, companyId]);
    await client.query(`UPDATE leads     SET contact_id = $1 WHERE contact_id = $2 AND company_id = $3`, [survivorId, dupId, companyId]);
    await client.query(`UPDATE estimates SET contact_id = $1 WHERE contact_id = $2 AND company_id = $3`, [survivorId, dupId, companyId]);
    await client.query(`UPDATE invoices  SET contact_id = $1 WHERE contact_id = $2 AND company_id = $3`, [survivorId, dupId, companyId]);
    await client.query(`UPDATE payment_transactions    SET contact_id = $1 WHERE contact_id = $2 AND company_id = $3`, [survivorId, dupId, companyId]);
    await client.query(`UPDATE stripe_payment_sessions SET contact_id = $1 WHERE contact_id = $2 AND company_id = $3`, [survivorId, dupId, companyId]);
    await client.query(`UPDATE portal_events SET contact_id = $1 WHERE contact_id = $2`, [survivorId, dupId]); // no company_id
    await client.query(`UPDATE crm_activities SET contact_id = $1 WHERE contact_id = $2 AND company_id = $3`, [survivorId, dupId, companyId]);

    // Re-point leads.contact_address_id onto surviving addresses BEFORE the M2M
    // address move (a lead may point at a dup address row about to move/collide).
    // Null out any that still reference a dup address after the move (step 5) —
    // handled below.

    // 5. Move M2M / CASCADE children with NOT-EXISTS guards so a would-be duplicate
    //    stays on the dup and dies with its CASCADE delete (never a unique clash).

    // contact_emails — UNIQUE(contact_id, email_normalized).
    await client.query(
        `UPDATE contact_emails ce
            SET contact_id = $1
          WHERE ce.contact_id = $2
            AND NOT EXISTS (
                SELECT 1 FROM contact_emails s
                 WHERE s.contact_id = $1 AND s.email_normalized = ce.email_normalized)`,
        [survivorId, dupId]
    );

    // contact_addresses — DUAL partial-unique: (contact_id, google_place_id) WHERE
    // google_place_id IS NOT NULL, and (contact_id, address_normalized_hash) WHERE
    // hash IS NOT NULL. Guard on BOTH keys (no company_id column). Capture the
    // dup's addresses first so we can re-point leads.contact_address_id, then null
    // stragglers still pointing at an about-to-die dup address.
    const { rows: dupAddrs } = await client.query(
        `SELECT id, google_place_id, address_normalized_hash
         FROM contact_addresses WHERE contact_id = $1`,
        [dupId]
    );
    await client.query(
        `UPDATE contact_addresses ca
            SET contact_id = $1
          WHERE ca.contact_id = $2
            AND NOT EXISTS (
                SELECT 1 FROM contact_addresses s
                 WHERE s.contact_id = $1
                   AND s.google_place_id IS NOT NULL
                   AND ca.google_place_id IS NOT NULL
                   AND s.google_place_id = ca.google_place_id)
            AND NOT EXISTS (
                SELECT 1 FROM contact_addresses s
                 WHERE s.contact_id = $1
                   AND s.address_normalized_hash IS NOT NULL
                   AND ca.address_normalized_hash IS NOT NULL
                   AND s.address_normalized_hash = ca.address_normalized_hash)`,
        [survivorId, dupId]
    );
    // Any dup address that did NOT move (a collision) will vanish with the dup's
    // CASCADE delete; null out leads still referencing such a row so the CASCADE
    // does not orphan the FK. (leads carries company_id, mig 012 → company-scoped.)
    if (dupAddrs.length > 0) {
        const stragglerIds = dupAddrs.map(a => a.id);
        await client.query(
            `UPDATE leads SET contact_address_id = NULL
              WHERE contact_address_id = ANY($1)
                AND company_id = $3
                AND contact_address_id IN (
                    SELECT id FROM contact_addresses WHERE contact_id = $2)`,
            [stragglerIds, dupId, companyId]
        );
    }

    // crm_account_contacts — UNIQUE(company_id, account_id, contact_id).
    await client.query(
        `UPDATE crm_account_contacts m
            SET contact_id = $1
          WHERE m.contact_id = $2 AND m.company_id = $3
            AND NOT EXISTS (
                SELECT 1 FROM crm_account_contacts s
                 WHERE s.contact_id = $1 AND s.company_id = $3
                   AND s.account_id = m.account_id)`,
        [survivorId, dupId, companyId]
    );

    // crm_deal_contacts — UNIQUE(company_id, deal_id, contact_id, role).
    await client.query(
        `UPDATE crm_deal_contacts m
            SET contact_id = $1
          WHERE m.contact_id = $2 AND m.company_id = $3
            AND NOT EXISTS (
                SELECT 1 FROM crm_deal_contacts s
                 WHERE s.contact_id = $1 AND s.company_id = $3
                   AND s.deal_id = m.deal_id AND s.role = m.role)`,
        [survivorId, dupId, companyId]
    );

    // portal_access_tokens — no per-contact unique; just re-point (company-scoped).
    await client.query(
        `UPDATE portal_access_tokens SET contact_id = $1 WHERE contact_id = $2 AND company_id = $3`,
        [survivorId, dupId, companyId]
    );
    // portal_sessions — no company_id column → contact-scoped.
    await client.query(
        `UPDATE portal_sessions SET contact_id = $1 WHERE contact_id = $2`,
        [survivorId, dupId]
    );

    // 6. Delete the now-emptied dup timeline(s), then the dup contact LAST. All
    //    contact_id children have been re-pointed or duplicate-collided; residual
    //    CASCADE children drop cleanly. timelines.contact_id is SET NULL, so the
    //    dup contact delete would otherwise leave a stray timeline — delete them.
    if (dupTlIds.length > 0) {
        await client.query(
            `DELETE FROM timelines WHERE id = ANY($1) AND company_id = $2`,
            [dupTlIds, companyId]
        );
    }
    await client.query(
        `DELETE FROM contacts WHERE id = $1 AND company_id = $2`,
        [dupId, companyId]
    );

    return mergedEvent;
}

/**
 * resolveAddedEmail — the per-address entry point the PATCH route calls for each
 * newly-added address. Resolves who currently owns `emailNormalized` within
 * `companyId` (findEmailContact), then dispatches:
 *
 *   • owner = none (inbox-only)        → linkInboxMessages (link onto target)
 *   • owner = separate, email-only     → mergeContacts(survivor=target, dup=owner)
 *   • owner = separate, has identity   → re-point ONLY this address's messages
 *                                        (linkInboxMessages; owner NOT deleted)
 *   • owner = the target itself        → no-op (idempotent re-save)
 *
 * The whole entry point is idempotent. Company-scoped on every leg. Never reaches
 * into another tenant (findEmailContact is company-scoped; a company-B owner of
 * the same address string is invisible → treated as inbox-only for A with zero
 * A-messages to link).
 *
 * @param {number|string} targetContactId
 * @param {string} emailNormalized  already lower(trim)'d address
 * @param {string} companyId
 * @param {{query: Function}} [client=db]
 */
async function resolveAddedEmail(targetContactId, emailNormalized, companyId, client = db) {
    const normalized = String(emailNormalized || '').trim().toLowerCase();
    if (!normalized) return;

    const owner = await emailQueries.findEmailContact(normalized, companyId, client);

    // Owner is the target itself (or unchanged re-save) → no-op.
    if (owner && String(owner.id) === String(targetContactId)) {
        return;
    }

    // No owner within this company → inbox-only: link any unowned messages for
    // this address onto the target. (Cross-tenant safety: a company-B owner is
    // NOT seen here, and its messages carry company_id=B so they are never
    // listed/linked by the company-A-scoped loop.)
    if (!owner) {
        await linkInboxMessages(targetContactId, normalized, companyId, client);
        return;
    }

    // A separate owner exists within this company → CONTACT-MERGE-001 "no silent
    // path left" (Decision B): BOTH former branches — the D2a full auto-merge of
    // an email-only owner AND the D2b silent re-point of a data-bearing owner's
    // messages — now throw the sentinel instead of acting. The only caller is
    // the PATCH route, which catches it → ROLLBACK → fresh 409, so even an owner
    // born INSIDE the tx (after detection) is never silently destroyed/stripped.
    throw new ContactConflictError(owner.id, [
        { kind: 'email', value: normalized, normalized },
    ]);
}

/**
 * transferPhone (CONTACT-MERGE-001, Decision D / FR-5) — move ONE number (and
 * only its calls) off the owner. The number lands on the TARGET via the normal
 * PATCH field UPDATE (Decision C step 3), NOT here.
 *
 *   1. Clear the owner slot matching by digits (full or last-10). OQ-3 (decided
 *      YES): clearing phone_e164 while secondary_phone is set promotes
 *      secondary→primary and NULLs secondary_phone + secondary_phone_name (the
 *      label names the secondary slot — accepted micro-loss).
 *   2. Re-point ONLY this number's calls from the owner's timeline(s) onto the
 *      target's (findOrCreateTimelineByContact adopts orphans + re-homes
 *      shadow-orphan open tasks). Never an unscoped digit sweep — the filter is
 *      bounded by the owner's timeline ids (idx_calls_timeline_id).
 *   3. SMS: NO write — the Pulse digit-lateral flips the conversation at query
 *      time once the target carries the number and the owner's slot is clear.
 *
 * Idempotent: a re-run finds no matching slot (no UPDATE) and 0 calls left on
 * the owner timeline. The owner contact is NEVER deleted here. Company-scoped
 * on every leg; a foreign/absent owner touches 0 rows.
 *
 * @param {number|string} targetId
 * @param {number|string} ownerId
 * @param {string} digits  the transferred number (any format; digits extracted)
 * @param {string} companyId
 * @param {{query: Function}} [client=db]
 */
async function transferPhone(targetId, ownerId, digits, companyId, client = db) {
    const d = digitsOf(digits);
    if (!d) return;
    const last10 = d.slice(-10);

    // Lock + read the owner (company-scoped). Foreign/absent → 0 rows touched.
    const { rows: oRows } = await client.query(
        `SELECT id, phone_e164, secondary_phone, secondary_phone_name
           FROM contacts
          WHERE id = $1 AND company_id = $2
            FOR UPDATE`,
        [ownerId, companyId]
    );
    const owner = oRows[0];
    if (!owner) return;

    const matches = (v) => {
        const od = digitsOf(v);
        return !!od && (od === d || od.slice(-10) === last10);
    };

    // 1. Clear the matched slot (OQ-3 promotion when primary goes and secondary stays).
    //    Review fix b: when the SAME number occupies BOTH slots (last-10 match),
    //    promotion would copy the transferred number straight back into
    //    phone_e164 — clear BOTH slots instead (nothing else to promote).
    const primaryMatches = matches(owner.phone_e164);
    const secondaryMatches = matches(owner.secondary_phone);
    if (primaryMatches && secondaryMatches) {
        await client.query(
            `UPDATE contacts
                SET phone_e164 = NULL,
                    secondary_phone = NULL,
                    secondary_phone_name = NULL,
                    updated_at = now()
              WHERE id = $1 AND company_id = $2`,
            [ownerId, companyId]
        );
    } else if (primaryMatches) {
        if (owner.secondary_phone) {
            await client.query(
                `UPDATE contacts
                    SET phone_e164 = secondary_phone,
                        secondary_phone = NULL,
                        secondary_phone_name = NULL,
                        updated_at = now()
                  WHERE id = $1 AND company_id = $2`,
                [ownerId, companyId]
            );
        } else {
            await client.query(
                `UPDATE contacts SET phone_e164 = NULL, updated_at = now()
                  WHERE id = $1 AND company_id = $2`,
                [ownerId, companyId]
            );
        }
    } else if (secondaryMatches) {
        await client.query(
            `UPDATE contacts
                SET secondary_phone = NULL, secondary_phone_name = NULL, updated_at = now()
              WHERE id = $1 AND company_id = $2`,
            [ownerId, companyId]
        );
    }
    // else: slot already clear (idempotent re-run) — fall through to a 0-row calls UPDATE.

    // 2. Re-point ONLY this number's calls (owner timeline(s) → target timeline).
    const targetTl = await timelinesQueries.findOrCreateTimelineByContact(targetId, companyId, client);
    if (!targetTl) return; // foreign/absent target — never happens via the PATCH guard
    const { rows: ownerTls } = await client.query(
        `SELECT id FROM timelines WHERE contact_id = $1 AND company_id = $2`,
        [ownerId, companyId]
    );
    const ownerTlIds = ownerTls.map(r => r.id);
    if (ownerTlIds.length > 0) {
        await client.query(
            `UPDATE calls
                SET timeline_id = $1, contact_id = $2
              WHERE timeline_id = ANY($3) AND company_id = $4
                AND (RIGHT(NULLIF(regexp_replace(from_number, '\\D', '', 'g'), ''), 10) = $5
                  OR RIGHT(NULLIF(regexp_replace(to_number, '\\D', '', 'g'), ''), 10) = $5)`,
            [targetTl.id, targetId, ownerTlIds, companyId, last10]
        );
    }
    // 3. SMS: intentionally NO write (query-time digit resolution).
}

/**
 * transferEmail (CONTACT-MERGE-001, Decision D / FR-6) — move ONE address (and
 * its messages) off the owner. Unlike old D2b, the address is REMOVED from the
 * owner — single ownership (AC-4). The target-side contact_emails upsert +
 * primary reconcile is the PATCH email block's job, NOT done here.
 *
 *   1. DELETE the owner's contact_emails row for the address (contact-scoped —
 *      the owner id is company-verified by the lock above; mig 025 has no
 *      company_id column).
 *   2. Scalar sync: if the transferred address was the owner's scalar
 *      contacts.email, point the scalar at the remaining primary-or-first
 *      contact_emails row (or NULL).
 *   3. linkInboxMessages(target, …) re-points every email_messages row of the
 *      address onto the TARGET's timeline (reused loop; idempotent re-link).
 *
 * Idempotent: a re-run deletes no row, syncs nothing (the scalar no longer
 * matches) and the re-link no-ops. The owner contact is NEVER deleted here.
 *
 * @param {number|string} targetId
 * @param {number|string} ownerId
 * @param {string} emailNormalized  the transferred address (normalized defensively)
 * @param {string} companyId
 * @param {{query: Function}} [client=db]
 */
async function transferEmail(targetId, ownerId, emailNormalized, companyId, client = db) {
    const normalized = normEmail(emailNormalized);
    if (!normalized) return;

    // Lock + read the owner (company-scoped). Foreign/absent → 0 rows touched.
    const { rows: oRows } = await client.query(
        `SELECT id, email FROM contacts
          WHERE id = $1 AND company_id = $2
            FOR UPDATE`,
        [ownerId, companyId]
    );
    const owner = oRows[0];
    if (!owner) return;

    // 1. Remove the address from the owner (single ownership).
    await client.query(
        `DELETE FROM contact_emails WHERE contact_id = $1 AND email_normalized = $2`,
        [ownerId, normalized]
    );

    // 2. Scalar sync when the transferred address was the owner's scalar email.
    if (normEmail(owner.email) === normalized) {
        const { rows: remaining } = await client.query(
            `SELECT email FROM contact_emails
              WHERE contact_id = $1
              ORDER BY is_primary DESC, id ASC
              LIMIT 1`,
            [ownerId]
        );
        await client.query(
            `UPDATE contacts SET email = $1, updated_at = now()
              WHERE id = $2 AND company_id = $3`,
            [remaining[0] ? remaining[0].email : null, ownerId, companyId]
        );
    }

    // 3. Every message of the address lands on the TARGET's timeline (reused, idempotent).
    await linkInboxMessages(targetId, normalized, companyId, client);
}

module.exports = {
    resolveAddedEmail,
    mergeContacts,
    isContactEmailOnly,
    linkInboxMessages,
    IDENTITY_TABLES,
    // CONTACT-MERGE-001 additions (append-only — the 5 exports above are load-bearing):
    detectAttributeConflicts,
    transferPhone,
    transferEmail,
    assertTransferAllowed,
    ContactConflictError,
};
