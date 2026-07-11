#!/usr/bin/env node
/**
 * JOB-CONTACT-SYNC-001 backfill: propagate customer phone/email from existing
 * jobs into their linked contacts, then re-link orphaned Pulse timelines.
 *
 * Repairs the historical debt behind the prod case (job 1359 → contact 4214
 * "Leslie Beale" with no phone → timeline 2911 orphaned): every contact whose
 * linked jobs carry a phone/email the contact card is missing.
 *
 * Semantics = contactPropagationService (fill-empty-only, never steal from
 * another contact, merge orphan timelines after a phone lands). Per contact,
 * the NEWEST job's value wins (freshest data first); older jobs only fill
 * whatever slots remain.
 *
 * Usage (from backend/, inside the app container or with DB env set):
 *   node scripts/backfill-contact-details-from-jobs.js            # dry-run (default)
 *   node scripts/backfill-contact-details-from-jobs.js --apply    # write
 */

'use strict';

const db = require('../src/db/connection');
const { propagateContactDetails, phoneDigits } = require('../src/services/contactPropagationService');

const APPLY = process.argv.includes('--apply');

async function main() {
    console.log(`[Backfill] JOB-CONTACT-SYNC-001 ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

    // Contacts missing a phone or email, whose jobs carry one. Newest job first.
    const { rows } = await db.query(`
        SELECT j.id AS job_id, j.company_id, j.contact_id,
               j.customer_phone, j.customer_email,
               c.phone_e164, c.secondary_phone, c.email
          FROM jobs j
          JOIN contacts c ON c.id = j.contact_id
         WHERE j.contact_id IS NOT NULL
           AND j.company_id IS NOT NULL
           AND (
                (NULLIF(TRIM(COALESCE(j.customer_phone, '')), '') IS NOT NULL
                 AND TRIM(COALESCE(c.phone_e164, '')) = '')
             OR (NULLIF(TRIM(COALESCE(j.customer_email, '')), '') IS NOT NULL
                 AND TRIM(COALESCE(c.email, '')) = '')
           )
         ORDER BY j.contact_id, j.created_at DESC
    `);

    console.log(`[Backfill] ${rows.length} job rows with propagatable details`);

    const stats = { contacts: new Set(), phone_added: 0, email_added: 0, conflicts: 0, skipped: 0 };
    const seenPerContact = new Map(); // contact_id → { phoneDone, emailDone }

    for (const row of rows) {
        const state = seenPerContact.get(row.contact_id) || { phoneDone: false, emailDone: false };
        const phone = !state.phoneDone ? row.customer_phone : null;
        const email = !state.emailDone ? row.customer_email : null;
        if (!phone && !email) continue;

        if (!APPLY) {
            const bits = [];
            if (phone && phoneDigits(phone)) bits.push(`phone …${phoneDigits(phone).slice(-4)}`);
            if (email) bits.push(`email ${String(email).trim().toLowerCase()}`);
            if (bits.length) {
                console.log(`[Backfill][dry] contact ${row.contact_id} ← ${bits.join(' + ')} (from job ${row.job_id})`);
                stats.contacts.add(row.contact_id);
                // Assume the newest row settles both fields for dry-run counting.
                state.phoneDone = state.phoneDone || !!phone;
                state.emailDone = state.emailDone || !!email;
                seenPerContact.set(row.contact_id, state);
            }
            continue;
        }

        const result = await propagateContactDetails(row.company_id, row.contact_id,
            { phone, email }, { source: 'backfill_jobs', logPrefix: '[Backfill]' });

        stats.contacts.add(row.contact_id);
        if (result.phone === 'added_primary' || result.phone === 'added_secondary') stats.phone_added++;
        if (result.email === 'added') stats.email_added++;
        if (result.phone === 'conflict' || result.email === 'conflict') stats.conflicts++;
        if (result.phone === 'already' || result.phone === 'no_slot') state.phoneDone = true;
        if (result.phone === 'added_primary' || result.phone === 'added_secondary') state.phoneDone = true;
        if (result.email === 'added' || result.email === 'already' || result.email === 'no_slot') state.emailDone = true;
        seenPerContact.set(row.contact_id, state);
    }

    console.log(`[Backfill] done: ${stats.contacts.size} contacts touched, ` +
        `${stats.phone_added} phones added, ${stats.email_added} emails added, ` +
        `${stats.conflicts} conflicts skipped ${APPLY ? '' : '(dry-run — no writes)'}`);
    process.exit(0);
}

main().catch((e) => {
    console.error('[Backfill] fatal:', e);
    process.exit(1);
});
