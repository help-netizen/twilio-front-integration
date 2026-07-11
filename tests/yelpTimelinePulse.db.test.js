'use strict';

/**
 * YELP-TIMELINE-DEDUP-001 — REAL-POSTGRES Pulse LIST surfacing (TC-07) + lead-path
 * adopt (TC-11). The DB seam is NOT mocked — getUnifiedTimelinePage's new
 * email_by_timeline leg + the contactless surfacing + tenant isolation are the
 * point. SELF-SKIPS without a mig-165 DB.
 *
 * NAMED SABOTAGE TC-07 SAB-EMAIL-BY-CONTACT-ONLY (procedure): drop the
 * email_by_timeline CTE/leg (leave only email_by_contact ON eml.contact_id =
 * tl.contact_id). → the contactless row has tl.contact_id NULL → no email signal →
 * it fails the surfacing predicate and is ABSENT → assertion 1/3 RED.
 *
 * Run:
 *   node <repo>/node_modules/jest/bin/jest.js tests/yelpTimelinePulse.db.test.js \
 *     --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit
 */

const db = require('../backend/src/db/connection');
const timelinesQueries = require('../backend/src/db/timelinesQueries');
const { DEFAULT_COMPANY_ID } = require('./yelpFixtures');

const COMPANY_B = '00000000-0000-0000-0000-0000000000b7';
const TAG = `TLP-${Date.now()}`;
const CONV = (s) => `CONV-${TAG}-${s}`;

let dbReady = false;
const seededConvIds = [];
const seededPmids = [];
const seededContactIds = [];
const mailboxes = {}; // companyId → { id, created }
const threads = {};   // companyId → id

async function ensureMailbox(companyId) {
    if (mailboxes[companyId]) return mailboxes[companyId].id;
    const existing = await db.query(
        `SELECT id FROM email_mailboxes WHERE company_id = $1 ORDER BY id LIMIT 1`, [companyId]);
    if (existing.rows[0]) {
        mailboxes[companyId] = { id: existing.rows[0].id, created: false };
    } else {
        const mb = await db.query(
            `INSERT INTO email_mailboxes (company_id, provider, email_address, status)
             VALUES ($1, 'gmail', $2, 'connected') RETURNING id`,
            [companyId, `tlp-${TAG}-${companyId.slice(-4)}@example.com`]);
        mailboxes[companyId] = { id: mb.rows[0].id, created: true };
    }
    return mailboxes[companyId].id;
}
async function ensureThread(companyId) {
    if (threads[companyId]) return threads[companyId];
    const mbId = await ensureMailbox(companyId);
    const th = await db.query(
        `INSERT INTO email_threads (company_id, mailbox_id, provider_thread_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [companyId, mbId, `tlp-thread-${TAG}-${companyId.slice(-4)}`]);
    threads[companyId] = th.rows[0].id;
    return th.rows[0].id;
}

/** Raw-insert a CONTACTLESS conv-id timeline (full control over display_name). */
async function seedContactlessTimeline(companyId, convId, displayName) {
    const tl = await db.query(
        `INSERT INTO timelines (company_id, yelp_conversation_id, external_source, display_name)
         VALUES ($1,$2,'yelp',$3) RETURNING *`,
        [companyId, convId, displayName]);
    seededConvIds.push(convId);
    return tl.rows[0];
}
async function seedEmail(companyId, timelineId, { pmid, at, subject, contactId = null, fromEmail = 'reply+x@messaging.yelp.com' }) {
    const mbId = await ensureMailbox(companyId);
    const thId = await ensureThread(companyId);
    seededPmids.push(pmid);
    await db.query(
        `INSERT INTO email_messages
            (company_id, mailbox_id, thread_id, provider_message_id, direction,
             contact_id, timeline_id, on_timeline, from_email, from_name, subject,
             body_text, gmail_internal_at)
         VALUES ($1,$2,$3,$4,'inbound',$5,$6,true,$9,'Kim L.',$7,'hi',$8)`,
        [companyId, mbId, thId, pmid, contactId, timelineId, subject || 'Yelp', at || new Date().toISOString(), fromEmail]);
}

/** Raw-insert a CONTACT-KEYED timeline (contact_id set, no phone) — the shape a
 * normal email-only contact has. No call/SMS/task/unread, so its ONLY surfacing
 * signal is email (mirrors seedContactlessTimeline; cleaned via seededContactIds). */
async function seedContactTimeline(companyId, contactId) {
    const tl = await db.query(
        `INSERT INTO timelines (company_id, contact_id) VALUES ($1,$2) RETURNING *`,
        [companyId, contactId]);
    return tl.rows[0];
}

beforeAll(async () => {
    try {
        await db.query('SELECT yelp_conversation_id FROM timelines LIMIT 1');
        dbReady = true;
    } catch (e) {
        console.warn('\n[yelpTimelinePulse.db] SKIPPED-NEEDS-DB —', e.message, '\n');
        dbReady = false;
        return;
    }
    await db.query(
        `INSERT INTO companies (id, name, slug) VALUES ($1, 'TLP Test Co B', $2)
         ON CONFLICT (id) DO NOTHING`,
        [COMPANY_B, `tlp-test-co-b-${TAG}`]);
});

afterAll(async () => {
    if (dbReady) {
        try {
            if (seededPmids.length) await db.query('DELETE FROM email_messages WHERE provider_message_id = ANY($1)', [seededPmids]);
            if (seededConvIds.length) await db.query('DELETE FROM timelines WHERE yelp_conversation_id = ANY($1)', [seededConvIds]);
            if (seededContactIds.length) {
                await db.query('DELETE FROM timelines WHERE contact_id = ANY($1)', [seededContactIds]);
                await db.query('DELETE FROM contacts WHERE id = ANY($1)', [seededContactIds]);
            }
            for (const cid of Object.keys(threads)) await db.query('DELETE FROM email_threads WHERE id = $1', [threads[cid]]);
            for (const cid of Object.keys(mailboxes)) if (mailboxes[cid].created) await db.query('DELETE FROM email_mailboxes WHERE id = $1', [mailboxes[cid].id]);
            await db.query('DELETE FROM companies WHERE id = $1', [COMPANY_B]);
        } catch (e) {
            console.warn('[yelpTimelinePulse.db] cleanup failed:', e.message);
        }
    }
    try { await db.pool.end(); } catch (_) { /* ignore */ }
});

// ── TC-07 · Pulse LIST — contactless conv-id timeline surfaces + labeled ───────
describe('TC-07 · contactless Yelp timeline surfaces in the unified list (P0)', () => {
    it('present, labeled by display_name, email signal + recency, tenant-isolated', async () => {
        if (!dbReady) return console.warn('TC-07 SKIPPED-NEEDS-DB');

        const tlA = await seedContactlessTimeline(DEFAULT_COMPANY_ID, CONV('A'), 'Kim L.');
        await seedEmail(DEFAULT_COMPANY_ID, tlA.id, { pmid: `${TAG}-a1`, at: '2026-07-11T09:00:00Z', subject: 'Yelp A' });

        // Company B's contactless Yelp timeline + email (isolation control).
        const tlB = await seedContactlessTimeline(COMPANY_B, CONV('B'), 'Bob (co B)');
        await seedEmail(COMPANY_B, tlB.id, { pmid: `${TAG}-b1`, at: '2026-07-11T09:30:00Z', subject: 'Yelp B' });

        const pageA = await timelinesQueries.getUnifiedTimelinePage({ companyId: DEFAULT_COMPANY_ID, limit: 200, offset: 0 });
        const rowA = pageA.find(r => String(r.tl_id) === String(tlA.id));

        // (1) present (surfaced by the email_by_timeline leg, not dropped for no contact)
        expect(rowA).toBeTruthy();
        // (2) labeled by the timeline column (co is NULL)
        expect(rowA.display_name).toBe('Kim L.');
        expect(rowA.external_source).toBe('yelp');
        // (3) email signal + non-null recency ordering value
        expect(rowA.email_thread_id).toBeTruthy();
        expect(rowA.email_last_message_at).toBeTruthy();
        expect(rowA.last_interaction_at).toBeTruthy();
        // (4) tenant isolation — company B's Yelp timeline is NOT in company A's page
        expect(pageA.find(r => String(r.tl_id) === String(tlB.id))).toBeUndefined();
        const pageB = await timelinesQueries.getUnifiedTimelinePage({ companyId: COMPANY_B, limit: 200, offset: 0 });
        expect(pageB.find(r => String(r.tl_id) === String(tlB.id))).toBeTruthy();
        expect(pageB.find(r => String(r.tl_id) === String(tlA.id))).toBeUndefined();
    });

    it('(5) email_by_timeline can be served by idx_email_messages_timeline (enable_seqscan=off)', async () => {
        if (!dbReady) return console.warn('TC-07-explain SKIPPED-NEEDS-DB');
        const client = await db.getClient();
        try {
            await client.query('BEGIN');
            await client.query('SET LOCAL enable_seqscan = off');
            const plan = await client.query(
                `EXPLAIN SELECT em.timeline_id, MAX(em.gmail_internal_at)
                   FROM email_messages em
                  WHERE em.company_id = $1 AND em.timeline_id IS NOT NULL AND em.on_timeline = true
                  GROUP BY em.timeline_id`,
                [DEFAULT_COMPANY_ID]);
            const text = plan.rows.map(r => r['QUERY PLAN']).join('\n');
            expect(text).toMatch(/idx_email_messages_timeline/);
        } finally {
            await client.query('ROLLBACK');
            client.release();
        }
    });
});

// ── TC-11 · lead-path adopts the conv-id timeline (no 2nd timeline) ────────────
describe('TC-11 · adopt-in-place: contact_id set on the EXISTING conv-id timeline', () => {
    it('exactly ONE timeline for (company,conv); dual-anchored; messages stay put', async () => {
        if (!dbReady) return console.warn('TC-11 SKIPPED-NEEDS-DB');

        const conv = CONV('ADOPT');
        const tl = await timelinesQueries.resolveYelpTimeline(DEFAULT_COMPANY_ID, conv,
            { body_text: 'Kim requested a quote for a dishwasher repair.', from_email: 'reply+z@messaging.yelp.com' });
        await seedEmail(DEFAULT_COMPANY_ID, tl.id, { pmid: `${TAG}-adopt1`, at: '2026-07-11T10:00:00Z', subject: 'adopt' });

        // The lead path materializes a real contact, then adopts the EXISTING row
        // (UPDATE … WHERE yelp_conversation_id=…), NOT findOrCreateTimelineByContact.
        const co = await db.query(
            `INSERT INTO contacts (company_id, full_name) VALUES ($1, 'Kim Lee') RETURNING id`,
            [DEFAULT_COMPANY_ID]);
        const contactId = co.rows[0].id;
        seededContactIds.push(contactId);

        await db.query(
            `UPDATE timelines SET contact_id = $1, updated_at = now()
              WHERE company_id = $2 AND yelp_conversation_id = $3`,
            [contactId, DEFAULT_COMPANY_ID, conv]);

        // (1) still exactly ONE timeline for the conversation
        const cnt = await db.query(
            `SELECT count(*)::int AS n FROM timelines WHERE company_id = $1 AND yelp_conversation_id = $2`,
            [DEFAULT_COMPANY_ID, conv]);
        expect(cnt.rows[0].n).toBe(1);
        // (2) dual-anchored — contact_id set AND yelp_conversation_id retained
        const row = await db.query(
            `SELECT contact_id, yelp_conversation_id FROM timelines
              WHERE company_id = $1 AND yelp_conversation_id = $2`,
            [DEFAULT_COMPANY_ID, conv]);
        expect(String(row.rows[0].contact_id)).toBe(String(contactId));
        expect(row.rows[0].yelp_conversation_id).toBe(conv);
        // (3) the already-linked message stays on the SAME timeline id
        const msg = await db.query(
            `SELECT timeline_id FROM email_messages WHERE provider_message_id = $1`,
            [`${TAG}-adopt1`]);
        expect(String(msg.rows[0].timeline_id)).toBe(String(tl.id));
    });
});

// ── MAIL-MUTE-001 regression · email_by_timeline must stay CONTACTLESS-only ────
// linkMessageToContact stamps timeline_id + on_timeline=true on NORMAL contact-
// keyed emails too, so the email_by_timeline CTE (keyed on timeline_id, mute-
// UN-aware) would re-surface a MUTED email-only contact — bypassing the
// NOT em.email_muted filter that ONLY the sibling email_by_contact leg applies —
// and its muted email would drive last_interaction_at via the GREATEST terms.
// The `AND em.contact_id IS NULL` scope on the CTE fixes surfacing AND both
// recency terms at once. The mocked frozen-SQL suite can't catch this — it needs
// a real GROUP-BY over email_messages, hence this real-DB case.
//
// NAMED SABOTAGE MUTE-EMAIL-BY-TIMELINE-UNSCOPED (procedure): drop the
// `AND em.contact_id IS NULL` predicate from the email_by_timeline CTE. → the
// muted contact-keyed email re-enters eml_tl → the muted row surfaces (line
// eml_tl.email_thread_id IS NOT NULL) → assertion (1) RED.
describe('MAIL-MUTE-001 regression · muted contact-keyed email not resurfaced via email_by_timeline (P2)', () => {
    it('MUTE-not-resurfaced-via-email_by_timeline: muted contact dropped; contactless Yelp still surfaces', async () => {
        if (!dbReady) return console.warn('MUTE-regression SKIPPED-NEEDS-DB');

        const mutedAddr = `muted-${TAG}@example.com`;

        // (a) A MUTED, contact-keyed email-only contact. co.email is muted AND a
        // matching contact_emails row makes email_by_contact genuinely resolve it,
        // so mute is the ONLY reason it should stay hidden via the contact leg.
        const co = await db.query(
            `INSERT INTO contacts (company_id, full_name, email) VALUES ($1, 'Muted Contact', $2) RETURNING id`,
            [DEFAULT_COMPANY_ID, mutedAddr]);
        const mutedContactId = co.rows[0].id;
        seededContactIds.push(mutedContactId);
        await db.query(
            `INSERT INTO contact_emails (contact_id, email, email_normalized, is_primary)
             VALUES ($1, $2, $2, true)`,
            [mutedContactId, mutedAddr]);

        // Contact-keyed timeline whose ONLY signal is the (muted) email — no
        // call/SMS/open-task/unread — so if it appears it is ONLY via email.
        const mutedTl = await seedContactTimeline(DEFAULT_COMPANY_ID, mutedContactId);
        // The historical contact-keyed email: contact_id set, on_timeline=true,
        // timeline_id set, from_email = the muted address (→ email_by_contact leg 1).
        // This is exactly the row that leaked through email_by_timeline.
        await seedEmail(DEFAULT_COMPANY_ID, mutedTl.id, {
            pmid: `${TAG}-muted1`, at: '2026-07-11T12:00:00Z', subject: 'muted',
            contactId: mutedContactId, fromEmail: mutedAddr,
        });

        // (b) A genuinely CONTACTLESS Yelp timeline in the SAME company (control) —
        // it MUST still surface through email_by_timeline after the fix.
        const yelpTl = await seedContactlessTimeline(DEFAULT_COMPANY_ID, CONV('MUTECTRL'), 'Yelp Kim');
        await seedEmail(DEFAULT_COMPANY_ID, yelpTl.id, {
            pmid: `${TAG}-mutectrl1`, at: '2026-07-11T12:30:00Z', subject: 'Yelp ctrl',
        });

        const page = await timelinesQueries.getUnifiedTimelinePage({
            companyId: DEFAULT_COMPANY_ID, limit: 500, offset: 0,
            mutedEmails: [mutedAddr], mutedDomains: [],
        });
        const mutedRow = page.find(r => String(r.tl_id) === String(mutedTl.id));
        const yelpRow  = page.find(r => String(r.tl_id) === String(yelpTl.id));

        // (1) MUTE-not-resurfaced-via-email_by_timeline: the muted contact-keyed
        // email-only timeline is DROPPED — absent from the page, so its muted email
        // can never drive last_interaction_at. RED without `AND em.contact_id IS NULL`.
        expect(mutedRow).toBeUndefined();
        // (2) the contactless Yelp timeline STILL surfaces on its timeline-keyed
        // email signal, with a real recency value — the fix must not regress it.
        expect(yelpRow).toBeTruthy();
        expect(yelpRow.email_thread_id).toBeTruthy();
        expect(yelpRow.last_interaction_at).toBeTruthy();
    });
});
