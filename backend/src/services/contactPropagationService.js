/**
 * Contact Propagation Service (JOB-CONTACT-SYNC-001)
 *
 * Problem (prod case: job 1359 / timeline 2911): a job or lead carries the
 * customer's phone/email, but the linked contact card was created without
 * them (typical for Zenbooker-imported contacts, or a dedupe match by name).
 * Inbound calls/SMS then can't match the contact, and the Pulse timeline
 * stays orphaned (contact_id NULL) even though the number is right there on
 * the job.
 *
 * Fix: after a job/lead create/edit resolves its contact, ENRICH the contact
 * with any phone/email it doesn't have yet — then immediately re-link orphan
 * timelines (and inbox email messages) so history attaches retroactively.
 *
 * Safety posture — strictly additive, never destructive:
 *   - fill EMPTY slots only (phone_e164 → secondary_phone; email), never
 *     overwrite an existing value;
 *   - never steal identity: if ANOTHER contact in the same company already
 *     owns the phone/email, skip and log (auto-merging identities is the
 *     409-dialog flow of CONTACT-MERGE-001, not a background job's call);
 *   - every step is non-fatal: enrichment must never break the job/lead save
 *     that triggered it.
 */

'use strict';

const db = require('../db/connection');
const { toE164 } = require('../utils/phoneUtils');

/** Last-10-digits normalization — same matching rule the Pulse timeline uses. */
function phoneDigits(value) {
    const digits = String(value || '').replace(/\D/g, '').slice(-10);
    return digits.length === 10 ? digits : null;
}

function normalizeEmail(value) {
    const email = String(value || '').trim().toLowerCase();
    return email.includes('@') ? email : null;
}

/**
 * Enrich a contact with a phone/email coming from a job or lead, then re-link
 * orphaned history. Both writes are independent; each reports its outcome.
 *
 * @param {string} companyId  Tenant scope (required — contact is read company-scoped).
 * @param {number|string} contactId  The contact linked to the job/lead.
 * @param {{ phone?: string|null, email?: string|null }} details  Values from the job/lead.
 * @param {{ source?: string, logPrefix?: string }} [opts]  source = audit tag (e.g. 'job_create').
 * @returns {Promise<{ phone: string, email: string }>} outcome per field:
 *   'added_primary' | 'added_secondary' | 'added' | 'already' | 'conflict' | 'no_slot' | 'skipped'
 */
async function propagateContactDetails(companyId, contactId, details = {}, opts = {}) {
    const { source = 'unknown', logPrefix = '[ContactPropagation]' } = opts;
    const result = { phone: 'skipped', email: 'skipped' };

    if (!companyId || contactId == null) return result;

    const digits = phoneDigits(details.phone);
    const email = normalizeEmail(details.email);
    if (!digits && !email) return result;

    const { rows } = await db.query(
        'SELECT id, phone_e164, secondary_phone, email FROM contacts WHERE id = $1 AND company_id = $2',
        [contactId, companyId]
    );
    const contact = rows[0];
    if (!contact) return result;

    // ── Phone ────────────────────────────────────────────────────────────────
    if (digits) {
        result.phone = await propagatePhone(companyId, contact, digits, details.phone, { source, logPrefix });
    }

    // ── Email ────────────────────────────────────────────────────────────────
    if (email) {
        result.email = await propagateEmail(companyId, contact, email, { source, logPrefix });
    }

    return result;
}

async function propagatePhone(companyId, contact, digits, rawPhone, { source, logPrefix }) {
    const ownDigits = [phoneDigits(contact.phone_e164), phoneDigits(contact.secondary_phone)].filter(Boolean);
    if (ownDigits.includes(digits)) return 'already';

    // Never steal: does any OTHER contact in this company own the number?
    const { rows: owners } = await db.query(
        `SELECT id FROM contacts
          WHERE company_id = $1 AND id <> $2
            AND (RIGHT(REGEXP_REPLACE(COALESCE(phone_e164, ''), '[^0-9]', '', 'g'), 10) = $3
              OR RIGHT(REGEXP_REPLACE(COALESCE(secondary_phone, ''), '[^0-9]', '', 'g'), 10) = $3)
          LIMIT 1`,
        [companyId, contact.id, digits]
    );
    if (owners.length > 0) {
        console.log(`${logPrefix} phone …${digits.slice(-4)} already belongs to contact ${owners[0].id} — not touching contact ${contact.id} (source=${source})`);
        return 'conflict';
    }

    const value = toE164(rawPhone) || rawPhone;
    let slot = null;
    if (!String(contact.phone_e164 || '').trim()) slot = 'phone_e164';
    else if (!String(contact.secondary_phone || '').trim()) slot = 'secondary_phone';
    if (!slot) return 'no_slot'; // both slots hold OTHER numbers — a human call, not ours

    await db.query(
        `UPDATE contacts SET ${slot} = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3`,
        [value, contact.id, companyId]
    );
    console.log(`${logPrefix} contact ${contact.id}: ${slot} ← …${digits.slice(-4)} (source=${source})`);

    // Attach orphaned call/SMS history for this number right away.
    try {
        const { mergeOrphanTimelines } = require('./timelineMergeService');
        await mergeOrphanTimelines(contact.id, [value], logPrefix);
    } catch (e) {
        console.error(`${logPrefix} orphan-timeline merge failed (non-fatal): ${e.message}`);
    }

    logEnrichmentEvent(companyId, contact.id, { phone_added: value, source });
    return slot === 'phone_e164' ? 'added_primary' : 'added_secondary';
}

async function propagateEmail(companyId, contact, email, { source, logPrefix }) {
    if (String(contact.email || '').trim().toLowerCase() === email) return 'already';
    if (String(contact.email || '').trim()) return 'no_slot'; // holds a DIFFERENT email — human decision

    // Never steal: primary emails + the contact_emails identity table.
    const { rows: owners } = await db.query(
        `SELECT c.id FROM contacts c
          WHERE c.company_id = $1 AND c.id <> $2 AND LOWER(COALESCE(c.email, '')) = $3
          UNION
         SELECT ce.contact_id FROM contact_emails ce
           JOIN contacts c2 ON c2.id = ce.contact_id
          WHERE c2.company_id = $1 AND ce.contact_id <> $2 AND LOWER(ce.email) = $3
          LIMIT 1`,
        [companyId, contact.id, email]
    );
    if (owners.length > 0) {
        console.log(`${logPrefix} email ${email} already belongs to contact ${owners[0].id} — not touching contact ${contact.id} (source=${source})`);
        return 'conflict';
    }

    await db.query(
        'UPDATE contacts SET email = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3',
        [email, contact.id, companyId]
    );
    console.log(`${logPrefix} contact ${contact.id}: email ← ${email} (source=${source})`);

    // Attach the email history for this address (same seam CONTACT-EMAIL-MERGE-001 uses).
    try {
        const { linkInboxMessages } = require('./contactEmailMergeService');
        await linkInboxMessages(contact.id, email, companyId);
    } catch (e) {
        console.error(`${logPrefix} inbox re-link failed (non-fatal): ${e.message}`);
    }

    logEnrichmentEvent(companyId, contact.id, { email_added: email, source });
    return 'added';
}

function logEnrichmentEvent(companyId, contactId, payload) {
    try {
        const eventService = require('./eventService');
        eventService.logEvent(companyId, 'contact', contactId, 'contact_enriched', payload, 'system');
    } catch (e) {
        console.error(`[ContactPropagation] event log failed (non-fatal): ${e.message}`);
    }
}

module.exports = { propagateContactDetails, phoneDigits };
