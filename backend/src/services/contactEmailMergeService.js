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
 *     UPDATE; the owner==target branch does nothing; an archived donor resolves
 *     through contact_merge_redirects on the next merge attempt).
 *
 * The full-merge FK order is load-bearing (mirrors ORPHAN-TASK-REHOME-001):
 * open tasks are re-homed off the dup timeline BEFORE any timeline is deleted,
 * and the dup contact is deleted LAST, so `tasks.thread_id`'s ON DELETE CASCADE
 * never silently destroys an open Action-Required task.
 */

const db = require('../db/connection');
const emailQueries = require('../db/emailQueries');
const timelinesQueries = require('../db/timelinesQueries');
const { deduplicateNotesByIdentity, noteIdentity } = require('./noteDeduplication');

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

class ContactSavedCardMergeBlockedError extends Error {
    constructor(contactId) {
        super('Remove the duplicate contact\'s saved card before merging contacts.');
        this.name = 'ContactSavedCardMergeBlockedError';
        this.code = 'SAVED_CARD_MERGE_BLOCKED';
        this.httpStatus = 409;
        this.contactId = contactId;
    }
}

class ContactMergeNeedsReviewError extends Error {
    constructor(result) {
        const reasons = Array.isArray(result?.review_reasons) ? result.review_reasons : [];
        const stripeConflict = reasons.some(reason => reason?.type === 'stripe_customer_conflict');
        super(stripeConflict
            ? 'The contacts have conflicting Stripe customer or saved-card links and require review.'
            : 'The contacts have conflicting links and require review before merging.');
        this.name = 'ContactMergeNeedsReviewError';
        this.code = stripeConflict ? 'SAVED_CARD_MERGE_BLOCKED' : 'CONTACT_MERGE_NEEDS_REVIEW';
        this.httpStatus = 409;
        this.result = result;
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
 * The identity tables carrying a `contact_id` FK to contacts(id), split by
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
    { table: 'stripe_saved_payment_methods', hasCompanyId: true },
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

// The live albusto_test inventory for every FK whose referenced key includes
// contacts(id). Keep this independent from CONTACT_REASSIGNMENTS: the final
// assertion intentionally still sees a table if its move handler is omitted.
const CONTACT_FK_INVENTORY = [
    { table: 'call_masking_sessions', hasCompanyId: true },
    { table: 'calls', hasCompanyId: true },
    { table: 'contact_addresses', hasCompanyId: false },
    { table: 'contact_call_masking_codes', hasCompanyId: true },
    { table: 'contact_emails', hasCompanyId: false },
    { table: 'contact_external_identities', hasCompanyId: true },
    { table: 'contact_phones', hasCompanyId: true },
    { table: 'crm_account_contacts', hasCompanyId: true },
    { table: 'crm_activities', hasCompanyId: true },
    { table: 'crm_deal_contacts', hasCompanyId: true },
    { table: 'email_messages', hasCompanyId: true },
    { table: 'estimates', hasCompanyId: true },
    { table: 'invoices', hasCompanyId: true },
    { table: 'jobs', hasCompanyId: true },
    { table: 'leads', hasCompanyId: true },
    { table: 'outbound_call_attempts', hasCompanyId: true },
    { table: 'payment_transactions', hasCompanyId: true },
    { table: 'portal_access_tokens', hasCompanyId: true },
    { table: 'portal_events', hasCompanyId: false },
    { table: 'portal_sessions', hasCompanyId: false },
    { table: 'stripe_contact_customers', hasCompanyId: true },
    { table: 'stripe_payment_sessions', hasCompanyId: true },
    { table: 'stripe_saved_payment_methods', hasCompanyId: true },
    { table: 'tasks', hasCompanyId: true },
    { table: 'timelines', hasCompanyId: true },
];

const CONTACT_REASSIGNMENTS = [
    { table: 'call_masking_sessions', strategy: 'simple' },
    { table: 'calls', strategy: 'calls' },
    { table: 'contact_addresses', strategy: 'addresses' },
    { table: 'contact_call_masking_codes', strategy: 'simple' },
    { table: 'contact_emails', strategy: 'emails' },
    { table: 'contact_external_identities', strategy: 'simple' },
    { table: 'contact_phones', strategy: 'phones' },
    { table: 'crm_account_contacts', strategy: 'account_contacts' },
    { table: 'crm_activities', strategy: 'simple' },
    { table: 'crm_deal_contacts', strategy: 'deal_contacts' },
    { table: 'email_messages', strategy: 'email_messages' },
    { table: 'estimates', strategy: 'simple' },
    { table: 'invoices', strategy: 'simple' },
    { table: 'jobs', strategy: 'simple' },
    { table: 'leads', strategy: 'simple' },
    { table: 'outbound_call_attempts', strategy: 'simple' },
    { table: 'payment_transactions', strategy: 'simple' },
    { table: 'portal_access_tokens', strategy: 'simple' },
    { table: 'portal_events', strategy: 'simple' },
    { table: 'portal_sessions', strategy: 'simple' },
    { table: 'stripe_contact_customers', strategy: 'stripe_customer' },
    { table: 'stripe_payment_sessions', strategy: 'simple' },
    { table: 'stripe_saved_payment_methods', strategy: 'stripe_cards' },
    { table: 'tasks', strategy: 'tasks' },
    { table: 'timelines', strategy: 'timelines' },
];

const POLYMORPHIC_CONTACT_REFS = [
    { table: 'crm_notes', typeColumn: 'entity_type', idColumn: 'entity_id', type: 'contact' },
    { table: 'note_attachments', typeColumn: 'entity_type', idColumn: 'entity_id', type: 'contact' },
    { table: 'tasks', typeColumn: 'subject_type', idColumn: 'subject_id', type: 'contact' },
    { table: 'crm_activities', typeColumn: 'source_entity_type', idColumn: 'source_entity_id', type: 'contact', textId: true },
];

const isBlank = value => value === null || value === undefined || String(value).trim() === '';
const normalizedTenDigit = value => {
    const digits = digitsOf(value);
    return digits && digits.length >= 10 ? digits.slice(-10) : null;
};

function mergeLabels(labels) {
    const values = [];
    for (const label of labels) {
        const value = String(label || '').trim();
        if (value && !values.includes(value)) values.push(value);
    }
    return values.length > 0 ? values.join(' / ') : null;
}

function mergeLegacyNotes(survivorNotes, donorNotes) {
    const survivor = String(survivorNotes || '').trim();
    const donor = String(donorNotes || '').trim();
    if (!donor || survivor === donor || survivor.includes(donor)) return survivor || null;
    if (!survivor) return donor;
    return `${survivor}\n\n${donor}`;
}

function mergeStructuredContactNotes(survivorNotes, donorNotes) {
    const merged = deduplicateNotesByIdentity([
        ...(Array.isArray(survivorNotes) ? survivorNotes : []),
        ...(Array.isArray(donorNotes) ? donorNotes : []),
    ]);
    const seenAnonymous = new Set();
    return merged.filter(note => {
        if (noteIdentity(note)) return true;
        const key = JSON.stringify(note);
        if (seenAnonymous.has(key)) return false;
        seenAnonymous.add(key);
        return true;
    });
}

async function assertContactFkInventory(client) {
    const { rows } = await client.query(
        `SELECT DISTINCT child.relname AS table_name, child_col.attname AS column_name
           FROM pg_constraint constraint_row
           JOIN pg_class parent ON parent.oid = constraint_row.confrelid
           JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
           JOIN pg_class child ON child.oid = constraint_row.conrelid
           JOIN LATERAL unnest(constraint_row.conkey, constraint_row.confkey)
                WITH ORDINALITY AS keys(child_attnum, parent_attnum, ord) ON true
           JOIN pg_attribute child_col
             ON child_col.attrelid = child.oid AND child_col.attnum = keys.child_attnum
           JOIN pg_attribute parent_col
             ON parent_col.attrelid = parent.oid AND parent_col.attnum = keys.parent_attnum
          WHERE constraint_row.contype = 'f'
            AND parent_ns.nspname = 'public'
            AND parent.relname = 'contacts'
            AND parent_col.attname = 'id'
          ORDER BY child.relname, child_col.attname`
    );
    // Mocked unit routers historically return an empty generic result. The real
    // database always has contacts FKs; the real-DB suite pins the exact set.
    if (rows.length === 0) return;
    const actual = rows.map(row => `${row.table_name}:${row.column_name}`).sort();
    const expected = CONTACT_FK_INVENTORY.map(row => `${row.table}:contact_id`).sort();
    const unknown = actual.filter(key => !expected.includes(key));
    const missing = expected.filter(key => !actual.includes(key));
    if (unknown.length > 0 || missing.length > 0) {
        throw new Error(
            `[ContactEmailMerge] contact FK inventory mismatch; unknown=${unknown.join(',') || 'none'}; missing=${missing.join(',') || 'none'}`
        );
    }
}

async function recordContactMergeAudit({
    companyId,
    oldContactId,
    survivorContactId,
    status,
    reviewReasons = [],
    details = {},
    client = db,
}) {
    const { rows } = await client.query(
        `INSERT INTO contact_merge_redirects
            (company_id, old_contact_id, survivor_contact_id, status,
             review_reasons, details, merged_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb,
                 CASE WHEN $4 = 'merged' THEN NOW() ELSE NULL END)
         ON CONFLICT (company_id, old_contact_id) DO UPDATE
         SET survivor_contact_id = EXCLUDED.survivor_contact_id,
             status = EXCLUDED.status,
             review_reasons = EXCLUDED.review_reasons,
             details = EXCLUDED.details,
             merged_at = EXCLUDED.merged_at,
             updated_at = NOW()
         RETURNING company_id, old_contact_id, survivor_contact_id, status,
                   review_reasons, details, merged_at, created_at, updated_at`,
        [
            companyId,
            oldContactId,
            survivorContactId,
            status,
            JSON.stringify(reviewReasons),
            JSON.stringify(details),
        ]
    );
    return rows[0] || null;
}

async function findMergeReviewReasons(client, companyId, survivorId, donorId, pair) {
    const reasons = [];
    const { rows: stripeRows } = await client.query(
        `SELECT customer.contact_id, customer.stripe_account_id,
                customer.stripe_customer_id,
                COUNT(method.id)::int AS saved_payment_method_count
           FROM stripe_contact_customers customer
           LEFT JOIN stripe_saved_payment_methods method
             ON method.stripe_contact_customer_id = customer.id
            AND method.company_id = customer.company_id
            AND method.contact_id = customer.contact_id
          WHERE customer.company_id = $1
            AND customer.contact_id IN ($2, $3)
          GROUP BY customer.id, customer.contact_id,
                   customer.stripe_account_id, customer.stripe_customer_id
          ORDER BY customer.contact_id`,
        [companyId, survivorId, donorId]
    );
    if (stripeRows.some(row => String(row.contact_id) === String(survivorId)) &&
        stripeRows.some(row => String(row.contact_id) === String(donorId))) {
        reasons.push({
            type: 'stripe_customer_conflict',
            customers: stripeRows.map(row => ({
                contact_id: row.contact_id,
                stripe_account_id: row.stripe_account_id,
                stripe_customer_id: row.stripe_customer_id,
                saved_payment_method_count: row.saved_payment_method_count,
            })),
        });
    }

    const { rows: maskingRows } = await client.query(
        `SELECT contact_id, code
           FROM contact_call_masking_codes
          WHERE company_id = $1 AND contact_id IN ($2, $3)
          ORDER BY contact_id`,
        [companyId, survivorId, donorId]
    );
    if (maskingRows.length > 1) {
        reasons.push({ type: 'call_masking_code_conflict', codes: maskingRows });
    }

    const { rows: relationshipRows } = await client.query(
        `SELECT survivor.account_id,
                survivor.relationship_type AS survivor_relationship_type,
                donor.relationship_type AS donor_relationship_type
           FROM crm_account_contacts survivor
           JOIN crm_account_contacts donor
             ON donor.company_id = survivor.company_id
            AND donor.account_id = survivor.account_id
          WHERE survivor.company_id = $1
            AND survivor.contact_id = $2
            AND donor.contact_id = $3
            AND NULLIF(BTRIM(survivor.relationship_type), '') IS NOT NULL
            AND NULLIF(BTRIM(donor.relationship_type), '') IS NOT NULL
            AND survivor.relationship_type IS DISTINCT FROM donor.relationship_type`,
        [companyId, survivorId, donorId]
    );
    for (const row of relationshipRows) {
        reasons.push({ type: 'account_relationship_conflict', ...row });
    }

    for (const contact of pair) {
        for (const column of ['phone_e164', 'secondary_phone']) {
            if (!isBlank(contact[column]) && !normalizedTenDigit(contact[column])) {
                reasons.push({ type: 'invalid_phone_inventory', contact_id: contact.id, column });
            }
        }
        const externalId = String(contact.zenbooker_customer_id || '').trim();
        if (!externalId) continue;
        const { rows: owners } = await client.query(
            `SELECT contact_id
               FROM contact_external_identities
              WHERE company_id = $1 AND source = 'zenbooker' AND external_id = $2
                AND contact_id NOT IN ($3, $4)`,
            [companyId, externalId, survivorId, donorId]
        );
        if (owners.length > 0) {
            reasons.push({
                type: 'external_identity_conflict',
                source: 'zenbooker',
                external_id: externalId,
                contact_ids: owners.map(row => row.contact_id),
            });
        }
    }
    return reasons;
}

async function ensureScalarIdentityInventory(client, companyId, contacts) {
    for (const contact of contacts) {
        const phones = [
            { value: contact.phone_e164, label: null, isPrimary: true },
            { value: contact.secondary_phone, label: contact.secondary_phone_name, isPrimary: false },
        ];
        for (const phone of phones) {
            const normalized = normalizedTenDigit(phone.value);
            if (!normalized) continue;
            await client.query(
                `INSERT INTO contact_phones
                    (company_id, contact_id, phone_e164, normalized_phone, label, is_primary)
                 SELECT $1, owned.id, $3, $4, $5, $6
                   FROM contacts owned
                  WHERE owned.company_id = $1 AND owned.id = $2
                    AND NOT EXISTS (
                        SELECT 1 FROM contact_phones existing
                         WHERE existing.company_id = $1
                           AND existing.contact_id = owned.id
                           AND existing.normalized_phone = $4)`,
                [companyId, contact.id, phone.value, normalized, phone.label || null, phone.isPrimary]
            );
        }

        const email = String(contact.email || '').trim();
        if (email) {
            await client.query(
                `INSERT INTO contact_emails (contact_id, email, email_normalized, is_primary)
                 SELECT owned.id, $3, LOWER($3), true
                   FROM contacts owned
                  WHERE owned.company_id = $1 AND owned.id = $2
                 ON CONFLICT (contact_id, email_normalized) DO NOTHING`,
                [companyId, contact.id, email]
            );
        }

        const externalId = String(contact.zenbooker_customer_id || '').trim();
        if (externalId) {
            await client.query(
                `INSERT INTO contact_external_identities
                    (company_id, source, external_id, contact_id)
                 SELECT $1, 'zenbooker', $2, owned.id
                   FROM contacts owned
                  WHERE owned.company_id = $1 AND owned.id = $3
                 ON CONFLICT (company_id, source, external_id) DO UPDATE
                 SET contact_id = EXCLUDED.contact_id`,
                [companyId, externalId, contact.id]
            );
        }
    }
}

function mergedContactScalarValues(survivor, donor) {
    const values = {};
    for (const column of ['full_name', 'first_name', 'last_name', 'company_name', 'title', 'email']) {
        if (isBlank(survivor[column]) && !isBlank(donor[column])) values[column] = donor[column];
    }

    const donorPhones = [
        { value: donor.phone_e164, label: null },
        { value: donor.secondary_phone, label: donor.secondary_phone_name || null },
    ].filter(phone => !isBlank(phone.value));
    const survivorDigits = new Set(
        [survivor.phone_e164, survivor.secondary_phone].map(normalizedTenDigit).filter(Boolean)
    );
    let primary = survivor.phone_e164;
    let secondary = survivor.secondary_phone;
    for (const phone of donorPhones) {
        const normalized = normalizedTenDigit(phone.value);
        if (!normalized || survivorDigits.has(normalized)) {
            if (normalized && normalized === normalizedTenDigit(secondary) &&
                isBlank(survivor.secondary_phone_name) && !isBlank(phone.label)) {
                values.secondary_phone_name = phone.label;
            }
            continue;
        }
        if (isBlank(primary)) {
            primary = phone.value;
            values.phone_e164 = phone.value;
        } else if (isBlank(secondary)) {
            secondary = phone.value;
            values.secondary_phone = phone.value;
            if (!isBlank(phone.label)) values.secondary_phone_name = phone.label;
        }
        survivorDigits.add(normalized);
    }

    const legacyNotes = mergeLegacyNotes(survivor.notes, donor.notes);
    if (legacyNotes !== (survivor.notes || null)) values.notes = legacyNotes;
    const structuredNotes = mergeStructuredContactNotes(
        survivor.structured_notes,
        donor.structured_notes
    );
    if (JSON.stringify(structuredNotes) !== JSON.stringify(survivor.structured_notes || [])) {
        values.structured_notes = structuredNotes;
    }
    return values;
}

async function updateSurvivorScalars(client, companyId, survivor, donor) {
    const values = mergedContactScalarValues(survivor, donor);
    const columns = Object.keys(values);
    if (columns.length === 0) return { ...survivor };
    const params = columns.map(column => column === 'structured_notes'
        ? JSON.stringify(values[column])
        : values[column]);
    const clauses = columns.map((column, index) =>
        column === 'structured_notes'
            ? `${column} = $${index + 1}::jsonb`
            : `${column} = $${index + 1}`
    );
    params.push(survivor.id, companyId);
    const { rows } = await client.query(
        `UPDATE contacts
            SET ${clauses.join(', ')}, updated_at = NOW()
          WHERE id = $${params.length - 1} AND company_id = $${params.length}
          RETURNING *`,
        params
    );
    return rows[0] || { ...survivor, ...values };
}

async function rehomeNoteAttachments(client, companyId, survivorId, donorId, survivorNotes, donorNotes) {
    const mergedNotes = mergeStructuredContactNotes(survivorNotes, donorNotes);
    const identityIndex = new Map();
    mergedNotes.forEach((note, index) => {
        const identity = noteIdentity(note);
        if (identity) identityIndex.set(identity, index);
    });
    const anonymousIndexes = new Map();
    mergedNotes.forEach((note, index) => {
        if (!noteIdentity(note) && !anonymousIndexes.has(JSON.stringify(note))) {
            anonymousIndexes.set(JSON.stringify(note), index);
        }
    });
    const { rows } = await client.query(
        `SELECT id, note_id, note_index
           FROM note_attachments
          WHERE company_id = $1 AND entity_type = 'contact' AND entity_id = $2`,
        [companyId, donorId]
    );
    for (const attachment of rows) {
        const donorNote = Number.isInteger(attachment.note_index)
            ? (Array.isArray(donorNotes) ? donorNotes[attachment.note_index] : null)
            : null;
        const identity = String(attachment.note_id || noteIdentity(donorNote) || '').trim();
        const noteIndex = identity && identityIndex.has(identity)
            ? identityIndex.get(identity)
            : anonymousIndexes.get(JSON.stringify(donorNote));
        await client.query(
            `UPDATE note_attachments
                SET entity_id = $1, note_index = COALESCE($2, note_index)
              WHERE id = $3 AND company_id = $4
                AND entity_type = 'contact' AND entity_id = $5`,
            [survivorId, noteIndex ?? null, attachment.id, companyId, donorId]
        );
    }
}

async function mergePhoneInventory(client, companyId, survivorId, donorId, primaryPhone) {
    const { rows } = await client.query(
        `SELECT id, contact_id, phone_e164, normalized_phone, label,
                is_primary, is_shared, created_at
           FROM contact_phones
          WHERE company_id = $1 AND contact_id IN ($2, $3)
          ORDER BY normalized_phone, (contact_id = $2) DESC, is_primary DESC, id ASC
          FOR UPDATE`,
        [companyId, survivorId, donorId]
    );
    const groups = new Map();
    for (const row of rows) {
        if (!groups.has(row.normalized_phone)) groups.set(row.normalized_phone, []);
        groups.get(row.normalized_phone).push(row);
    }
    const primaryNormalized = normalizedTenDigit(primaryPhone);
    for (const [normalized, group] of groups) {
        const canonical = group[0];
        const labels = mergeLabels(group.map(row => row.label));
        const shared = group.some(row => row.is_shared === true);
        await client.query(
            `UPDATE contact_phones
                SET contact_id = $1, label = $2, is_shared = $3, is_primary = $4
              WHERE id = $5 AND company_id = $6`,
            [survivorId, labels, shared, normalized === primaryNormalized, canonical.id, companyId]
        );
        const duplicateIds = group.slice(1).map(row => row.id);
        if (duplicateIds.length > 0) {
            await client.query(
                `DELETE FROM contact_phones
                  WHERE company_id = $1 AND id = ANY($2::bigint[])`,
                [companyId, duplicateIds]
            );
        }
    }
}

async function mergeEmailInventory(client, companyId, survivorId, donorId, primaryEmail) {
    const { rows: collisions } = await client.query(
        `SELECT donor.id AS donor_id, survivor.id AS survivor_id,
                donor.email_normalized,
                donor.is_primary AS donor_primary,
                survivor.is_primary AS survivor_primary
           FROM contact_emails donor
           JOIN contact_emails survivor
             ON survivor.contact_id = $1
            AND survivor.email_normalized = donor.email_normalized
           JOIN contacts donor_owner
             ON donor_owner.id = donor.contact_id AND donor_owner.company_id = $3
           JOIN contacts survivor_owner
             ON survivor_owner.id = survivor.contact_id AND survivor_owner.company_id = $3
          WHERE donor.contact_id = $2`,
        [survivorId, donorId, companyId]
    );
    for (const collision of collisions) {
        await client.query(
            `UPDATE contact_emails
                SET is_primary = $1
              WHERE id = $2 AND contact_id = $3
                AND EXISTS (
                    SELECT 1 FROM contacts owner
                     WHERE owner.id = contact_emails.contact_id AND owner.company_id = $4)`,
            [collision.donor_primary === true || collision.survivor_primary === true,
                collision.survivor_id, survivorId, companyId]
        );
        await client.query(
            `DELETE FROM contact_emails
              WHERE id = $1 AND contact_id = $2
                AND EXISTS (
                    SELECT 1 FROM contacts owner
                     WHERE owner.id = contact_emails.contact_id AND owner.company_id = $3)`,
            [collision.donor_id, donorId, companyId]
        );
    }
    await client.query(
        `UPDATE contact_emails donor
            SET contact_id = $1
          WHERE donor.contact_id = $2
            AND EXISTS (
                SELECT 1 FROM contacts owner
                 WHERE owner.id = donor.contact_id AND owner.company_id = $3)`,
        [survivorId, donorId, companyId]
    );
    const normalizedPrimary = normEmail(primaryEmail);
    if (normalizedPrimary) {
        await client.query(
            `UPDATE contact_emails
                SET is_primary = (email_normalized = $2)
              WHERE contact_id = $1
                AND EXISTS (
                    SELECT 1 FROM contacts owner
                     WHERE owner.id = contact_emails.contact_id AND owner.company_id = $3)`,
            [survivorId, normalizedPrimary, companyId]
        );
    }
}

async function mergeContactAddresses(client, companyId, survivorId, donorId) {
    const { rows: donorRows } = await client.query(
        `SELECT address.*
           FROM contact_addresses address
           JOIN contacts donor ON donor.id = address.contact_id
          WHERE address.contact_id = $1 AND donor.company_id = $2
          ORDER BY address.id
          FOR UPDATE OF address`,
        [donorId, companyId]
    );
    const fillColumns = [
        'label', 'street_line1', 'street_line2', 'city', 'state', 'postal_code',
        'country', 'google_place_id', 'lat', 'lng', 'address_normalized_hash',
        'zenbooker_address_id', 'zenbooker_customer_id',
    ];
    for (const donor of donorRows) {
        const { rows: matches } = await client.query(
            `SELECT address.*
               FROM contact_addresses address
               JOIN contacts survivor ON survivor.id = address.contact_id
              WHERE address.contact_id = $1 AND survivor.company_id = $2
                AND ((address.google_place_id IS NOT NULL AND $3::text IS NOT NULL
                      AND address.google_place_id = $3)
                  OR (address.address_normalized_hash IS NOT NULL AND $4::text IS NOT NULL
                      AND address.address_normalized_hash = $4))
              ORDER BY address.id
              LIMIT 1
              FOR UPDATE OF address`,
            [survivorId, companyId, donor.google_place_id, donor.address_normalized_hash]
        );
        const survivor = matches[0];
        if (!survivor) {
            await client.query(
                `UPDATE contact_addresses address
                    SET contact_id = $1
                   FROM contacts donor
                  WHERE address.id = $2 AND address.contact_id = $3
                    AND donor.id = address.contact_id AND donor.company_id = $4`,
                [survivorId, donor.id, donorId, companyId]
            );
            continue;
        }

        const values = {};
        for (const column of fillColumns) {
            if (isBlank(survivor[column]) && !isBlank(donor[column])) values[column] = donor[column];
        }
        values.is_primary = survivor.is_primary === true || donor.is_primary === true;
        values.label = mergeLabels([survivor.label, donor.label]);
        const columns = Object.keys(values);
        const params = columns.map(column => values[column]);
        params.push(survivor.id, survivorId, companyId);
        await client.query(
            `UPDATE contact_addresses address
                SET ${columns.map((column, index) => `${column} = $${index + 1}`).join(', ')},
                    updated_at = NOW()
               FROM contacts owner
              WHERE address.id = $${params.length - 2}
                AND address.contact_id = $${params.length - 1}
                AND owner.id = address.contact_id
                AND owner.company_id = $${params.length}`,
            params
        );
        await client.query(
            `UPDATE leads
                SET contact_address_id = $1
              WHERE contact_address_id = $2 AND company_id = $3`,
            [survivor.id, donor.id, companyId]
        );
        await client.query(
            `DELETE FROM contact_addresses address
              USING contacts owner
              WHERE address.id = $1 AND address.contact_id = $2
                AND owner.id = address.contact_id AND owner.company_id = $3`,
            [donor.id, donorId, companyId]
        );
    }
}

async function mergeAccountContacts(client, companyId, survivorId, donorId) {
    const { rows } = await client.query(
        `SELECT donor.id AS donor_id, survivor.id AS survivor_id,
                donor.relationship_type AS donor_relationship_type,
                survivor.relationship_type AS survivor_relationship_type,
                donor.is_primary AS donor_primary,
                survivor.is_primary AS survivor_primary
           FROM crm_account_contacts donor
           JOIN crm_account_contacts survivor
             ON survivor.company_id = donor.company_id
            AND survivor.account_id = donor.account_id
            AND survivor.contact_id = $2
          WHERE donor.company_id = $1 AND donor.contact_id = $3`,
        [companyId, survivorId, donorId]
    );
    for (const collision of rows) {
        await client.query(
            `UPDATE crm_account_contacts
                SET relationship_type = COALESCE(NULLIF(BTRIM(relationship_type), ''), $1),
                    is_primary = is_primary OR $2,
                    updated_at = NOW()
              WHERE id = $3 AND company_id = $4 AND contact_id = $5`,
            [collision.donor_relationship_type, collision.donor_primary === true,
                collision.survivor_id, companyId, survivorId]
        );
        await client.query(
            `DELETE FROM crm_account_contacts
              WHERE id = $1 AND company_id = $2 AND contact_id = $3`,
            [collision.donor_id, companyId, donorId]
        );
    }
    await client.query(
        `UPDATE crm_account_contacts
            SET contact_id = $1, updated_at = NOW()
          WHERE contact_id = $2 AND company_id = $3`,
        [survivorId, donorId, companyId]
    );
}

async function mergeDealContacts(client, companyId, survivorId, donorId) {
    await client.query(
        `DELETE FROM crm_deal_contacts donor
          USING crm_deal_contacts survivor
          WHERE donor.company_id = $1 AND donor.contact_id = $3
            AND survivor.company_id = donor.company_id
            AND survivor.contact_id = $2
            AND survivor.deal_id = donor.deal_id
            AND survivor.role = donor.role`,
        [companyId, survivorId, donorId]
    );
    await client.query(
        `UPDATE crm_deal_contacts
            SET contact_id = $1, updated_at = NOW()
          WHERE contact_id = $2 AND company_id = $3`,
        [survivorId, donorId, companyId]
    );
}

async function consolidateDonorTimeline(client, companyId, survivorId, donorId) {
    const survivorTimeline = await timelinesQueries.findOrCreateTimelineByContact(
        survivorId, companyId, client
    );
    if (!survivorTimeline) {
        throw new Error('[ContactEmailMerge] survivor timeline could not be resolved');
    }
    const { rows: donorTimelines } = await client.query(
        `SELECT * FROM timelines
          WHERE contact_id = $1 AND company_id = $2
          ORDER BY id
          FOR UPDATE`,
        [donorId, companyId]
    );
    const donorTimelineIds = donorTimelines.map(row => row.id);
    if (donorTimelineIds.length === 0) {
        return { survivorTimelineId: survivorTimeline.id, donorTimelines: [] };
    }

    for (const donor of donorTimelines) {
        await client.query(
            `UPDATE timelines survivor
                SET sms_last_at = GREATEST(survivor.sms_last_at, $1),
                    has_unread = survivor.has_unread OR $2,
                    last_read_at = GREATEST(survivor.last_read_at, $3),
                    is_action_required = survivor.is_action_required OR $4,
                    action_required_reason = COALESCE(survivor.action_required_reason, $5),
                    action_required_set_at = COALESCE(survivor.action_required_set_at, $6),
                    action_required_set_by = COALESCE(survivor.action_required_set_by, $7),
                    snoozed_until = GREATEST(survivor.snoozed_until, $8),
                    owner_user_id = COALESCE(survivor.owner_user_id, $9),
                    display_name = COALESCE(survivor.display_name, $10),
                    external_source = COALESCE(survivor.external_source, $11),
                    updated_at = NOW()
              WHERE survivor.id = $12 AND survivor.company_id = $13`,
            [donor.sms_last_at, donor.has_unread === true, donor.last_read_at,
                donor.is_action_required === true, donor.action_required_reason,
                donor.action_required_set_at, donor.action_required_set_by,
                donor.snoozed_until, donor.owner_user_id, donor.display_name,
                donor.external_source, survivorTimeline.id, companyId]
        );
    }

    // ALL tasks, including completed/closed rows, move before the timeline delete.
    await client.query(
        `UPDATE tasks SET thread_id = $1, updated_at = NOW()
          WHERE thread_id = ANY($2::bigint[]) AND company_id = $3`,
        [survivorTimeline.id, donorTimelineIds, companyId]
    );
    await client.query(
        `UPDATE calls SET timeline_id = $1, contact_id = $2
          WHERE timeline_id = ANY($3::bigint[]) AND company_id = $4`,
        [survivorTimeline.id, survivorId, donorTimelineIds, companyId]
    );
    await client.query(
        `UPDATE email_messages
            SET timeline_id = $1, contact_id = $2, on_timeline = true, updated_at = NOW()
          WHERE timeline_id = ANY($3::bigint[]) AND company_id = $4`,
        [survivorTimeline.id, survivorId, donorTimelineIds, companyId]
    );
    await client.query(
        `UPDATE yelp_conversations
            SET timeline_id = $1, updated_at = NOW()
          WHERE timeline_id = ANY($2::bigint[]) AND company_id = $3`,
        [survivorTimeline.id, donorTimelineIds, companyId]
    );
    await client.query(
        `DELETE FROM timelines
          WHERE id = ANY($1::bigint[]) AND company_id = $2 AND contact_id = $3`,
        [donorTimelineIds, companyId, donorId]
    );
    return { survivorTimelineId: survivorTimeline.id, donorTimelines };
}

async function updateSimpleContactReference(client, descriptor, companyId, survivorId, donorId) {
    if (descriptor.hasCompanyId) {
        await client.query(
            `UPDATE ${descriptor.table}
                SET contact_id = $1
              WHERE contact_id = $2 AND company_id = $3`,
            [survivorId, donorId, companyId]
        );
        return;
    }
    await client.query(
        `UPDATE ${descriptor.table} child
            SET contact_id = $1
          WHERE child.contact_id = $2
            AND EXISTS (
                SELECT 1 FROM contacts donor
                 WHERE donor.id = child.contact_id AND donor.company_id = $3)`,
        [survivorId, donorId, companyId]
    );
}

async function reassignContactReferences(client, context) {
    const { companyId, survivorId, donorId, survivor, donor, survivorTimelineId } = context;
    const inventoryByTable = new Map(CONTACT_FK_INVENTORY.map(row => [row.table, row]));
    for (const reassignment of CONTACT_REASSIGNMENTS) {
        const descriptor = inventoryByTable.get(reassignment.table);
        switch (reassignment.strategy) {
        case 'phones':
            await mergePhoneInventory(client, companyId, survivorId, donorId, survivor.phone_e164);
            break;
        case 'emails':
            await mergeEmailInventory(client, companyId, survivorId, donorId, survivor.email);
            break;
        case 'addresses':
            await mergeContactAddresses(client, companyId, survivorId, donorId);
            break;
        case 'account_contacts':
            await mergeAccountContacts(client, companyId, survivorId, donorId);
            break;
        case 'deal_contacts':
            await mergeDealContacts(client, companyId, survivorId, donorId);
            break;
        case 'calls':
            await client.query(
                `UPDATE calls SET contact_id = $1
                  WHERE contact_id = $2 AND company_id = $3`,
                [survivorId, donorId, companyId]
            );
            break;
        case 'email_messages':
            await client.query(
                `UPDATE email_messages
                    SET contact_id = $1,
                        timeline_id = COALESCE(timeline_id, $2),
                        on_timeline = true,
                        updated_at = NOW()
                  WHERE contact_id = $3 AND company_id = $4`,
                [survivorId, survivorTimelineId, donorId, companyId]
            );
            break;
        case 'tasks':
            await client.query(
                `UPDATE tasks SET contact_id = $1, updated_at = NOW()
                  WHERE contact_id = $2 AND company_id = $3`,
                [survivorId, donorId, companyId]
            );
            await client.query(
                `UPDATE tasks SET subject_id = $1, updated_at = NOW()
                  WHERE subject_type = 'contact' AND subject_id = $2 AND company_id = $3`,
                [survivorId, donorId, companyId]
            );
            break;
        case 'stripe_customer':
            // Migration 242 cascades this composite key update into every saved
            // payment method, preserving the Stripe customer/card relationship.
            await client.query(
                `UPDATE stripe_contact_customers
                    SET contact_id = $1, updated_at = NOW()
                  WHERE contact_id = $2 AND company_id = $3`,
                [survivorId, donorId, companyId]
            );
            break;
        case 'stripe_cards':
        case 'timelines':
            // Rehomed by stripe_customer's ON UPDATE CASCADE / timeline consolidation.
            break;
        case 'simple':
            await updateSimpleContactReference(
                client, descriptor, companyId, survivorId, donorId
            );
            break;
        default:
            throw new Error(`[ContactEmailMerge] unknown reassignment strategy for ${reassignment.table}`);
        }
    }

    await client.query(
        `UPDATE crm_notes SET entity_id = $1
          WHERE company_id = $3 AND entity_type = 'contact' AND entity_id = $2`,
        [survivorId, donorId, companyId]
    );
    await client.query(
        `UPDATE crm_activities SET source_entity_id = $1::text
          WHERE company_id = $3 AND source_entity_type = 'contact'
            AND source_entity_id = $2::text`,
        [survivorId, donorId, companyId]
    );
    await rehomeNoteAttachments(
        client,
        companyId,
        survivorId,
        donorId,
        survivor.structured_notes,
        donor.structured_notes
    );
}

async function assertNoDonorReferences(client, companyId, donorId) {
    const remaining = [];
    for (const descriptor of CONTACT_FK_INVENTORY) {
        const query = descriptor.hasCompanyId
            ? `SELECT COUNT(*)::int AS count FROM ${descriptor.table}
                WHERE contact_id = $1 AND company_id = $2`
            : `SELECT COUNT(*)::int AS count
                 FROM ${descriptor.table} child
                 JOIN contacts donor
                   ON donor.id = child.contact_id AND donor.company_id = $2
                WHERE child.contact_id = $1`;
        const { rows } = await client.query(query, [donorId, companyId]);
        const count = Number(rows[0]?.count || 0);
        if (count > 0) remaining.push(`${descriptor.table}=${count}`);
    }
    for (const descriptor of POLYMORPHIC_CONTACT_REFS) {
        const idPredicate = descriptor.textId
            ? `${descriptor.idColumn} = $1::text`
            : `${descriptor.idColumn} = $1`;
        const { rows } = await client.query(
            `SELECT COUNT(*)::int AS count FROM ${descriptor.table}
              WHERE company_id = $2 AND ${descriptor.typeColumn} = $3 AND ${idPredicate}`,
            [donorId, companyId, descriptor.type]
        );
        const count = Number(rows[0]?.count || 0);
        if (count > 0) remaining.push(`${descriptor.table}.${descriptor.idColumn}=${count}`);
    }
    if (remaining.length > 0) {
        throw new Error(
            `[ContactEmailMerge] zero donor references assertion failed for ${donorId}: ${remaining.join(', ')}`
        );
    }
}

async function mergeContactsInTransaction(survivorId, donorId, companyId, client) {
    // Lock in deterministic id order. The company predicate makes a foreign id
    // indistinguishable from an absent id and blocks cross-tenant reads/writes.
    const { rows: ownershipRows } = await client.query(
        `SELECT id, company_id FROM contacts WHERE id IN ($1, $2) AND company_id = $3
          ORDER BY id
          FOR UPDATE`,
        [survivorId, donorId, companyId]
    );
    if (ownershipRows.length !== 2 || ownershipRows.some(row =>
        String(row.company_id) !== String(companyId))) {
        throw new Error('[ContactEmailMerge] cross-tenant merge blocked: survivor/donor not found in company');
    }

    const { rows: redirectRows } = await client.query(
        `SELECT survivor_contact_id, status, review_reasons, details
           FROM contact_merge_redirects
          WHERE company_id = $1 AND old_contact_id = $2`,
        [companyId, donorId]
    );
    const redirect = redirectRows[0];
    if (redirect?.status === 'merged') {
        return {
            status: 'merged',
            survivor_contact_id: redirect.survivor_contact_id,
            merged_contact_id: donorId,
            merged_name: null,
            dropped_phones: [],
            idempotent: true,
        };
    }

    await assertContactFkInventory(client);
    const { rows: pair } = await client.query(
        `SELECT id, full_name, phone_e164, secondary_phone, secondary_phone_name,
                company_id, first_name, last_name, company_name, title, email,
                notes, structured_notes, zenbooker_customer_id, deleted_at
           FROM contacts
          WHERE id IN ($1, $2) AND company_id = $3
          ORDER BY id`,
        [survivorId, donorId, companyId]
    );
    const survivorBefore = pair.find(row => String(row.id) === String(survivorId));
    const donor = pair.find(row => String(row.id) === String(donorId));
    if (!survivorBefore || !donor) {
        throw new Error('[ContactEmailMerge] cross-tenant merge blocked: contact pair unavailable');
    }
    if (donor.deleted_at) {
        throw new Error('[ContactEmailMerge] archived donor has no merged redirect; refusing ambiguous merge');
    }
    if (survivorBefore.deleted_at) {
        throw new Error('[ContactEmailMerge] archived survivor cannot receive a contact merge');
    }

    const reviewReasons = await findMergeReviewReasons(
        client, companyId, survivorId, donorId, pair
    );
    if (reviewReasons.length > 0) {
        await recordContactMergeAudit({
            companyId,
            oldContactId: donorId,
            survivorContactId: survivorId,
            status: 'needs_review',
            reviewReasons,
            details: { donor_name: donor.full_name || null },
            client,
        });
        return {
            status: 'needs_review',
            survivor_contact_id: survivorId,
            merged_contact_id: donorId,
            merged_name: donor.full_name || null,
            dropped_phones: [],
            review_reasons: reviewReasons,
            idempotent: false,
        };
    }

    await ensureScalarIdentityInventory(client, companyId, pair);
    const survivor = await updateSurvivorScalars(client, companyId, survivorBefore, donor);
    const timelineResult = await consolidateDonorTimeline(
        client, companyId, survivorId, donorId
    );
    await reassignContactReferences(client, {
        companyId,
        survivorId,
        donorId,
        survivor,
        donor,
        survivorTimelineId: timelineResult.survivorTimelineId,
    });

    // This is the hard stop that turns any future FK or omitted move handler into
    // a failed transaction. It runs before the donor is archived.
    await assertNoDonorReferences(client, companyId, donorId);

    await client.query(
        `UPDATE contacts SET deleted_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
        [donorId, companyId]
    );
    await recordContactMergeAudit({
        companyId,
        oldContactId: donorId,
        survivorContactId: survivorId,
        status: 'merged',
        details: {
            donor_name: donor.full_name || null,
            timeline_snapshots: timelineResult.donorTimelines,
        },
        client,
    });

    const donorPhones = [donor.phone_e164, donor.secondary_phone].filter(value => !isBlank(value));
    const scalarPhones = new Set(
        [survivor.phone_e164, survivor.secondary_phone].map(normalizedTenDigit).filter(Boolean)
    );
    return {
        status: 'merged',
        survivor_contact_id: survivorId,
        merged_contact_id: donorId,
        merged_name: donor.full_name || null,
        dropped_phones: [],
        preserved_phones: donorPhones,
        scalar_overflow_phones: donorPhones.filter(phone => !scalarPhones.has(normalizedTenDigit(phone))),
        idempotent: false,
    };
}

/**
 * Lossless, tenant-scoped contact merge. Passing `client` joins an existing
 * transaction (B4 uses one transaction per duplicate set); omitting it creates
 * and owns a transaction. A hard conflict is recorded and returned as
 * `status:'needs_review'` with no contact/child mutation.
 */
async function mergeContacts(survivorId, donorId, companyId, client = null) {
    if (String(survivorId) === String(donorId)) return null;
    if (client?.query) {
        return mergeContactsInTransaction(survivorId, donorId, companyId, client);
    }

    const ownedClient = await db.getClient();
    try {
        await ownedClient.query('BEGIN');
        const result = await mergeContactsInTransaction(
            survivorId, donorId, companyId, ownedClient
        );
        await ownedClient.query('COMMIT');
        return result;
    } catch (error) {
        await ownedClient.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        ownedClient.release();
    }
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
    CONTACT_FK_INVENTORY,
    CONTACT_REASSIGNMENTS,
    POLYMORPHIC_CONTACT_REFS,
    recordContactMergeAudit,
    assertNoDonorReferences,
    // CONTACT-MERGE-001 additions (append-only — the 5 exports above are load-bearing):
    detectAttributeConflicts,
    transferPhone,
    transferEmail,
    assertTransferAllowed,
    ContactConflictError,
    ContactSavedCardMergeBlockedError,
    ContactMergeNeedsReviewError,
};
