/**
 * Contact Email Merge Service (CONTACT-EMAIL-MERGE-001)
 *
 * The email analogue of `timelineMergeService.js` (which handles the phone side).
 * When a user adds an email address to a contact, this resolves who currently
 * owns that address's correspondence within the SAME company and folds it onto
 * the target contact's timeline — linking inbox-only messages, re-pointing a
 * data-bearing owner's messages, or, when the owner is a bare email-only
 * auto-contact, fully MERGING and deleting it.
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
 * @param {number|string} survivorId
 * @param {number|string} dupId
 * @param {string} companyId
 * @param {{query: Function}} [client=db]
 */
async function mergeContacts(survivorId, dupId, companyId, client = db) {
    if (String(survivorId) === String(dupId)) return; // nothing to merge into self

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

    // A separate owner exists within this company. Empty (email-only) → full
    // merge + delete; otherwise re-point ONLY this address's messages, keep owner.
    const emptyOwner = await isContactEmailOnly(owner.id, companyId, client);
    if (emptyOwner) {
        await mergeContacts(targetContactId, owner.id, companyId, client);
    } else {
        await linkInboxMessages(targetContactId, normalized, companyId, client);
    }
}

module.exports = {
    resolveAddedEmail,
    mergeContacts,
    isContactEmailOnly,
    linkInboxMessages,
    IDENTITY_TABLES,
};
