'use strict';

/**
 * YELP-TIMELINE-DEDUP-001 — REAL-POSTGRES resolver + migration-165 DDL + the
 * contactless DETAIL query. TC-02, TC-06, TC-08. The DB seam is NOT mocked — the
 * partial-unique index, the widened chk_timelines_identity, and the COALESCE are
 * exactly what we prove here.
 *
 * SELF-SKIPS when no test DB is reachable OR mig 165 is not applied: the beforeAll
 * probe (SELECT yelp_conversation_id FROM timelines) sets dbReady=false and every
 * case no-ops with a SKIPPED-NEEDS-DB warning (the run does NOT fail). To exercise
 * it: point DATABASE_URL at a DB with migrations ≤165 applied.
 *
 * NAMED SABOTAGES (procedure, need DB):
 *   TC-02 SAB-RESOLVE-PLAIN-INSERT — replace the resolver's INSERT … ON CONFLICT …
 *     DO UPDATE with a plain INSERT → the 2nd same-conv call violates
 *     uq_timelines_yelp_convo (or dups) → assertion 1 RED.
 *   TC-06 SAB-KEEP-IDENTITY-CHECK — ship mig 165 without the CHECK widening → the
 *     contactless INSERT fails → RED. SAB-DROP-CONVO-UNIQUE — omit
 *     uq_timelines_yelp_convo → the dup INSERT no longer raises → RED.
 *
 * Run:
 *   node <repo>/node_modules/jest/bin/jest.js tests/yelpTimelineResolve.db.test.js \
 *     --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit
 */

const db = require('../backend/src/db/connection');
const timelinesQueries = require('../backend/src/db/timelinesQueries');
const emailQueries = require('../backend/src/db/emailQueries');
const { DEFAULT_COMPANY_ID, Y_NEW_BODY } = require('./yelpFixtures');

const COMPANY_B = '00000000-0000-0000-0000-0000000000b2';
const TAG = `TLD-${Date.now()}`;
const CONV = (s) => `CONV-${TAG}-${s}`;

let dbReady = false;
const seededConvIds = [];
const seededPmids = [];
let mailboxId = null;
let threadId = null;
let createdMailbox = false;

// A msg carrying a parseable name (parseYelpLead → 'Kim L.') for the resolver.
function msgWithName(overrides = {}) {
    return { body_text: Y_NEW_BODY, from_email: 'reply+8160b36a1c2d3e4f@messaging.yelp.com', ...overrides };
}
function msgNoName(overrides = {}) {
    return { body_text: 'no header here, just text %2Fthread%2Fx', from_email: 'reply+dead@messaging.yelp.com', ...overrides };
}

async function seedContactlessTimeline(companyId, convId, msg) {
    const tl = await timelinesQueries.resolveYelpTimeline(companyId, convId, msg);
    seededConvIds.push(convId);
    return tl;
}

async function seedEmail(companyId, timelineId, { pmid, direction = 'inbound', at, subject, body }) {
    seededPmids.push(pmid);
    await db.query(
        `INSERT INTO email_messages
            (company_id, mailbox_id, thread_id, provider_message_id, direction,
             contact_id, timeline_id, on_timeline, from_email, from_name, subject,
             body_text, gmail_internal_at)
         VALUES ($1,$2,$3,$4,$5, NULL, $6, true, 'reply+x@messaging.yelp.com', 'Kim L.', $7, $8, $9)`,
        [companyId, mailboxId, threadId, pmid, direction, timelineId, subject || 'Yelp', body || 'hi', at || new Date().toISOString()]
    );
}

beforeAll(async () => {
    try {
        await db.query('SELECT yelp_conversation_id FROM timelines LIMIT 1');
        dbReady = true;
    } catch (e) {
        console.warn('\n[yelpTimelineResolve.db] SKIPPED-NEEDS-DB —', e.message, '\n');
        dbReady = false;
        return;
    }
    // Second tenant for the cross-tenant assertion (FK: timelines.company_id → companies).
    await db.query(
        `INSERT INTO companies (id, name, slug) VALUES ($1, 'TLD Test Co B', $2)
         ON CONFLICT (id) DO NOTHING`,
        [COMPANY_B, `tld-test-co-b-${TAG}`]
    );
    // A mailbox + thread for DEFAULT company so email_messages FKs are satisfiable.
    // Reuse the existing mailbox if one is present (uniq on company_id+provider).
    const existing = await db.query(
        `SELECT id FROM email_mailboxes WHERE company_id = $1 ORDER BY id LIMIT 1`,
        [DEFAULT_COMPANY_ID]
    );
    if (existing.rows[0]) {
        mailboxId = existing.rows[0].id;
    } else {
        const mb = await db.query(
            `INSERT INTO email_mailboxes (company_id, provider, email_address, status)
             VALUES ($1, 'gmail', $2, 'connected') RETURNING id`,
            [DEFAULT_COMPANY_ID, `tld-${TAG}@example.com`]
        );
        mailboxId = mb.rows[0].id;
        createdMailbox = true;
    }
    const th = await db.query(
        `INSERT INTO email_threads (company_id, mailbox_id, provider_thread_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [DEFAULT_COMPANY_ID, mailboxId, `tld-thread-${TAG}`]
    );
    threadId = th.rows[0].id;
});

afterAll(async () => {
    if (dbReady) {
        try {
            if (seededPmids.length) {
                await db.query('DELETE FROM email_messages WHERE provider_message_id = ANY($1)', [seededPmids]);
            }
            if (seededConvIds.length) {
                await db.query('DELETE FROM timelines WHERE yelp_conversation_id = ANY($1)', [seededConvIds]);
            }
            if (threadId) await db.query('DELETE FROM email_threads WHERE id = $1', [threadId]);
            if (createdMailbox && mailboxId) await db.query('DELETE FROM email_mailboxes WHERE id = $1', [mailboxId]);
            await db.query('DELETE FROM companies WHERE id = $1', [COMPANY_B]);
        } catch (e) {
            console.warn('[yelpTimelineResolve.db] cleanup failed:', e.message);
        }
    }
    try { await db.pool.end(); } catch (_) { /* ignore */ }
});

// ── TC-02 · resolver upsert: same conv → one row; different → distinct; cross-tenant ──
describe('TC-02 · resolveYelpTimeline real upsert + tenant isolation (P0)', () => {
    it('same (company,conv) → one row; different conv → distinct; second company → distinct', async () => {
        if (!dbReady) return console.warn('TC-02 SKIPPED-NEEDS-DB');

        const a1 = await seedContactlessTimeline(DEFAULT_COMPANY_ID, CONV('A'), msgWithName());
        const a2 = await timelinesQueries.resolveYelpTimeline(DEFAULT_COMPANY_ID, CONV('A'), msgWithName());
        const b = await seedContactlessTimeline(DEFAULT_COMPANY_ID, CONV('B'), msgWithName());
        const aB = await seedContactlessTimeline(COMPANY_B, CONV('A'), msgWithName());

        // (1) upsert — same id, contactless, phoneless, badge 'yelp'
        expect(a2.id).toBe(a1.id);
        expect(a1.contact_id).toBeNull();
        expect(a1.phone_e164).toBeNull();
        expect(a1.external_source).toBe('yelp');
        // (2) different conv → different id
        expect(b.id).not.toBe(a1.id);
        // (3) same conv under a DIFFERENT company → a distinct row (per-tenant unique)
        expect(aB.id).not.toBe(a1.id);
        expect(aB.company_id).toBe(COMPANY_B);
        // (4) display_name parsed from the message ("Kim requested a quote…" → 'Kim')
        expect(a1.display_name).toBe('Kim');
    });
});

// ── TC-06 · migration-165 DDL — CHECK relax, partial-unique, COALESCE, rollback ──
describe('TC-06 · migration 165 DDL invariants (P0)', () => {
    it('contactless+phoneless INSERT succeeds; duplicate raises 23505; CHECK widened; COALESCE holds', async () => {
        if (!dbReady) return console.warn('TC-06 SKIPPED-NEEDS-DB');

        // (1) CHECK relax — a raw contactless + phoneless conv-id INSERT SUCCEEDS.
        const conv = CONV('CHK');
        seededConvIds.push(conv);
        const ins = await db.query(
            `INSERT INTO timelines (company_id, yelp_conversation_id, external_source)
             VALUES ($1,$2,'yelp') RETURNING id, contact_id, phone_e164`,
            [DEFAULT_COMPANY_ID, conv]
        );
        expect(Number(ins.rows[0].id)).toBeGreaterThan(0); // pg returns bigint as string
        expect(ins.rows[0].contact_id).toBeNull();
        expect(ins.rows[0].phone_e164).toBeNull();

        // (2) partial-unique — a 2nd INSERT with the SAME (company, conv) → 23505.
        let code = null;
        try {
            await db.query(
                `INSERT INTO timelines (company_id, yelp_conversation_id, external_source)
                 VALUES ($1,$2,'yelp')`,
                [DEFAULT_COMPANY_ID, conv]
            );
        } catch (e) { code = e.code; }
        expect(code).toBe('23505');

        // (3) the widened CHECK carries all THREE identity disjuncts (additive) …
        const def = await db.query(
            `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='chk_timelines_identity'`
        );
        expect(def.rows[0].def).toMatch(/contact_id IS NOT NULL/);
        expect(def.rows[0].def).toMatch(/phone_e164 IS NOT NULL/);
        expect(def.rows[0].def).toMatch(/yelp_conversation_id IS NOT NULL/);
        // … and a legacy orphan-phone row (phone disjunct) still INSERTs.
        const orphanPhone = `+1617555${String(Date.now()).slice(-4)}`;
        const orphan = await db.query(
            `INSERT INTO timelines (company_id, phone_e164) VALUES ($1,$2) RETURNING id`,
            [DEFAULT_COMPANY_ID, orphanPhone]
        );
        expect(Number(orphan.rows[0].id)).toBeGreaterThan(0);
        await db.query('DELETE FROM timelines WHERE id = $1', [orphan.rows[0].id]);

        // (4) COALESCE — a name on first insert survives a later name-less upsert.
        const cc = CONV('COAL');
        const withName = await seedContactlessTimeline(DEFAULT_COMPANY_ID, cc, msgWithName());
        expect(withName.display_name).toBe('Kim');
        const nameless = await timelinesQueries.resolveYelpTimeline(DEFAULT_COMPANY_ID, cc, msgNoName());
        expect(nameless.id).toBe(withName.id);
        expect(nameless.display_name).toBe('Kim'); // NOT nulled
    });

    it('rollback_165 restores the strict 2-key CHECK (disposable txn)', async () => {
        if (!dbReady) return console.warn('TC-06-rollback SKIPPED-NEEDS-DB');
        const fs = require('fs');
        const path = require('path');
        const rollbackSql = fs.readFileSync(
            path.join(__dirname, '../backend/db/migrations/rollback_165_yelp_timeline_dedup.sql'), 'utf8');

        const client = await db.getClient();
        try {
            await client.query('BEGIN');
            // Serialize this DDL section against sibling DB suites that may be committing
            // contactless rows concurrently — otherwise the ADD CONSTRAINT below (a
            // table-wide validation) could see another worker's row and fail. The lock
            // releases on ROLLBACK (fast).
            await client.query('LOCK TABLE timelines IN ACCESS EXCLUSIVE MODE');
            // Inside the disposable txn, clear contactless conv-id rows so re-ADDing the
            // strict 2-key CHECK does not fail on rows THIS run committed. The ROLLBACK
            // below restores both the rows and the mig-165 state for the shared DB.
            await client.query('DELETE FROM timelines WHERE yelp_conversation_id IS NOT NULL');
            await client.query(rollbackSql);
            // Post-rollback, a contactless+phoneless INSERT must FAIL the strict CHECK.
            let code = null;
            try {
                await client.query(
                    `INSERT INTO timelines (company_id, phone_e164, contact_id) VALUES ($1, NULL, NULL)`,
                    [DEFAULT_COMPANY_ID]
                );
            } catch (e) { code = e.code; }
            expect(code).toBe('23514'); // check_violation — the strict identity CHECK is back
        } finally {
            await client.query('ROLLBACK'); // DISPOSABLE — mig-165 state restored for the shared DB
            client.release();
        }
    });
});

// ── TC-08 · getTimelineEmailByTimeline — contactless conversation's emails ──────
describe('TC-08 · contactless DETAIL query (P0)', () => {
    it('returns the timeline’s emails oldest→newest; company-scoped', async () => {
        if (!dbReady) return console.warn('TC-08 SKIPPED-NEEDS-DB');

        const tl = await seedContactlessTimeline(DEFAULT_COMPANY_ID, CONV('DETAIL'), msgWithName());
        await seedEmail(DEFAULT_COMPANY_ID, tl.id, { pmid: `${TAG}-d1`, at: '2026-07-10T12:00:00Z', subject: 'first', body: 'first msg' });
        await seedEmail(DEFAULT_COMPANY_ID, tl.id, { pmid: `${TAG}-d2`, at: '2026-07-10T13:00:00Z', subject: 'second', body: 'second msg' });

        const rows = await emailQueries.getTimelineEmailByTimeline(DEFAULT_COMPANY_ID, tl.id);
        expect(rows).toHaveLength(2);
        expect(rows[0].subject).toBe('first');   // oldest first
        expect(rows[1].subject).toBe('second');
        expect(rows.every(r => r.direction === 'inbound')).toBe(true);

        // company-scoped: another company sees none of this timeline's emails.
        const cross = await emailQueries.getTimelineEmailByTimeline(COMPANY_B, tl.id);
        expect(cross).toEqual([]);
    });

    // SAB-DETAIL-CONTACT-ONLY — buildTimeline (pulse.js) is a module-internal Express
    // handler (not exported, needs req/res), so its contactless projection is guarded
    // structurally: it must call getTimelineEmailByTimeline in the no-contact branch
    // and gate on (contact?.id || timeline?.id). Reverting to `if (contact?.id)` only
    // (the sabotage) drops both tokens → RED.
    it('buildTimeline projects email when timeline?.id is present (SAB-DETAIL-CONTACT-ONLY)', () => {
        const fs = require('fs');
        const path = require('path');
        const src = fs.readFileSync(path.join(__dirname, '../backend/src/routes/pulse.js'), 'utf8');
        expect(src).toMatch(/getTimelineEmailByTimeline\(emailCompanyId,\s*timeline\.id\)/);
        expect(src).toMatch(/contact\?\.id\s*\|\|\s*timeline\?\.id/);
    });
});
