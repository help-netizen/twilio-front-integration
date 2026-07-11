#!/usr/bin/env node
'use strict';

/**
 * YELP-TIMELINE-DEDUP-001 — one-time cleanup (spec §6 / arch §F).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ⚠️  DESTRUCTIVE + OWNER-RUN. NOT a migration. NEVER auto-run by ingest, the poll
 *     tick, or a migration. Requires migration 165 applied and an explicit owner
 *     "да" per run. Re-point + delete are irreversible → SNAPSHOT-FIRST is
 *     mandatory (the run ABORTS if it cannot write its snapshot).
 * ────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES (per company, DEFAULT_COMPANY by default):
 *   1. SNAPSHOT — writes the affected `contacts` / `timelines` / `email_messages`
 *      rows to a JSON artifact BEFORE any write. (Owner should ALSO `pg_dump`
 *      those tables out-of-band; this JSON is the in-script belt.)
 *   2. Find the junk contacts the Mail-Secretary fabricated from Yelp relays
 *      (`full_name IN ('Yelp','Yelp Inbox')`).
 *   3. For each junk contact's `email_messages`, parse the STABLE conv-id from the
 *      stored body → GROUP by conv-id → `resolveYelpTimeline` per group.
 *   4. RE-POINT (targeted, NOT `mergeContacts` — that needs a survivor contact /
 *      phone key; the goal is CONTACTLESS): `UPDATE email_messages SET
 *      contact_id=NULL, timeline_id=<convTl>, on_timeline=true WHERE id = ANY(...)`.
 *   5. DELETE the junk contacts + their now-empty timelines.
 *   Un-groupable residue (a message with NO parseable conv-id) is LEFT UNTOUCHED —
 *   never guess a conv-id.
 *
 * Idempotent: a 2nd run finds no junk contacts and no-ops. Per-company; every
 * statement is company-scoped. `mergeContacts` / `mergeOrphanTimelines` are the
 * WRONG primitives here (documented in arch §F).
 *
 * Usage (dry-run prints the plan, writes NOTHING except the snapshot):
 *   DATABASE_URL=... node backend/scripts/yelp_timeline_dedup_cleanup.js --dry-run
 * Apply (owner-confirmed):
 *   DATABASE_URL=... node backend/scripts/yelp_timeline_dedup_cleanup.js --apply --yes
 *   [--company <uuid>] [--snapshot-dir <path>]
 */

const fs = require('fs');
const path = require('path');
const db = require('../src/db/connection');
const timelinesQueries = require('../src/db/timelinesQueries');
const { parseConversationId } = require('../src/services/yelpConversationId');

const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const JUNK_NAMES = ['Yelp', 'Yelp Inbox'];

/**
 * Build the minimal msg-shape the parsers read from a stored email_messages row.
 */
function rowToMsg(row) {
    return {
        provider_message_id: row.provider_message_id,
        body_text: row.body_text,
        subject: row.subject,
        snippet: row.snippet,
        from_email: row.from_email,
    };
}

/**
 * Write the snapshot artifact BEFORE any write. Returns the file path. Throws (→
 * the caller ABORTS) if it cannot be written — snapshot-first is non-negotiable.
 */
function writeSnapshot(snapshotDir, payload) {
    fs.mkdirSync(snapshotDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(snapshotDir, `yelp-cleanup-snapshot-${ts}.json`);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    return file;
}

/**
 * @param {object} opts
 * @param {string} [opts.companyId]     default: DEFAULT_COMPANY_ID
 * @param {boolean} [opts.dryRun]        default: true (writes NOTHING but the snapshot)
 * @param {string} [opts.snapshotDir]   where the JSON snapshot lands
 * @param {object} [opts.logger]        default: console
 * @returns {Promise<object>} a summary { companyId, dryRun, snapshotFile, junkContactIds,
 *   groups:[{convId, timelineId, messageIds}], residueMessageIds, deletedContacts, deletedTimelines }
 */
async function runCleanup(opts = {}) {
    const companyId = opts.companyId || DEFAULT_COMPANY_ID;
    const dryRun = opts.dryRun !== false; // default dry-run
    const logger = opts.logger || console;
    const snapshotDir = opts.snapshotDir
        || path.join(__dirname, '.yelp-cleanup-snapshots');

    // 1. Find junk contacts (company-scoped).
    const { rows: junk } = await db.query(
        `SELECT id, full_name FROM contacts
          WHERE company_id = $1 AND full_name = ANY($2)`,
        [companyId, JUNK_NAMES]
    );
    const junkContactIds = junk.map(c => c.id);

    if (junkContactIds.length === 0) {
        logger.log('[YelpCleanup] no junk contacts — nothing to do (idempotent no-op).');
        return {
            companyId, dryRun, snapshotFile: null, junkContactIds: [],
            groups: [], residueMessageIds: [], deletedContacts: 0, deletedTimelines: 0,
        };
    }

    // 2. Gather the junk contacts' messages + their timelines (for the snapshot).
    const { rows: messages } = await db.query(
        `SELECT id, provider_message_id, contact_id, timeline_id, body_text, subject,
                snippet, from_email, gmail_internal_at
           FROM email_messages
          WHERE company_id = $1 AND contact_id = ANY($2)`,
        [companyId, junkContactIds]
    );
    const { rows: junkTimelines } = await db.query(
        `SELECT id, contact_id, yelp_conversation_id FROM timelines
          WHERE company_id = $1 AND contact_id = ANY($2)`,
        [companyId, junkContactIds]
    );

    // 3. SNAPSHOT FIRST — abort if it cannot be written.
    let snapshotFile;
    try {
        snapshotFile = writeSnapshot(snapshotDir, {
            feature: 'YELP-TIMELINE-DEDUP-001', companyId, takenAt: new Date().toISOString(),
            contacts: junk, timelines: junkTimelines, email_messages: messages,
        });
        logger.log(`[YelpCleanup] snapshot written: ${snapshotFile}`);
    } catch (e) {
        throw new Error(`[YelpCleanup] ABORT — could not write snapshot (${e.message})`);
    }

    // 4. Group the messages by parsed conv-id; un-parseable → residue (untouched).
    const groups = new Map(); // convId → [messageId]
    const residueMessageIds = [];
    for (const m of messages) {
        const convId = parseConversationId(rowToMsg(m));
        if (!convId) { residueMessageIds.push(m.id); continue; }
        if (!groups.has(convId)) groups.set(convId, []);
        groups.get(convId).push(m);
    }

    const plan = [];
    for (const [convId, msgs] of groups.entries()) {
        plan.push({ convId, messageIds: msgs.map(m => m.id), timelineId: null });
    }

    if (dryRun) {
        logger.log(`[YelpCleanup] DRY-RUN — would collapse ${messages.length - residueMessageIds.length} message(s) into ${groups.size} conv-id timeline(s); delete ${junkContactIds.length} junk contact(s) + ${junkTimelines.length} junk timeline(s); leave ${residueMessageIds.length} residue message(s) untouched.`);
        return {
            companyId, dryRun: true, snapshotFile, junkContactIds,
            groups: plan, residueMessageIds, deletedContacts: 0, deletedTimelines: 0,
        };
    }

    // 5. APPLY inside a per-company transaction on a dedicated client.
    const client = await db.getClient();
    let deletedContacts = 0;
    let deletedTimelines = 0;
    try {
        await client.query('BEGIN');

        for (const g of plan) {
            const sample = groups.get(g.convId)[0];
            const tl = await timelinesQueries.resolveYelpTimeline(companyId, g.convId, rowToMsg(sample), client);
            g.timelineId = tl && tl.id != null ? tl.id : null;
            if (g.timelineId == null) {
                throw new Error(`[YelpCleanup] resolveYelpTimeline returned no row for conv ${g.convId}`);
            }
            // RE-POINT (targeted; contactless). NOT mergeContacts.
            await client.query(
                `UPDATE email_messages
                    SET contact_id = NULL, timeline_id = $3, on_timeline = true, updated_at = now()
                  WHERE company_id = $1 AND id = ANY($2)`,
                [companyId, g.messageIds, g.timelineId]
            );
        }

        // Delete the junk contacts' now-empty timelines (contact-keyed, NOT conv-id
        // timelines — those we just created carry yelp_conversation_id and survive).
        const delTl = await client.query(
            `DELETE FROM timelines
              WHERE company_id = $1 AND contact_id = ANY($2)
                AND yelp_conversation_id IS NULL
              RETURNING id`,
            [companyId, junkContactIds]
        );
        deletedTimelines = delTl.rowCount;

        // Delete the junk contacts.
        const delCo = await client.query(
            `DELETE FROM contacts WHERE company_id = $1 AND id = ANY($2) RETURNING id`,
            [companyId, junkContactIds]
        );
        deletedContacts = delCo.rowCount;

        await client.query('COMMIT');
        logger.log(`[YelpCleanup] APPLIED — ${groups.size} conv-id timeline(s); re-pointed ${messages.length - residueMessageIds.length} message(s); deleted ${deletedContacts} contact(s) + ${deletedTimelines} timeline(s); ${residueMessageIds.length} residue left untouched.`);
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }

    return {
        companyId, dryRun: false, snapshotFile, junkContactIds,
        groups: plan, residueMessageIds, deletedContacts, deletedTimelines,
    };
}

// ── CLI wrapper (owner-run) ──────────────────────────────────────────────────
if (require.main === module) {
    const argv = process.argv.slice(2);
    const has = (f) => argv.includes(f);
    const val = (f, d = null) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : d; };

    const apply = has('--apply');
    const dryRun = !apply || has('--dry-run');
    const confirmed = has('--yes');

    if (apply && !confirmed) {
        console.error('Refusing to APPLY without --yes (owner confirmation). Re-run with --apply --yes.');
        process.exit(1);
    }

    runCleanup({
        companyId: val('--company', DEFAULT_COMPANY_ID),
        dryRun,
        snapshotDir: val('--snapshot-dir'),
    })
        .then((summary) => {
            console.log('[YelpCleanup] summary:', JSON.stringify(summary, null, 2));
            return db.pool.end();
        })
        .then(() => process.exit(0))
        .catch((e) => {
            console.error(e.message || e);
            db.pool.end().finally(() => process.exit(1));
        });
}

module.exports = { runCleanup, DEFAULT_COMPANY_ID, JUNK_NAMES };
