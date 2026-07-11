#!/usr/bin/env node
/**
 * JOB-CONTACT-SYNC-001 companion: attach orphan Pulse timelines whose phone
 * number UNAMBIGUOUSLY belongs to exactly one contact.
 *
 * Why they exist: a timeline gets its contact_id at creation time — if the
 * contact only received the number later (ZB import gaps, the backfill, a
 * manual edit that predates mergeOrphanTimelines), the timeline stayed
 * orphaned even though the contact now carries the number.
 *
 * Safety:
 *   - a timeline is linked ONLY when exactly ONE contact platform-wide owns
 *     its digits AND that contact is in the timeline's own company (this also
 *     rules out any cross-tenant adoption — mergeOrphanTimelines matches
 *     orphans by digits without a company filter, so we only ever hand it
 *     globally-unique numbers);
 *   - ambiguous numbers (shared by 2+ contacts) and numbers with no contact
 *     are reported and skipped;
 *   - the actual move reuses timelineMergeService (adopt/merge + open-task
 *     re-homing), the same code path contact edits use.
 *
 * Usage (from backend/):
 *   node scripts/relink-orphan-timelines.js            # dry-run (default)
 *   node scripts/relink-orphan-timelines.js --apply    # write
 */

'use strict';

const db = require('../src/db/connection');
const { mergeOrphanTimelines } = require('../src/services/timelineMergeService');

const APPLY = process.argv.includes('--apply');

async function main() {
    console.log(`[RelinkOrphans] ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

    const { rows } = await db.query(`
        SELECT t.id AS timeline_id, t.phone_e164, t.company_id,
               (SELECT array_agg(DISTINCT c.id)
                  FROM contacts c
                 WHERE RIGHT(REGEXP_REPLACE(COALESCE(c.phone_e164, ''), '[^0-9]', '', 'g'), 10)
                         = RIGHT(REGEXP_REPLACE(t.phone_e164, '[^0-9]', '', 'g'), 10)
                    OR RIGHT(REGEXP_REPLACE(COALESCE(c.secondary_phone, ''), '[^0-9]', '', 'g'), 10)
                         = RIGHT(REGEXP_REPLACE(t.phone_e164, '[^0-9]', '', 'g'), 10)
               ) AS owners_all,
               (SELECT array_agg(DISTINCT c.id)
                  FROM contacts c
                 WHERE c.company_id = t.company_id
                   AND (RIGHT(REGEXP_REPLACE(COALESCE(c.phone_e164, ''), '[^0-9]', '', 'g'), 10)
                          = RIGHT(REGEXP_REPLACE(t.phone_e164, '[^0-9]', '', 'g'), 10)
                     OR RIGHT(REGEXP_REPLACE(COALESCE(c.secondary_phone, ''), '[^0-9]', '', 'g'), 10)
                          = RIGHT(REGEXP_REPLACE(t.phone_e164, '[^0-9]', '', 'g'), 10))
               ) AS owners_same_co
          FROM timelines t
         WHERE t.contact_id IS NULL
           AND t.phone_e164 IS NOT NULL
           AND LENGTH(REGEXP_REPLACE(t.phone_e164, '[^0-9]', '', 'g')) >= 10
         ORDER BY t.id
    `);

    const stats = { linked: 0, ambiguous: 0, no_contact: 0, cross_co: 0 };
    // owner contact id → phones to merge (dedup repeated timelines per contact;
    // mergeOrphanTimelines picks up ALL matching orphans in one call anyway).
    const perContact = new Map();

    for (const row of rows) {
        const all = row.owners_all || [];
        const sameCo = row.owners_same_co || [];
        if (all.length === 0) { stats.no_contact++; continue; }
        if (all.length > 1) {
            stats.ambiguous++;
            console.log(`[RelinkOrphans] SKIP ambiguous: timeline ${row.timeline_id} (${row.phone_e164}) — contacts ${all.join(', ')}`);
            continue;
        }
        if (sameCo.length !== 1 || String(sameCo[0]) !== String(all[0])) {
            stats.cross_co++;
            console.log(`[RelinkOrphans] SKIP cross-company: timeline ${row.timeline_id} (${row.phone_e164}) — owner ${all[0]} is in another company`);
            continue;
        }

        const owner = all[0];
        if (!perContact.has(owner)) perContact.set(owner, new Set());
        perContact.get(owner).add(row.phone_e164);
        console.log(`[RelinkOrphans]${APPLY ? '' : '[dry]'} timeline ${row.timeline_id} (${row.phone_e164}) → contact ${owner}`);
        stats.linked++;
    }

    if (APPLY) {
        for (const [contactId, phones] of perContact.entries()) {
            await mergeOrphanTimelines(contactId, Array.from(phones), '[RelinkOrphans]');
        }
    }

    console.log(`[RelinkOrphans] done: ${stats.linked} timelines ${APPLY ? 'linked' : 'linkable'} across ${perContact.size} contacts, ` +
        `${stats.ambiguous} ambiguous skipped, ${stats.cross_co} cross-company skipped, ${stats.no_contact} without a contact (left as-is)`);
    process.exit(0);
}

main().catch((e) => {
    console.error('[RelinkOrphans] fatal:', e);
    process.exit(1);
});
