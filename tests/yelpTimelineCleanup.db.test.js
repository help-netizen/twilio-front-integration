'use strict';

/**
 * YELP-TIMELINE-DEDUP-001 — REAL-POSTGRES one-time cleanup (TC-13). Seeds a
 * miniature of the prod mess (junk 'Yelp'/'Yelp Inbox' contacts whose messages
 * carry parseable conv-ids, two junk contacts sharing ONE conversation, plus one
 * un-groupable residue message) and drives backend/scripts/yelp_timeline_dedup_
 * cleanup.js dry-run then apply. SELF-SKIPS without a mig-165 DB.
 *
 * SABOTAGE (procedure): point the re-point UPDATE at mergeContacts (survivor-contact
 * semantics) instead of the contactless re-point → a survivor junk contact remains
 * (assertion 3 RED). Confirms arch §F "mergeContacts НЕ подходит".
 *
 * Run:
 *   node <repo>/node_modules/jest/bin/jest.js tests/yelpTimelineCleanup.db.test.js \
 *     --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../backend/src/db/connection');
const { runCleanup } = require('../backend/scripts/yelp_timeline_dedup_cleanup');
const { DEFAULT_COMPANY_ID } = require('./yelpFixtures');

const TAG = `TLC-${Date.now()}`;
const CONV_X = 'CONVXCLEAN01';
const CONV_Y = 'CONVYCLEAN02';
const snapshotDir = path.join(os.tmpdir(), `yelp-cleanup-${TAG}`);

let dbReady = false;
let mailboxId = null, threadId = null, createdMailbox = false;
const junkContactIds = [];
const seededPmids = [];

function bodyFirst(id) { return `Kim requested a quote for a dishwasher repair.\nView: https://www.yelp.com/message_to_business_conversation/${id}?utm_source=request_a_quote_first_message`; }
function bodyReply(id) { return `Kim replied. View: https://www.yelp.com/mail/click?url=%2Fthread%2F${id}&utm_source=request_a_quote_new_message`; }

async function seedJunkContact(name) {
    const c = await db.query(`INSERT INTO contacts (company_id, full_name) VALUES ($1,$2) RETURNING id`, [DEFAULT_COMPANY_ID, name]);
    const id = c.rows[0].id;
    junkContactIds.push(id);
    // a junk timeline for the junk contact (contact-keyed, no conv-id)
    const tl = await db.query(`INSERT INTO timelines (company_id, contact_id) VALUES ($1,$2) RETURNING id`, [DEFAULT_COMPANY_ID, id]);
    return { contactId: id, timelineId: tl.rows[0].id };
}
async function seedJunkEmail(contactId, timelineId, { pmid, body }) {
    seededPmids.push(pmid);
    await db.query(
        `INSERT INTO email_messages
            (company_id, mailbox_id, thread_id, provider_message_id, direction,
             contact_id, timeline_id, on_timeline, from_email, from_name, subject, body_text, gmail_internal_at)
         VALUES ($1,$2,$3,$4,'inbound',$5,$6,true,'reply+x@messaging.yelp.com','Yelp','Yelp',$7,now())`,
        [DEFAULT_COMPANY_ID, mailboxId, threadId, pmid, contactId, timelineId, body]);
}

beforeAll(async () => {
    try {
        await db.query('SELECT yelp_conversation_id FROM timelines LIMIT 1');
        dbReady = true;
    } catch (e) {
        console.warn('\n[yelpTimelineCleanup.db] SKIPPED-NEEDS-DB —', e.message, '\n');
        dbReady = false;
        return;
    }
    const existing = await db.query(`SELECT id FROM email_mailboxes WHERE company_id = $1 ORDER BY id LIMIT 1`, [DEFAULT_COMPANY_ID]);
    if (existing.rows[0]) { mailboxId = existing.rows[0].id; }
    else {
        const mb = await db.query(`INSERT INTO email_mailboxes (company_id, provider, email_address, status) VALUES ($1,'gmail',$2,'connected') RETURNING id`, [DEFAULT_COMPANY_ID, `tlc-${TAG}@example.com`]);
        mailboxId = mb.rows[0].id; createdMailbox = true;
    }
    const th = await db.query(`INSERT INTO email_threads (company_id, mailbox_id, provider_thread_id) VALUES ($1,$2,$3) RETURNING id`, [DEFAULT_COMPANY_ID, mailboxId, `tlc-thread-${TAG}`]);
    threadId = th.rows[0].id;
});

afterAll(async () => {
    if (dbReady) {
        try {
            if (seededPmids.length) await db.query('DELETE FROM email_messages WHERE provider_message_id = ANY($1)', [seededPmids]);
            await db.query('DELETE FROM timelines WHERE yelp_conversation_id = ANY($1)', [[CONV_X, CONV_Y]]);
            if (junkContactIds.length) {
                await db.query('DELETE FROM timelines WHERE contact_id = ANY($1)', [junkContactIds]);
                await db.query('DELETE FROM contacts WHERE id = ANY($1)', [junkContactIds]);
            }
            if (threadId) await db.query('DELETE FROM email_threads WHERE id = $1', [threadId]);
            if (createdMailbox && mailboxId) await db.query('DELETE FROM email_mailboxes WHERE id = $1', [mailboxId]);
            fs.rmSync(snapshotDir, { recursive: true, force: true });
        } catch (e) { console.warn('[yelpTimelineCleanup.db] cleanup failed:', e.message); }
    }
    try { await db.pool.end(); } catch (_) { /* ignore */ }
});

describe('TC-13 · one-time cleanup — group by conv-id → re-point → delete junk (P2)', () => {
    it('snapshot-first; two junk contacts on one convo collapse; residue untouched; idempotent', async () => {
        if (!dbReady) return console.warn('TC-13 SKIPPED-NEEDS-DB');

        // Seed: junk#1 has convX(first-form) + convY + a residue; junk#2 has convX(reply-form).
        const j1 = await seedJunkContact('Yelp');
        const j2 = await seedJunkContact('Yelp Inbox');
        await seedJunkEmail(j1.contactId, j1.timelineId, { pmid: `${TAG}-x1`, body: bodyFirst(CONV_X) });
        await seedJunkEmail(j2.contactId, j2.timelineId, { pmid: `${TAG}-x2`, body: bodyReply(CONV_X) }); // SAME convo, other junk contact
        await seedJunkEmail(j1.contactId, j1.timelineId, { pmid: `${TAG}-y1`, body: bodyFirst(CONV_Y) });
        await seedJunkEmail(j1.contactId, j1.timelineId, { pmid: `${TAG}-r1`, body: 'plain notification, no conversation id here' }); // residue

        // DRY-RUN — writes the snapshot but no re-point/delete.
        const dry = await runCleanup({ companyId: DEFAULT_COMPANY_ID, dryRun: true, snapshotDir, logger: { log() {} } });
        expect(dry.dryRun).toBe(true);
        // (1) snapshot artifact exists BEFORE any write
        expect(dry.snapshotFile).toBeTruthy();
        expect(fs.existsSync(dry.snapshotFile)).toBe(true);
        // dry-run changed nothing: junk contacts still present
        const stillJunk = await db.query(`SELECT count(*)::int AS n FROM contacts WHERE company_id=$1 AND full_name = ANY($2)`, [DEFAULT_COMPANY_ID, ['Yelp', 'Yelp Inbox']]);
        expect(stillJunk.rows[0].n).toBeGreaterThanOrEqual(2);

        // APPLY.
        const applied = await runCleanup({ companyId: DEFAULT_COMPANY_ID, dryRun: false, snapshotDir, logger: { log() {} } });
        expect(applied.dryRun).toBe(false);

        // (2) group + re-point: x1 & x2 (two junk contacts, one convo) → ONE convX timeline.
        const xRows = await db.query(`SELECT provider_message_id, contact_id, timeline_id, on_timeline FROM email_messages WHERE provider_message_id = ANY($1) ORDER BY provider_message_id`, [[`${TAG}-x1`, `${TAG}-x2`]]);
        expect(xRows.rows.every(r => r.contact_id === null && r.on_timeline === true)).toBe(true);
        expect(String(xRows.rows[0].timeline_id)).toBe(String(xRows.rows[1].timeline_id)); // collapsed to one
        const convXtl = await db.query(`SELECT id FROM timelines WHERE company_id=$1 AND yelp_conversation_id=$2`, [DEFAULT_COMPANY_ID, CONV_X]);
        expect(convXtl.rows).toHaveLength(1);
        expect(String(xRows.rows[0].timeline_id)).toBe(String(convXtl.rows[0].id));
        // y1 → its own convY timeline
        const yRow = await db.query(`SELECT timeline_id FROM email_messages WHERE provider_message_id=$1`, [`${TAG}-y1`]);
        const convYtl = await db.query(`SELECT id FROM timelines WHERE company_id=$1 AND yelp_conversation_id=$2`, [DEFAULT_COMPANY_ID, CONV_Y]);
        expect(String(yRow.rows[0].timeline_id)).toBe(String(convYtl.rows[0].id));

        // (3) delete junk contacts — no 'Yelp'/'Yelp Inbox' survivor remains.
        const junkLeft = await db.query(`SELECT count(*)::int AS n FROM contacts WHERE id = ANY($1)`, [junkContactIds]);
        expect(junkLeft.rows[0].n).toBe(0);

        // (4) residue (no conv-id) NOT guessed onto a conversation — not on convX/convY.
        const rRow = await db.query(`SELECT contact_id, timeline_id FROM email_messages WHERE provider_message_id=$1`, [`${TAG}-r1`]);
        const convTlIds = [String(convXtl.rows[0].id), String(convYtl.rows[0].id)];
        expect(convTlIds.includes(String(rRow.rows[0].timeline_id))).toBe(false);
        expect(applied.residueMessageIds.length).toBe(1);

        // (5) idempotent — a 2nd apply finds no junk and no-ops.
        const again = await runCleanup({ companyId: DEFAULT_COMPANY_ID, dryRun: false, snapshotDir, logger: { log() {} } });
        expect(again.junkContactIds).toHaveLength(0);
        expect(again.deletedContacts).toBe(0);
    });

    it('(6) not auto-run: the cleanup is standalone, not required by ingest / poll', () => {
        const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
        expect(read('../backend/src/services/email/emailTimelineService.js')).not.toMatch(/yelp_timeline_dedup_cleanup/);
        expect(read('../backend/db/migrations/165_yelp_timeline_dedup.sql')).not.toMatch(/yelp_timeline_dedup_cleanup/);
    });
});
