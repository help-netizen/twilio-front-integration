#!/usr/bin/env node
/**
 * EMAIL-OUTBOUND-001 — T3 integration verify script.
 *
 * Runs TC-EO-I01…I22 + TC-EO-SEC01/SEC02 (Docs/test-cases/EMAIL-OUTBOUND-001.md)
 * against the REAL local Postgres (no mocks anywhere):
 *   • query halves    — the real `timelinesQueries.getUnifiedTimelinePage`
 *   • route halves    — the real `backend/src/routes/calls.js` mounted in express
 *                       behind a stub auth middleware (req.user / req.authz with
 *                       pulse.view / req.companyFilter = {company_id}), via supertest
 *   • writer halves   — the real `emailTimelineService.linkOutboundMessage`
 *                       (Gmail API is never called: input is the already-normalized
 *                       message object — the push boundary is the function argument)
 *   • migration cases — the real `backend/db/migrations/155_…sql` file executed
 *                       via fs + pg (NOTICE output captured on the client), run
 *                       twice where idempotence is asserted
 *
 * Fixtures are self-seeded with a unique tag and cleaned BEFORE each case and at
 * process start/end, so re-runs are clean:
 *   provider ids   LIKE 'eo1-%'        emails LIKE '%@eo1.test'
 *   contact names  LIKE 'EO1 %'        phones LIKE '+1999555…'
 *   call sids      LIKE 'EO1-%' / 'EOPAGE%'
 * Company A = the seed company 00000000-0000-0000-0000-000000000001 (real dev
 * rows coexist → assertions are row-targeted / delta-based, never absolute
 * counts of the whole page — except in the tagged isolated companies below).
 * Company B  (SEC01/SEC02 cross-tenant) and company A2 (edge-no-email) are
 * CREATED tagged and deleted by cleanup.
 *
 * Usage:
 *   node scripts/verify-email-outbound-001.js [--section=cte|migration|route|all]
 *   node scripts/verify-email-outbound-001.js --section=s5      (single case section)
 *
 * DATABASE_URL defaults to postgresql://localhost/twilio_calls (house default).
 * Never point this at prod. Exit code 0 only when no case FAILs.
 */
'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/twilio_calls';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const db = require(path.join(ROOT, 'backend/src/db/connection'));
const timelinesQueries = require(path.join(ROOT, 'backend/src/db/timelinesQueries'));

const MIG_PATH = path.join(ROOT, 'backend/db/migrations/155_backfill_outbound_email_links.sql');
const ROLLBACK_PATH = path.join(ROOT, 'backend/db/migrations/rollback_155_backfill_outbound_email_links.sql');

const COMPANY_A = '00000000-0000-0000-0000-000000000001'; // seed company (real dev data coexists)
const COMPANY_B = 'e0000000-0000-4000-8000-00000000000b'; // tagged, created+deleted here
const COMPANY_A2 = 'e0000000-0000-4000-8000-0000000000a2'; // tagged, created+deleted here

// ─── tiny assert/report kit ─────────────────────────────────────────────────

class CheckError extends Error {}
function check(cond, msg) {
    if (!cond) throw new CheckError(msg);
}
function eq(actual, expected, label) {
    // Loose scalar equality with readable output (timestamps compared as ISO).
    const a = actual instanceof Date ? actual.toISOString() : actual;
    const b = expected instanceof Date ? expected.toISOString() : expected;
    check(String(a) === String(b), `${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const results = [];
function record(id, status, note) {
    results.push({ id, status, note: note || '' });
    const pad = ' '.repeat(Math.max(1, 12 - id.length));
    console.log(`${status} ${id}${pad}${note || ''}`);
}

// ─── seeding helpers (all tagged) ───────────────────────────────────────────

let phoneSeq = 100;
function nextPhone() {
    phoneSeq += 1;
    return `+1999555${String(phoneSeq).padStart(4, '0')}`;
}

async function ensureCompany(id, slug, name) {
    await db.query(
        `INSERT INTO companies (id, name, slug, status) VALUES ($1, $2, $3, 'active')
         ON CONFLICT (id) DO NOTHING`,
        [id, name, slug]
    );
}

const mailboxCache = {};
async function mailboxFor(companyId) {
    if (mailboxCache[companyId]) return mailboxCache[companyId];
    // Reuse the company's existing gmail mailbox (company A has a real dev one);
    // uniq_email_mailbox_company_provider allows only one per company anyway.
    const existing = await db.query(
        `SELECT id FROM email_mailboxes WHERE company_id = $1 AND provider = 'gmail' LIMIT 1`,
        [companyId]
    );
    if (existing.rows[0]) {
        mailboxCache[companyId] = existing.rows[0].id;
        return existing.rows[0].id;
    }
    const created = await db.query(
        `INSERT INTO email_mailboxes (company_id, provider, email_address, status)
         VALUES ($1, 'gmail', $2, 'connected') RETURNING id`,
        [companyId, `mb-${companyId.slice(-4)}@eo1.test`]
    );
    mailboxCache[companyId] = created.rows[0].id;
    return created.rows[0].id;
}

async function mkContact({ companyId, name, email = null, phone = null, secondary = null, updatedAt = null }) {
    const r = await db.query(
        `INSERT INTO contacts (full_name, email, phone_e164, secondary_phone, company_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now())) RETURNING id`,
        [`EO1 ${name}`, email, phone, secondary, companyId, updatedAt]
    );
    return r.rows[0].id;
}

async function mkContactEmail(contactId, addr) {
    await db.query(
        `INSERT INTO contact_emails (contact_id, email, email_normalized)
         VALUES ($1, $2, lower(trim($2)))`,
        [contactId, addr]
    );
}

async function mkTimeline({ companyId, contactId = null, phone = null }) {
    const r = await db.query(
        `INSERT INTO timelines (contact_id, phone_e164, company_id) VALUES ($1, $2, $3) RETURNING id`,
        [contactId, phone, companyId]
    );
    return r.rows[0].id;
}

async function mkThread({ companyId, tag, subject, lastAt = null, lastDir = null, unread = 0 }) {
    const mailboxId = await mailboxFor(companyId);
    const r = await db.query(
        `INSERT INTO email_threads (company_id, mailbox_id, provider_thread_id, subject,
                                    last_message_at, last_message_direction, unread_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [companyId, mailboxId, `eo1-${tag}`, subject, lastAt, lastDir, unread]
    );
    return r.rows[0].id;
}

async function mkMsg({
    companyId, threadId, tag, direction,
    fromEmail = null, to = [], cc = [],
    msgIdHeader = undefined, // undefined ⇒ '<eo1-tag@eo1.test>' (sent); pass null/'' for draft shapes
    contactId = null, timelineId = null, onTimeline = false, at = null, subject = null,
}) {
    const mailboxId = await mailboxFor(companyId);
    const header = msgIdHeader === undefined ? `<eo1-${tag}@eo1.test>` : msgIdHeader;
    const r = await db.query(
        `INSERT INTO email_messages (company_id, mailbox_id, thread_id, provider_message_id,
                                     message_id_header, direction, from_email,
                                     to_recipients_json, cc_recipients_json, subject,
                                     gmail_internal_at, contact_id, timeline_id, on_timeline)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14)
         RETURNING id, provider_message_id`,
        [companyId, mailboxId, threadId, `eo1-${tag}`, header, direction, fromEmail,
            JSON.stringify(to), JSON.stringify(cc), subject, at, contactId, timelineId, onTimeline]
    );
    return r.rows[0];
}

let callSeq = 0;
async function mkCall({ companyId, timelineId, contactId = null, startedAt, sid = null }) {
    callSeq += 1;
    const callSid = sid || `EO1-CALL-${callSeq}`;
    const r = await db.query(
        `INSERT INTO calls (call_sid, direction, from_number, to_number, status, is_final,
                            started_at, company_id, timeline_id, contact_id)
         VALUES ($1, 'inbound', '+19995550000', '+19995550001', 'completed', true, $2, $3, $4, $5)
         RETURNING id, call_sid`,
        [callSid, startedAt, companyId, timelineId, contactId]
    );
    return r.rows[0];
}

async function mkTask({ companyId, threadId, title }) {
    const r = await db.query(
        `INSERT INTO tasks (company_id, thread_id, title, status) VALUES ($1, $2, $3, 'open') RETURNING id`,
        [companyId, threadId, `EO1 ${title}`]
    );
    return r.rows[0].id;
}

async function mkSms({ companyId, customerE164, lastAt, dir = 'inbound', friendly }) {
    const r = await db.query(
        `INSERT INTO sms_conversations (company_id, customer_e164, friendly_name,
                                        last_message_at, last_message_direction, has_unread)
         VALUES ($1, $2, $3, $4, $5, false) RETURNING id`,
        [companyId, customerE164, `EO1 ${friendly}`, lastAt, dir]
    );
    return r.rows[0].id;
}

// ─── cleanup (FK order; run before every case + at start/end) ───────────────

async function cleanupAll() {
    mailboxCache[COMPANY_B] = undefined;
    mailboxCache[COMPANY_A2] = undefined;
    // FK order matters: calls/tasks before timelines; timelines before contacts
    // (contacts FK ON DELETE SET NULL on a phone-less timeline would violate
    // chk_timelines_identity); companies last.
    await db.query(`DELETE FROM tasks WHERE title LIKE 'EO1 %'`);
    await db.query(`DELETE FROM email_messages WHERE provider_message_id LIKE 'eo1-%'`);
    await db.query(`DELETE FROM email_threads WHERE provider_thread_id LIKE 'eo1-%'`);
    await db.query(`DELETE FROM email_mailboxes WHERE lower(email_address) LIKE '%@eo1.test'`);
    await db.query(`DELETE FROM calls WHERE call_sid LIKE 'EO1-%' OR call_sid LIKE 'EOPAGE%'`);
    await db.query(`DELETE FROM sms_conversations WHERE friendly_name LIKE 'EO1 %'`);
    await db.query(`DELETE FROM timelines WHERE company_id IN ($1, $2)`, [COMPANY_B, COMPANY_A2]);
    await db.query(`DELETE FROM timelines WHERE contact_id IN (SELECT id FROM contacts WHERE full_name LIKE 'EO1 %')`);
    await db.query(`DELETE FROM timelines WHERE contact_id IS NULL AND phone_e164 LIKE '+1999555%'`);
    await db.query(`DELETE FROM contacts WHERE full_name LIKE 'EO1 %'`);
    await db.query(`DELETE FROM companies WHERE id IN ($1, $2)`, [COMPANY_B, COMPANY_A2]);
}

// ─── real-function / real-route harness ─────────────────────────────────────

async function fetchPage(companyId, { limit = 2000, offset = 0, search = null } = {}) {
    return timelinesQueries.getUnifiedTimelinePage({ limit, offset, companyId, search });
}

const appCache = {};
function appFor(companyId) {
    if (appCache[companyId]) return appCache[companyId];
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        // Stub auth ONLY — the router, its permission middleware and the handler
        // are the real production modules.
        req.user = { sub: 'eo1-verify', email: 'eo1-verify@eo1.test', crmUser: { id: 1 } };
        req.authz = {
            permissions: ['pulse.view', 'reports.calls.view'],
            company: { id: companyId, status: 'active' },
            scopes: {},
        };
        req.companyFilter = { company_id: companyId };
        next();
    });
    app.use('/api/calls', require(path.join(ROOT, 'backend/src/routes/calls')));
    appCache[companyId] = app;
    return app;
}

const request = require(path.join(ROOT, 'node_modules/supertest'));
async function routeGet(companyId, url) {
    return request(appFor(companyId)).get(url);
}
async function routePost(companyId, url) {
    return request(appFor(companyId)).post(url).send({});
}
async function routeList(companyId, { limit = 2000, offset = 0, search = null } = {}) {
    let url = `/api/calls/by-contact?limit=${limit}&offset=${offset}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
    const res = await routeGet(companyId, url);
    check(res.status === 200, `GET /by-contact expected 200, got ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
}

function rowsFor(rows, timelineId) {
    return rows.filter(r => Number(r.timeline_id ?? r.tl_id) === Number(timelineId));
}
function oneRowFor(rows, timelineId, label) {
    const mine = rowsFor(rows, timelineId);
    check(mine.length === 1, `${label}: expected exactly 1 row for timeline ${timelineId}, got ${mine.length}`);
    return mine[0];
}
// Sort tier as the SQL computes it (route rows expose the same signals).
function tierOf(row) {
    const snoozed = row.snoozed_until && new Date(row.snoozed_until) > new Date();
    const hasOpenTask = row.has_open_task !== undefined ? row.has_open_task : !!row.open_task_id;
    const unread = row.has_unread !== undefined ? !!row.has_unread : !!row.any_unread;
    if (hasOpenTask && !snoozed) return 0;
    if (unread) return 1;
    return 2;
}

// ─── migration runner (fs + pg, NOTICE captured) ────────────────────────────

function parseNotices(list) {
    const g = (re) => {
        for (const m of list) {
            const x = m.match(re);
            if (x) return parseInt(x[1], 10);
        }
        return null;
    };
    return {
        candidates: g(/step 1: examined (\d+)/),
        adopted: g(/step 2b: adopted (\d+)/),
        repointed: g(/re-pointed (\d+)/),
        created: g(/step 2c: created (\d+)/),
        linked: g(/step 3: linked (\d+)/),
        rehomed: g(/step 4: re-homed (\d+)/),
        raw: list,
    };
}

async function runMig155({ client = null } = {}) {
    const sql = fs.readFileSync(MIG_PATH, 'utf8');
    const own = !client;
    const c = client || await db.pool.connect();
    const notices = [];
    const onNotice = (n) => notices.push(n.message || String(n));
    c.on('notice', onNotice);
    try {
        await c.query(sql);
    } finally {
        c.removeListener('notice', onNotice);
        if (own) c.release();
    }
    const parsed = parseNotices(notices);
    check(parsed.candidates !== null && parsed.linked !== null && parsed.adopted !== null
        && parsed.created !== null && parsed.rehomed !== null,
        `mig 155 NOTICE output missing expected step lines: ${JSON.stringify(notices)}`);
    return parsed;
}

async function msgState(providerMessageId) {
    const r = await db.query(
        `SELECT id, contact_id, timeline_id, on_timeline, updated_at::text AS updated_at
         FROM email_messages WHERE provider_message_id = $1`,
        [providerMessageId]
    );
    return r.rows[0] || null;
}

async function timelinesOf(contactId) {
    const r = await db.query(`SELECT id, phone_e164, updated_at::text AS updated_at FROM timelines WHERE contact_id = $1 ORDER BY id`, [contactId]);
    return r.rows;
}

async function scalar(sql, params = []) {
    const r = await db.query(sql, params);
    return r.rows[0] ? Object.values(r.rows[0])[0] : null;
}

// Company-wide write-detection hashes (used by idempotency cases).
async function companyHashes(companyId) {
    return {
        emails: await scalar(
            `SELECT COALESCE(md5(string_agg(id::text||':'||COALESCE(contact_id::text,'')||':'||COALESCE(timeline_id::text,'')||':'||on_timeline::text||':'||updated_at::text, ',' ORDER BY id)), 'empty')
             FROM email_messages WHERE company_id = $1`, [companyId]),
        timelines: await scalar(
            `SELECT COALESCE(md5(string_agg(id::text||':'||COALESCE(contact_id::text,'')||':'||COALESCE(phone_e164,'')||':'||updated_at::text, ',' ORDER BY id)), 'empty')
             FROM timelines WHERE company_id = $1`, [companyId]),
        tasks: await scalar(
            `SELECT COALESCE(md5(string_agg(id::text||':'||COALESCE(thread_id::text,'')||':'||status, ',' ORDER BY id)), 'empty')
             FROM tasks WHERE company_id = $1`, [companyId]),
    };
}

// ─── timestamps ──────────────────────────────────────────────────────────────

const T = (m) => new Date(Date.UTC(2026, 6, 2, 10, m, 0)).toISOString(); // 2026-07-02T10:MM:00Z

// ═════════════════════════════════════════════════════════════════════════════
// Cases
// ═════════════════════════════════════════════════════════════════════════════

const CASES = [];
function CASE(id, section, group, title, fn) {
    CASES.push({ id, section, group, title, fn });
}

// ---------------------------------------------------------------------------
CASE('TC-EO-I01', 's1', 'route', 'S1 outbound-first (composer-linked) thread surfaces', async () => {
    const t1 = T(10);
    const c = await mkContact({ companyId: COMPANY_A, name: 'I01 Lead', email: null });
    await mkContactEmail(c, 'i01-lead@eo1.test');
    const tl = await mkTimeline({ companyId: COMPANY_A, contactId: c });
    const th = await mkThread({ companyId: COMPANY_A, tag: 'i01-t1', subject: 'EO1 I01 intro', lastAt: t1, lastDir: 'outbound', unread: 0 });
    await mkMsg({ companyId: COMPANY_A, threadId: th, tag: 'i01-m1', direction: 'outbound', to: [{ email: 'i01-lead@eo1.test' }], contactId: c, timelineId: tl, onTimeline: true, at: t1, subject: 'EO1 I01 intro' });

    // (1) real query
    const rows = await fetchPage(COMPANY_A);
    const row = oneRowFor(rows, tl, 'query');
    eq(row.email_thread_id, th, 'email_thread_id');
    eq(row.email_subject, 'EO1 I01 intro', 'email_subject');
    eq(new Date(row.email_last_message_at).toISOString(), t1, 'email_last_message_at');
    eq(row.email_last_message_direction, 'outbound', 'email_last_message_direction');
    eq(Number(row.email_unread_count), 0, 'email_unread_count');
    eq(row.any_unread, false, 'any_unread');
    check(Number(row.total_count) === rows.length, `total_count (${row.total_count}) counts the surfaced set incl. this row (page=${rows.length})`);

    // (2) real route
    const body = await routeList(COMPANY_A);
    const rrow = oneRowFor(body.conversations, tl, 'route');
    eq(rrow.last_interaction_type, 'email_outbound', 'route last_interaction_type');
    eq(new Date(rrow.last_interaction_at).toISOString(), t1, 'route last_interaction_at');
    eq(rrow.has_unread, false, 'route has_unread');
    eq(rrow.has_open_task, false, 'route has_open_task');
    check(tierOf(rrow) === 2, 'row sorts in tier 2 (not AR-pinned, not unread)');
});

// ---------------------------------------------------------------------------
CASE('TC-EO-I02', 's2', 'cte', 'S2 Gmail-direct send via real linkOutboundMessage is list-identical to S1', async () => {
    const emailTimelineService = require(path.join(ROOT, 'backend/src/services/email/emailTimelineService'));
    const t1 = T(11);
    const c = await mkContact({ companyId: COMPANY_A, name: 'I02 Lead' });
    await mkContactEmail(c, 'i02-lead@eo1.test');
    // Pre-link ingest shape: unlinked row + thread with a non-zero unread to prove the clear.
    const th = await mkThread({ companyId: COMPANY_A, tag: 'i02-t1', subject: 'EO1 I02 gmail direct', lastAt: t1, lastDir: 'outbound', unread: 2 });
    const msg = await mkMsg({
        companyId: COMPANY_A, threadId: th, tag: 'i02-m1', direction: 'outbound',
        to: [{ email: 'unknown@eo1-nowhere.test' }, { email: 'i02-lead@eo1.test' }], at: t1,
        subject: 'EO1 I02 gmail direct',
    });

    // Real writer (protected, unchanged — asserting equivalence): first MATCHING recipient wins.
    const res = await emailTimelineService.linkOutboundMessage(COMPANY_A, {
        provider_message_id: msg.provider_message_id,
        labelIds: ['SENT'],
        to: [{ email: 'unknown@eo1-nowhere.test' }, { email: 'i02-lead@eo1.test' }],
    });
    check(res && res.linked === true, `linkOutboundMessage → linked, got ${JSON.stringify(res)}`);
    eq(res.contactId, c, 'link landed on C (first MATCHING recipient wins)');

    const st = await msgState(msg.provider_message_id);
    eq(st.contact_id, c, 'stamped contact_id');
    check(st.timeline_id != null, 'stamped timeline_id');
    eq(st.on_timeline, true, 'stamped on_timeline');
    eq(await scalar(`SELECT unread_count FROM email_threads WHERE id = $1`, [th]), 0, 'markThreadRead zeroed unread_count');

    const body = await routeList(COMPANY_A);
    const rrow = oneRowFor(body.conversations, st.timeline_id, 'route');
    eq(rrow.last_interaction_type, 'email_outbound', 'type email_outbound');
    eq(rrow.has_unread, false, 'not unread');
    eq(rrow.has_open_task, false, 'not AR');
    eq(rrow.email_thread_id, th, 'email_thread_id');
});

// ---------------------------------------------------------------------------
CASE('TC-EO-I03', 's3', 'route', 'S3 reply flips to inbound+unread; mark-read clears; no duplicate row', async () => {
    const t1 = T(12), t2 = T(20);
    const c = await mkContact({ companyId: COMPANY_A, name: 'I03 Lead' });
    await mkContactEmail(c, 'i03-lead@eo1.test');
    const tl = await mkTimeline({ companyId: COMPANY_A, contactId: c });
    const th = await mkThread({ companyId: COMPANY_A, tag: 'i03-t1', subject: 'EO1 I03 thread', lastAt: t1, lastDir: 'outbound', unread: 0 });
    await mkMsg({ companyId: COMPANY_A, threadId: th, tag: 'i03-m1', direction: 'outbound', to: [{ email: 'i03-lead@eo1.test' }], contactId: c, timelineId: tl, onTimeline: true, at: t1 });

    // (1) the reply, as sync writes it — mixed case + trailing space exercises lower(trim()).
    await mkMsg({ companyId: COMPANY_A, threadId: th, tag: 'i03-m2', direction: 'inbound', fromEmail: ' I03-Lead@EO1.TEST ', at: t2 });
    await db.query(`UPDATE email_threads SET last_message_at = $2, last_message_direction = 'inbound', unread_count = 1 WHERE id = $1`, [th, t2]);

    // (2) both legs now emit the same thread tuple → DISTINCT ON collapses to ONE row.
    let body = await routeList(COMPANY_A);
    let rrow = oneRowFor(body.conversations, tl, 'after reply');
    eq(new Date(rrow.last_interaction_at).toISOString(), t2, 'last_interaction_at = reply time');
    eq(rrow.last_interaction_type, 'email_inbound', 'type flips to email_inbound');
    eq(rrow.has_unread, true, 'unread after reply');
    check(tierOf(rrow) === 1, 'row is in the unread tier');

    // (3) real mark-read routes: timeline first, then the contact variant.
    const mr1 = await routePost(COMPANY_A, `/api/calls/timeline/${tl}/mark-read`);
    check(mr1.status === 200, `timeline mark-read expected 200, got ${mr1.status}`);
    const mr2 = await routePost(COMPANY_A, `/api/calls/contact/${c}/mark-read`);
    check(mr2.status === 200, `contact mark-read expected 200, got ${mr2.status}`);

    // (4) cleared; position/timestamps unchanged.
    body = await routeList(COMPANY_A);
    rrow = oneRowFor(body.conversations, tl, 'after mark-read');
    eq(rrow.has_unread, false, 'has_unread cleared');
    eq(new Date(rrow.email_last_message_at || rrow.last_interaction_at).toISOString(), t2, 'email_last_message_at still t2');
    eq(rrow.last_interaction_type, 'email_inbound', 'type unchanged by mark-read');
});

// ---------------------------------------------------------------------------
CASE('TC-EO-I04', 's4', 'route', 'S4 mixed-channel bump: existing row re-orders, no duplicate, tie keeps call', async () => {
    const t0 = T(5), tMid = T(15), t3 = T(30);
    const c2 = await mkContact({ companyId: COMPANY_A, name: 'I04 C2' });
    await mkContactEmail(c2, 'i04-c2@eo1.test');
    const tl2 = await mkTimeline({ companyId: COMPANY_A, contactId: c2 });
    await mkCall({ companyId: COMPANY_A, timelineId: tl2, contactId: c2, startedAt: t0 });
    const c3 = await mkContact({ companyId: COMPANY_A, name: 'I04 C3' });
    const tl3 = await mkTimeline({ companyId: COMPANY_A, contactId: c3 });
    await mkCall({ companyId: COMPANY_A, timelineId: tl3, contactId: c3, startedAt: tMid });

    // (1) baseline: C3 above C2 (t_mid > t0).
    let body = await routeList(COMPANY_A);
    const totalBefore = body.total;
    const idx = (rows, tl) => rows.findIndex(r => Number(r.timeline_id) === Number(tl));
    check(idx(body.conversations, tl3) < idx(body.conversations, tl2), 'baseline: C3 above C2');

    // (2) outbound email to C2 at t3 > t_mid.
    const th = await mkThread({ companyId: COMPANY_A, tag: 'i04-t1', subject: 'EO1 I04 email', lastAt: t3, lastDir: 'outbound', unread: 0 });
    await mkMsg({ companyId: COMPANY_A, threadId: th, tag: 'i04-m1', direction: 'outbound', to: [{ email: 'i04-c2@eo1.test' }], contactId: c2, timelineId: tl2, onTimeline: true, at: t3 });

    // (3) same row re-orders; no duplicate; total unchanged.
    body = await routeList(COMPANY_A);
    const r2 = oneRowFor(body.conversations, tl2, 'C2 after email');
    check(idx(body.conversations, tl2) < idx(body.conversations, tl3), 'C2 moved above C3');
    eq(new Date(r2.last_interaction_at).toISOString(), t3, 'last_interaction_at = t3');
    eq(r2.last_interaction_type, 'email_outbound', 'type email_outbound');
    eq(body.total, totalBefore, 'total unchanged (no duplicate row)');

    // (4→5) exact tie: email time == call time → route keeps call priority.
    await db.query(`UPDATE email_threads SET last_message_at = $2 WHERE id = $1`, [th, t0]);
    body = await routeList(COMPANY_A);
    const tied = oneRowFor(body.conversations, tl2, 'C2 tie probe');
    eq(tied.last_interaction_type, 'call', 'exact tie → call > email');
});

// ---------------------------------------------------------------------------
CASE('TC-EO-I05', 's5', 'cte', 'S5 two threads one contact: newest wins across directions + deterministic tie', async () => {
    const t1 = T(10), t2 = T(20), t3 = T(30);
    const c = await mkContact({ companyId: COMPANY_A, name: 'I05 Lead' });
    await mkContactEmail(c, 'i05-lead@eo1.test');
    const tl = await mkTimeline({ companyId: COMPANY_A, contactId: c });
    // T1: inbound-matched only (leg 1).
    const th1 = await mkThread({ companyId: COMPANY_A, tag: 'i05-t1', subject: 'EO1 I05 T1', lastAt: t1, lastDir: 'inbound', unread: 0 });
    await mkMsg({ companyId: COMPANY_A, threadId: th1, tag: 'i05-m1', direction: 'inbound', fromEmail: 'i05-lead@eo1.test', at: t1 });
    // T2: outbound-linked only (leg 2), newer.
    const th2 = await mkThread({ companyId: COMPANY_A, tag: 'i05-t2', subject: 'EO1 I05 T2', lastAt: t2, lastDir: 'outbound', unread: 0 });
    await mkMsg({ companyId: COMPANY_A, threadId: th2, tag: 'i05-m2', direction: 'outbound', to: [{ email: 'i05-lead@eo1.test' }], contactId: c, timelineId: tl, onTimeline: true, at: t2 });
    check(th2 > th1, 'fixture sanity: T2.id > T1.id');

    // (1) newest thread (T2) wins; fields come from T2. (Also the symmetric
    // "older outbound + newer inbound" direction is covered by step (2).)
    let rows = await fetchPage(COMPANY_A);
    let row = oneRowFor(rows, tl, 'step1');
    eq(row.email_thread_id, th2, 'email_thread_id = T2');
    eq(row.email_subject, 'EO1 I05 T2', 'subject from T2');
    eq(row.email_last_message_direction, 'outbound', 'direction from T2');

    // (2) bump T1 with the newest inbound reply → flips back to T1, unread.
    await mkMsg({ companyId: COMPANY_A, threadId: th1, tag: 'i05-m3', direction: 'inbound', fromEmail: 'i05-lead@eo1.test', at: t3 });
    await db.query(`UPDATE email_threads SET last_message_at = $2, last_message_direction = 'inbound', unread_count = 1 WHERE id = $1`, [th1, t3]);
    rows = await fetchPage(COMPANY_A);
    row = oneRowFor(rows, tl, 'step2');
    eq(row.email_thread_id, th1, 'flips back to T1');
    eq(row.email_last_message_direction, 'inbound', 'inbound');
    eq(row.any_unread, true, 'unread');

    // (3) exact-equal timestamps → the HIGHER email_threads.id wins, stably (3 fetches).
    await db.query(`UPDATE email_threads SET last_message_at = $2, unread_count = 0 WHERE id = $1`, [th1, t2]);
    const picks = [];
    for (let i = 0; i < 3; i++) {
        rows = await fetchPage(COMPANY_A);
        picks.push(oneRowFor(rows, tl, `step3 fetch ${i}`).email_thread_id);
    }
    check(picks.every(p => Number(p) === Number(th2)), `equal-ts tie → higher id (T2=${th2}) wins on every fetch, got ${picks}`);
});

// ---------------------------------------------------------------------------
CASE('TC-EO-I06', 's6', 'migration', 'S6 outbound to a NON-contact recipient surfaces nothing (writer + mig)', async () => {
    const emailTimelineService = require(path.join(ROOT, 'backend/src/services/email/emailTimelineService'));
    const t1 = T(10);
    const th = await mkThread({ companyId: COMPANY_A, tag: 'i06-t1', subject: 'EO1 I06 stranger', lastAt: t1, lastDir: 'outbound', unread: 0 });
    const msg = await mkMsg({ companyId: COMPANY_A, threadId: th, tag: 'i06-m1', direction: 'outbound', to: [{ email: 'stranger@eo1-nowhere.test' }], at: t1 });
    const contactsBefore = Number(await scalar(`SELECT count(*) FROM contacts`));

    // (1) writer half: no contact match.
    const res = await emailTimelineService.linkOutboundMessage(COMPANY_A, {
        provider_message_id: msg.provider_message_id, labelIds: ['SENT'], to: [{ email: 'stranger@eo1-nowhere.test' }],
    });
    eq(res && res.skipped, 'no_contact', 'linkOutboundMessage skips with no_contact');

    // (2) list: nothing references the thread.
    let rows = await fetchPage(COMPANY_A);
    const totalBefore = rows.length ? Number(rows[0].total_count) : 0;
    check(rows.every(r => Number(r.email_thread_id) !== Number(th)), 'no list row references the thread (pre-mig)');

    // (3) migration matches nothing for it.
    const counts = await runMig155();
    eq(counts.linked, 0, 'mig linked 0');
    const st = await msgState(msg.provider_message_id);
    check(st.contact_id === null && st.on_timeline === false, 'message STILL unlinked after mig');

    // (4) still nothing; totals + contacts unchanged.
    rows = await fetchPage(COMPANY_A);
    check(rows.every(r => Number(r.email_thread_id) !== Number(th)), 'no list row references the thread (post-mig)');
    eq(rows.length ? Number(rows[0].total_count) : 0, totalBefore, 'total unchanged');
    eq(Number(await scalar(`SELECT count(*) FROM contacts`)), contactsBefore, 'no contact auto-created');
});

// ---------------------------------------------------------------------------
CASE('TC-EO-I07', 's7', 'migration', 'S7 DRAFT never surfaces, pre- and post-migration', async () => {
    const emailTimelineService = require(path.join(ROOT, 'backend/src/services/email/emailTimelineService'));
    const t1 = T(10);
    const c = await mkContact({ companyId: COMPANY_A, name: 'I07 Lead' });
    await mkContactEmail(c, 'i07-lead@eo1.test');
    const th = await mkThread({ companyId: COMPANY_A, tag: 'i07-t1', subject: 'EO1 I07 draft', lastAt: t1, lastDir: 'outbound', unread: 0 });
    // Draft shapes: header NULL and header ''.
    const draftNull = await mkMsg({ companyId: COMPANY_A, threadId: th, tag: 'i07-m1', direction: 'outbound', to: [{ email: 'i07-lead@eo1.test' }], msgIdHeader: null, at: t1 });
    const draftEmpty = await mkMsg({ companyId: COMPANY_A, threadId: th, tag: 'i07-m2', direction: 'outbound', to: [{ email: 'i07-lead@eo1.test' }], msgIdHeader: '', at: t1 });

    // (1) never surfaces pre-mig.
    let rows = await fetchPage(COMPANY_A);
    check(rows.every(r => Number(r.email_thread_id) !== Number(th)), 'draft thread yields no row pre-mig');

    // (2) mig links 0 for BOTH draft variants (verbatim listUnlinkedOutboundForTimeline discriminator).
    let counts = await runMig155();
    eq(counts.linked, 0, 'mig linked 0 (drafts excluded)');
    check((await msgState(draftNull.provider_message_id)).contact_id === null, 'NULL-header draft untouched');
    check((await msgState(draftEmpty.provider_message_id)).contact_id === null, 'empty-header draft untouched');

    // (3) still nothing.
    rows = await fetchPage(COMPANY_A);
    check(rows.every(r => Number(r.email_thread_id) !== Number(th)), 'draft thread yields no row post-mig');

    // (4) writer half: labelIds WITH 'DRAFT' → skip, row untouched.
    const res = await emailTimelineService.linkOutboundMessage(COMPANY_A, {
        provider_message_id: draftNull.provider_message_id, labelIds: ['DRAFT'], to: [{ email: 'i07-lead@eo1.test' }],
    });
    eq(res && res.skipped, 'draft', 'linkOutboundMessage skips DRAFT');
    check((await msgState(draftNull.provider_message_id)).contact_id === null, 'row untouched after DRAFT skip');

    // (5) "send later": a fresh genuinely-sent copy (header present) links and surfaces.
    const sent = await mkMsg({ companyId: COMPANY_A, threadId: th, tag: 'i07-m3', direction: 'outbound', to: [{ email: 'i07-lead@eo1.test' }], at: t1 });
    counts = await runMig155();
    eq(counts.linked, 1, 'sent copy links');
    const st = await msgState(sent.provider_message_id);
    eq(st.contact_id, c, 'sent copy stamped to C');
    rows = await fetchPage(COMPANY_A);
    const row = rows.find(r => Number(r.email_thread_id) === Number(th));
    check(!!row, 'thread now surfaces (degenerates to S1)');
});

// ---------------------------------------------------------------------------
CASE('TC-EO-I08', 's8', 'migration', 'S8 mig happy path: links + timeline CREATED for email-only contact', async () => {
    const tA = T(10), tA2 = T(25), tB = T(20);
    // (a) C_a WITH an existing timeline; match via contact_emails.email_normalized
    //     (contacts.email left NULL to force the ce-branch). Its thread already has
    //     a later unanswered inbound reply → stays inbound + unread AS-IS.
    const cA = await mkContact({ companyId: COMPANY_A, name: 'I08 Ca', email: null });
    await mkContactEmail(cA, 'i08-ca@eo1.test');
    const tlA = await mkTimeline({ companyId: COMPANY_A, contactId: cA });
    const thA = await mkThread({ companyId: COMPANY_A, tag: 'i08-ta', subject: 'EO1 I08 A', lastAt: tA2, lastDir: 'inbound', unread: 3 });
    const mA = await mkMsg({ companyId: COMPANY_A, threadId: thA, tag: 'i08-ma', direction: 'outbound', to: [{ email: 'i08-ca@eo1.test' }], at: tA });
    // (b) EMAIL-ONLY C_b, NO timeline; match via lower(contacts.email).
    const cB = await mkContact({ companyId: COMPANY_A, name: 'I08 Cb', email: 'I08-CB@eo1.test' });
    const thB = await mkThread({ companyId: COMPANY_A, tag: 'i08-tb', subject: 'EO1 I08 B', lastAt: tB, lastDir: 'outbound', unread: 0 });
    const mB = await mkMsg({ companyId: COMPANY_A, threadId: thB, tag: 'i08-mb', direction: 'outbound', to: [{ email: 'i08-cb@eo1.test' }], at: tB });

    // (1) baseline: neither surfaces.
    let rows = await fetchPage(COMPANY_A);
    check(rowsFor(rows, tlA).length === 0, 'C_a timeline not surfaced pre-mig (no signal)');
    check(rows.every(r => ![thA, thB].map(Number).includes(Number(r.email_thread_id))), 'no thread surfaces pre-mig');
    const unreadBefore = Number(await scalar(`SELECT unread_count FROM email_threads WHERE id = $1`, [thA]));

    // (2) mig.
    const counts = await runMig155();
    eq(counts.linked, 2, 'NOTICE: messages linked = 2');
    eq(counts.created, 1, 'NOTICE: timelines created = 1 (C_b)');
    eq(counts.adopted, 0, 'NOTICE: orphans adopted = 0');
    eq(counts.rehomed, 0, 'NOTICE: tasks re-homed = 0');

    const stA = await msgState(mA.provider_message_id);
    eq(stA.contact_id, cA, 'M_a → C_a');
    eq(stA.timeline_id, tlA, 'M_a reuses the EXISTING timeline');
    eq(stA.on_timeline, true, 'M_a on_timeline');
    check((await timelinesOf(cA)).length === 1, 'no second timeline for C_a');
    const stB = await msgState(mB.provider_message_id);
    eq(stB.contact_id, cB, 'M_b → C_b');
    const tlBRows = await timelinesOf(cB);
    check(tlBRows.length === 1, 'C_b has exactly one NEW timeline');
    eq(stB.timeline_id, tlBRows[0].id, 'M_b stamped with the created timeline');
    eq(Number(await scalar(`SELECT unread_count FROM email_threads WHERE id = $1`, [thA])), unreadBefore, 'unread_count byte-identical (mig never touches unread)');

    // (3) list surfaces both, ordered by the threads' last_message_at; C_a shows inbound+unread.
    rows = await fetchPage(COMPANY_A);
    const rowA = oneRowFor(rows, tlA, 'C_a');
    const rowB = oneRowFor(rows, tlBRows[0].id, 'C_b');
    eq(rowA.email_last_message_direction, 'inbound', 'C_a thread direction AS-IS (later reply)');
    eq(rowA.any_unread, true, 'C_a unread AS-IS');
    eq(rowB.email_last_message_direction, 'outbound', 'C_b outbound');
    check(rows.indexOf(rowA) < rows.indexOf(rowB) ? new Date(tA2) > new Date(tB) : new Date(tB) > new Date(tA2),
        'rows ordered by their threads last_message_at');
});

// ---------------------------------------------------------------------------
CASE('TC-EO-I09', 'mig-rerun', 'migration', 'mig 155 idempotency: second run is an all-zeros no-op', async () => {
    // Re-seed the I08 state, run once (consumes it), then prove run #2 is a no-op.
    const tA = T(10), tB = T(20);
    const cA = await mkContact({ companyId: COMPANY_A, name: 'I09 Ca' });
    await mkContactEmail(cA, 'i09-ca@eo1.test');
    await mkTimeline({ companyId: COMPANY_A, contactId: cA });
    const thA = await mkThread({ companyId: COMPANY_A, tag: 'i09-ta', subject: 'EO1 I09 A', lastAt: tA, lastDir: 'outbound', unread: 0 });
    await mkMsg({ companyId: COMPANY_A, threadId: thA, tag: 'i09-ma', direction: 'outbound', to: [{ email: 'i09-ca@eo1.test' }], at: tA });
    const cB = await mkContact({ companyId: COMPANY_A, name: 'I09 Cb', email: 'i09-cb@eo1.test' });
    const thB = await mkThread({ companyId: COMPANY_A, tag: 'i09-tb', subject: 'EO1 I09 B', lastAt: tB, lastDir: 'outbound', unread: 0 });
    await mkMsg({ companyId: COMPANY_A, threadId: thB, tag: 'i09-mb', direction: 'outbound', to: [{ email: 'i09-cb@eo1.test' }], at: tB });

    const first = await runMig155();
    eq(first.linked, 2, 'first run links the seeds');

    const before = await companyHashes(COMPANY_A);
    const listBefore = JSON.stringify(await fetchPage(COMPANY_A));

    const second = await runMig155();
    eq(second.candidates, 0, 'rerun: candidates 0');
    eq(second.linked, 0, 'rerun: linked 0');
    eq(second.adopted, 0, 'rerun: adopted 0');
    eq(second.created, 0, 'rerun: created 0');
    eq(second.rehomed, 0, 'rerun: re-homed 0');

    const after = await companyHashes(COMPANY_A);
    eq(after.emails, before.emails, 'email_messages snapshot byte-identical');
    eq(after.timelines, before.timelines, 'timelines snapshot byte-identical (no updated_at bumps)');
    eq(after.tasks, before.tasks, 'tasks snapshot byte-identical');
    eq(JSON.stringify(await fetchPage(COMPANY_A)), listBefore, 'list output identical');
});

// ---------------------------------------------------------------------------
CASE('TC-EO-I10', 'mig-to-only', 'migration', 'mig 155 matches TO only; CC never; normalization applied', async () => {
    const t1 = T(10);
    const c = await mkContact({ companyId: COMPANY_A, name: 'I10 Lead' });
    await mkContactEmail(c, 'i10-lead@eo1.test');
    const th = await mkThread({ companyId: COMPANY_A, tag: 'i10-t1', subject: 'EO1 I10', lastAt: t1, lastDir: 'outbound', unread: 0 });
    // (a) contact address ONLY in CC → must NOT link.
    const ccOnly = await mkMsg({
        companyId: COMPANY_A, threadId: th, tag: 'i10-m1', direction: 'outbound',
        to: [{ email: 'nomatch@eo1-nowhere.test' }], cc: [{ email: 'i10-lead@eo1.test' }], at: t1,
    });
    // (b) BCC variant: email_messages stores NO bcc column (079 schema), so a
    //     BCC-only send stores the address in NO recipient field → same negative.
    const bccVariant = await mkMsg({
        companyId: COMPANY_A, threadId: th, tag: 'i10-m2', direction: 'outbound',
        to: [{ email: 'nomatch2@eo1-nowhere.test' }], cc: [], at: t1,
    });
    // (c) normalization: mixed case + padding in the TO entry DOES link.
    const norm = await mkMsg({
        companyId: COMPANY_A, threadId: th, tag: 'i10-m3', direction: 'outbound',
        to: [{ email: ' I10-LEAD@Eo1.TEST ' }], at: t1,
    });
    // (d) NULL/empty email keys skipped without error; the later valid entry links.
    const nullish = await mkMsg({
        companyId: COMPANY_A, threadId: th, tag: 'i10-m4', direction: 'outbound',
        to: [{ email: null }, { email: '' }, { name: 'no-email-key' }, { email: 'i10-lead@eo1.test' }], at: t1,
    });

    const counts = await runMig155();
    eq(counts.linked, 2, 'linked-count excludes CC-only and BCC-variant');
    const stCc = await msgState(ccOnly.provider_message_id);
    check(stCc.contact_id === null && stCc.on_timeline === false, 'CC-only match did NOT link');
    const stBcc = await msgState(bccVariant.provider_message_id);
    check(stBcc.contact_id === null && stBcc.on_timeline === false, 'BCC variant did NOT link');
    eq((await msgState(norm.provider_message_id)).contact_id, c, 'lower/trim normalization links');
    eq((await msgState(nullish.provider_message_id)).contact_id, c, 'NULL/empty TO entries skipped, valid one links');
});

// ---------------------------------------------------------------------------
CASE('TC-EO-I11', 'mig-recipient-pick', 'migration', 'mig 155: first matching TO wins; findEmailContact tie-break parity', async () => {
    const t1 = T(10);
    // (a) ordinality decides: TO=[X, Y] → links X.
    const cX = await mkContact({ companyId: COMPANY_A, name: 'I11 X' });
    await mkContactEmail(cX, 'i11-x@eo1.test');
    const cY = await mkContact({ companyId: COMPANY_A, name: 'I11 Y' });
    await mkContactEmail(cY, 'i11-y@eo1.test');
    const th = await mkThread({ companyId: COMPANY_A, tag: 'i11-t1', subject: 'EO1 I11', lastAt: t1, lastDir: 'outbound', unread: 0 });
    const mXY = await mkMsg({ companyId: COMPANY_A, threadId: th, tag: 'i11-m1', direction: 'outbound', to: [{ email: 'i11-x@eo1.test' }, { email: 'i11-y@eo1.test' }], at: t1 });
    let counts = await runMig155();
    eq((await msgState(mXY.provider_message_id)).contact_id, cX, '(a) TO=[X,Y] links X (ordinality, not id order)');

    // (a2) swapped array order after cleanup of the message → links Y.
    await db.query(`DELETE FROM email_messages WHERE provider_message_id = $1`, [mXY.provider_message_id]);
    const mYX = await mkMsg({ companyId: COMPANY_A, threadId: th, tag: 'i11-m2', direction: 'outbound', to: [{ email: 'i11-y@eo1.test' }, { email: 'i11-x@eo1.test' }], at: t1 });
    counts = await runMig155();
    eq((await msgState(mYX.provider_message_id)).contact_id, cY, '(a2) swapped TO=[Y,X] links Y');

    // (b) one address on TWO contacts → newest updated_at wins (findEmailContact parity).
    const cOld = await mkContact({ companyId: COMPANY_A, name: 'I11 Old', updatedAt: T(1) });
    await mkContactEmail(cOld, 'i11-dup@eo1.test');
    const cNew = await mkContact({ companyId: COMPANY_A, name: 'I11 New', updatedAt: T(9) });
    await mkContactEmail(cNew, 'i11-dup@eo1.test');
    const mDup = await mkMsg({ companyId: COMPANY_A, threadId: th, tag: 'i11-m3', direction: 'outbound', to: [{ email: 'i11-dup@eo1.test' }], at: t1 });
    counts = await runMig155();
    const stDup = await msgState(mDup.provider_message_id);
    eq(stDup.contact_id, cNew, '(b) newest updated_at wins');
    check(stDup.timeline_id != null && stDup.on_timeline === true, '(b) exactly one link, never two');

    // (b2) equal updated_at → lowest id wins.
    const sameTs = T(9);
    const cLo = await mkContact({ companyId: COMPANY_A, name: 'I11 Lo', updatedAt: sameTs });
    await mkContactEmail(cLo, 'i11-dup2@eo1.test');
    const cHi = await mkContact({ companyId: COMPANY_A, name: 'I11 Hi', updatedAt: sameTs });
    await mkContactEmail(cHi, 'i11-dup2@eo1.test');
    const mDup2 = await mkMsg({ companyId: COMPANY_A, threadId: th, tag: 'i11-m4', direction: 'outbound', to: [{ email: 'i11-dup2@eo1.test' }], at: t1 });
    counts = await runMig155();
    eq((await msgState(mDup2.provider_message_id)).contact_id, cLo, '(b2) updated_at tie → lowest id');
});

// ---------------------------------------------------------------------------
CASE('TC-EO-I12', 'mig-adopt', 'migration', 'mig 155: orphan ADOPTION (not fork) + calls re-point + task reachable', async () => {
    const t1 = T(10), tCall = T(2);
    const phone = nextPhone();
    const cO = await mkContact({ companyId: COMPANY_A, name: 'I12 Co', phone });
    await mkContactEmail(cO, 'i12-co@eo1.test');
    // Orphan timeline on the same digits, carrying a call and an OPEN task.
    const orphan = await mkTimeline({ companyId: COMPANY_A, phone });
    const call = await mkCall({ companyId: COMPANY_A, timelineId: orphan, startedAt: tCall });
    await mkTask({ companyId: COMPANY_A, threadId: orphan, title: 'I12 follow up' });
    const th = await mkThread({ companyId: COMPANY_A, tag: 'i12-t1', subject: 'EO1 I12', lastAt: t1, lastDir: 'outbound', unread: 0 });
    const m = await mkMsg({ companyId: COMPANY_A, threadId: th, tag: 'i12-m1', direction: 'outbound', to: [{ email: 'i12-co@eo1.test' }], at: t1 });

    const tlCountBefore = Number(await scalar(`SELECT count(*) FROM timelines`));
    const orphanBefore = (await db.query(`SELECT updated_at::text AS u FROM timelines WHERE id = $1`, [orphan])).rows[0].u;

    const counts = await runMig155();
    eq(counts.adopted, 1, 'NOTICE: orphans adopted = 1');
    eq(counts.created, 0, 'NOTICE: timelines created = 0');
    eq(counts.linked, 1, 'NOTICE: linked = 1');
    eq(counts.repointed, 1, 'NOTICE: calls re-pointed = 1');

    eq(Number(await scalar(`SELECT count(*) FROM timelines`)), tlCountBefore, 'NO new timeline row (no fork)');
    const o = (await db.query(`SELECT contact_id, phone_e164, updated_at::text AS u FROM timelines WHERE id = $1`, [orphan])).rows[0];
    eq(o.contact_id, cO, 'orphan adopted: contact_id set');
    check(o.phone_e164 === null, 'orphan adopted: phone_e164 cleared');
    check(o.u !== orphanBefore, 'orphan adopted: updated_at bumped');
    eq(await scalar(`SELECT contact_id FROM calls WHERE id = $1`, [call.id]), cO, 'call re-pointed to C_o');
    eq((await msgState(m.provider_message_id)).timeline_id, orphan, 'message stamped onto the ADOPTED timeline');

    const rows = await fetchPage(COMPANY_A);
    const row = oneRowFor(rows, orphan, 'C_o');
    check(row.call_sid === call.call_sid, 'row carries the call history');
    eq(row.email_thread_id, th, 'row carries the email signal');
    check(row.open_task_id != null, 'open task still reachable (AR pin)');
    check(tierOf({ has_open_task: !!row.open_task_id, snoozed_until: row.snoozed_until, has_unread: row.any_unread }) === 0, 'row pinned in the AR band');
});

// ---------------------------------------------------------------------------
CASE('TC-EO-I13', 'mig-orphan-contention', 'migration', 'mig 155: two matched contacts share one orphan (deterministic split)', async () => {
    const t1 = T(10);
    async function seed(tagSuffix) {
        const phone = nextPhone();
        const c1 = await mkContact({ companyId: COMPANY_A, name: `I13 C1${tagSuffix}`, phone });
        await mkContactEmail(c1, `i13-c1${tagSuffix}@eo1.test`);
        const c2 = await mkContact({ companyId: COMPANY_A, name: `I13 C2${tagSuffix}`, phone });
        await mkContactEmail(c2, `i13-c2${tagSuffix}@eo1.test`);
        const orphan = await mkTimeline({ companyId: COMPANY_A, phone });
        const th = await mkThread({ companyId: COMPANY_A, tag: `i13-t1${tagSuffix}`, subject: 'EO1 I13', lastAt: t1, lastDir: 'outbound', unread: 0 });
        const m1 = await mkMsg({ companyId: COMPANY_A, threadId: th, tag: `i13-m1${tagSuffix}`, direction: 'outbound', to: [{ email: `i13-c1${tagSuffix}@eo1.test` }], at: t1 });
        const m2 = await mkMsg({ companyId: COMPANY_A, threadId: th, tag: `i13-m2${tagSuffix}`, direction: 'outbound', to: [{ email: `i13-c2${tagSuffix}@eo1.test` }], at: t1 });
        return { c1, c2, orphan, m1, m2 };
    }

    const s = await seed('a');
    const counts = await runMig155();
    eq(counts.adopted, 1, 'exactly ONE adoption');
    eq(counts.created, 1, 'the loser falls through to CREATE');
    eq(counts.linked, 2, 'both messages linked');

    // Deterministic winner per the stable ORDER BY (pick_per_orphan: contact_id ASC).
    const winner = Math.min(Number(s.c1), Number(s.c2));
    const loser = Math.max(Number(s.c1), Number(s.c2));
    eq(await scalar(`SELECT contact_id FROM timelines WHERE id = $1`, [s.orphan]), winner, 'orphan won by the deterministic contact');
    check((await timelinesOf(winner)).length === 1, 'winner has ONE timeline');
    const loserTls = await timelinesOf(loser);
    check(loserTls.length === 1 && Number(loserTls[0].id) !== Number(s.orphan), 'loser got ONE fresh timeline');
    check((await msgState(s.m1.provider_message_id)).contact_id != null, 'm1 linked');
    check((await msgState(s.m2.provider_message_id)).contact_id != null, 'm2 linked');

    // Second run = all zeros.
    const rerun = await runMig155();
    check(rerun.linked === 0 && rerun.adopted === 0 && rerun.created === 0 && rerun.rehomed === 0, 'second run all zeros');

    // Fresh re-seed → same deterministic rule (winner = lower contact id again).
    await cleanupAll();
    const s2 = await seed('b');
    await runMig155();
    eq(await scalar(`SELECT contact_id FROM timelines WHERE id = $1`, [s2.orphan]),
        Math.min(Number(s2.c1), Number(s2.c2)), 'fresh re-seed picks the same deterministic winner');
});

// ---------------------------------------------------------------------------
CASE('TC-EO-I14', 'mig-arbiter', 'migration', 'mig 155 create-path arbiter verbatim + untouched rows never bumped', async () => {
    // Static half.
    const migText = fs.readFileSync(MIG_PATH, 'utf8');
    check(migText.includes('ON CONFLICT (contact_id) WHERE contact_id IS NOT NULL DO NOTHING'),
        'arbiter verbatim: ON CONFLICT (contact_id) WHERE contact_id IS NOT NULL DO NOTHING');
    check(!/DO UPDATE SET\s+updated_at/i.test(migText), 'no DO UPDATE SET updated_at in the create step');

    // Behavioral half: existing timeline is reused and its updated_at is UNCHANGED.
    const t1 = T(10);
    const c = await mkContact({ companyId: COMPANY_A, name: 'I14 Lead' });
    await mkContactEmail(c, 'i14-lead@eo1.test');
    const tl = await mkTimeline({ companyId: COMPANY_A, contactId: c });
    const before = (await db.query(`SELECT updated_at::text AS u FROM timelines WHERE id = $1`, [tl])).rows[0].u;
    const th = await mkThread({ companyId: COMPANY_A, tag: 'i14-t1', subject: 'EO1 I14', lastAt: t1, lastDir: 'outbound', unread: 0 });
    const m = await mkMsg({ companyId: COMPANY_A, threadId: th, tag: 'i14-m1', direction: 'outbound', to: [{ email: 'i14-lead@eo1.test' }], at: t1 });

    await runMig155();
    eq((await msgState(m.provider_message_id)).timeline_id, tl, 'message linked to the EXISTING timeline (re-select found it)');
    const after = (await db.query(`SELECT updated_at::text AS u FROM timelines WHERE id = $1`, [tl])).rows[0].u;
    eq(after, before, 'existing timeline updated_at UNCHANGED');
});

// ---------------------------------------------------------------------------
CASE('TC-EO-I15', 'mig-empty', 'migration', 'mig 155 empty-data run is a clean no-op; rollback documented one-way', async () => {
    // Variant 1: zero candidate rows (fixtures cleaned; startup drained pre-existing ones).
    const globalCandidates = Number(await scalar(
        `SELECT count(*) FROM email_messages
         WHERE direction = 'outbound' AND contact_id IS NULL AND on_timeline = false
           AND message_id_header IS NOT NULL AND message_id_header <> ''`));
    eq(globalCandidates, 0, 'precondition: zero candidate rows DB-wide');
    const before = await companyHashes(COMPANY_A);
    const counts = await runMig155();
    check(counts.candidates === 0 && counts.linked === 0 && counts.adopted === 0
        && counts.created === 0 && counts.rehomed === 0, `all NOTICE counts 0, got ${JSON.stringify(counts)}`);
    const after = await companyHashes(COMPANY_A);
    check(after.emails === before.emails && after.timelines === before.timelines && after.tasks === before.tasks,
        'no rows written');

    // Variant 2: ZERO email_messages at all — transactional sandbox (DELETE + mig + ROLLBACK),
    // the shared dev DB itself is never mutated.
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM email_messages');
        const c2 = await runMig155({ client });
        check(c2.candidates === 0 && c2.linked === 0 && c2.adopted === 0 && c2.created === 0,
            'zero-email_messages variant: all zeros, no error');
        await client.query('ROLLBACK');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }

    // Rollback file: exists, runs without error, one-way posture, never NULLs links.
    check(fs.existsSync(ROLLBACK_PATH), 'rollback_155 file exists');
    const rb = fs.readFileSync(ROLLBACK_PATH, 'utf8');
    check(!/UPDATE\s+email_messages/i.test(rb), 'rollback does NOT attempt UPDATE email_messages');
    check(/point-in-time|PITR/i.test(rb), 'rollback documents the one-way (PITR) posture');
    await db.query(rb); // must run clean
});

// ---------------------------------------------------------------------------
CASE('TC-EO-I16', 'edge-contact-delete', 'cte', 'edge 5: contact deleted → FK SET NULL → message leaves leg 2', async () => {
    const t1 = T(10);
    const c = await mkContact({ companyId: COMPANY_A, name: 'I16 Lead' });
    await mkContactEmail(c, 'i16-lead@eo1.test');
    // Timeline keeps a phone so the FK SET NULL on contact delete cannot violate
    // chk_timelines_identity (contact-only timelines block bare contact deletes).
    const tl = await mkTimeline({ companyId: COMPANY_A, contactId: c, phone: nextPhone() });
    const th = await mkThread({ companyId: COMPANY_A, tag: 'i16-t1', subject: 'EO1 I16', lastAt: t1, lastDir: 'outbound', unread: 0 });
    const m = await mkMsg({ companyId: COMPANY_A, threadId: th, tag: 'i16-m1', direction: 'outbound', to: [{ email: 'i16-lead@eo1.test' }], contactId: c, timelineId: tl, onTimeline: true, at: t1 });

    // sanity: it surfaces first
    let rows = await fetchPage(COMPANY_A);
    oneRowFor(rows, tl, 'pre-delete');

    await db.query(`DELETE FROM contacts WHERE id = $1`, [c]);
    const st = await msgState(m.provider_message_id);
    check(st.contact_id === null, 'email_messages.contact_id is NULL (FK ON DELETE SET NULL)');

    rows = await fetchPage(COMPANY_A); // must not error
    check(rows.every(r => Number(r.email_thread_id) !== Number(th)), 'no list row carries the dangling email attribution');
});

// ---------------------------------------------------------------------------
CASE('TC-EO-I17', 'edge-null-ts', 'cte', 'edge 2: NULL last_message_at — NULLS LAST in CTE, GREATEST outside', async () => {
    const t1 = T(10);
    const c = await mkContact({ companyId: COMPANY_A, name: 'I17 Lead' });
    await mkContactEmail(c, 'i17-lead@eo1.test');
    const tl = await mkTimeline({ companyId: COMPANY_A, contactId: c });
    const thNull = await mkThread({ companyId: COMPANY_A, tag: 'i17-tnull', subject: 'EO1 I17 null', lastAt: null, lastDir: 'outbound', unread: 0 });
    await mkMsg({ companyId: COMPANY_A, threadId: thNull, tag: 'i17-m1', direction: 'outbound', to: [{ email: 'i17-lead@eo1.test' }], contactId: c, timelineId: tl, onTimeline: true, at: null });
    const thTs = await mkThread({ companyId: COMPANY_A, tag: 'i17-tts', subject: 'EO1 I17 ts', lastAt: t1, lastDir: 'outbound', unread: 0 });
    await mkMsg({ companyId: COMPANY_A, threadId: thTs, tag: 'i17-m2', direction: 'outbound', to: [{ email: 'i17-lead@eo1.test' }], contactId: c, timelineId: tl, onTimeline: true, at: t1 });

    const cNull = await mkContact({ companyId: COMPANY_A, name: 'I17 OnlyNull' });
    await mkContactEmail(cNull, 'i17-onlynull@eo1.test');
    const tlNull = await mkTimeline({ companyId: COMPANY_A, contactId: cNull });
    const thOnly = await mkThread({ companyId: COMPANY_A, tag: 'i17-tonly', subject: 'EO1 I17 only-null', lastAt: null, lastDir: 'outbound', unread: 0 });
    await mkMsg({ companyId: COMPANY_A, threadId: thOnly, tag: 'i17-m3', direction: 'outbound', to: [{ email: 'i17-onlynull@eo1.test' }], contactId: cNull, timelineId: tlNull, onTimeline: true, at: null });

    const rows = await fetchPage(COMPANY_A);
    const rowC = oneRowFor(rows, tl, 'C');
    eq(rowC.email_thread_id, thTs, 'C picks the TIMESTAMPED thread (NULLS LAST demotes T_null)');
    const rowN = oneRowFor(rows, tlNull, 'C_onlynull');
    check(rowN.email_last_message_at === null, 'C_onlynull surfaces with NULL email_last_message_at');
    eq(rowN.email_thread_id, thOnly, 'C_onlynull carries its thread id');
    check(rowN.last_interaction_at === null, 'GREATEST of all-NULL channels → NULL');
    // Sorts LAST within its tier: no tier-2 row AFTER it has a non-null recency.
    const tail = rows.slice(rows.indexOf(rowN) + 1).filter(r => tierOf(r) === 2);
    check(tail.every(r => r.last_interaction_at === null), 'row sorts last within tier 2 (only NULL-recency rows after it)');
});

// ---------------------------------------------------------------------------
CASE('TC-EO-I18', 'edge-fanout', 'cte', 'edges 3+4: multi-address contact + fan-out collapse to ONE row', async () => {
    const t1 = T(10), t2 = T(20);
    const c = await mkContact({ companyId: COMPANY_A, name: 'I18 Lead' });
    for (const a of ['i18-a@eo1.test', 'i18-b@eo1.test', 'i18-c@eo1.test']) await mkContactEmail(c, a);
    const tl = await mkTimeline({ companyId: COMPANY_A, contactId: c });
    // ONE thread with 5 linked outbound + 2 inbound from two different addresses.
    const th1 = await mkThread({ companyId: COMPANY_A, tag: 'i18-t1', subject: 'EO1 I18 fanout', lastAt: t1, lastDir: 'inbound', unread: 0 });
    for (let i = 0; i < 5; i++) {
        await mkMsg({ companyId: COMPANY_A, threadId: th1, tag: `i18-o${i}`, direction: 'outbound', to: [{ email: 'i18-a@eo1.test' }], contactId: c, timelineId: tl, onTimeline: true, at: t1 });
    }
    await mkMsg({ companyId: COMPANY_A, threadId: th1, tag: 'i18-i1', direction: 'inbound', fromEmail: 'i18-a@eo1.test', at: t1 });
    await mkMsg({ companyId: COMPANY_A, threadId: th1, tag: 'i18-i2', direction: 'inbound', fromEmail: 'i18-b@eo1.test', at: t1 });
    // Second, NEWER thread proves newest-wins under fan-out.
    const th2 = await mkThread({ companyId: COMPANY_A, tag: 'i18-t2', subject: 'EO1 I18 newer', lastAt: t2, lastDir: 'outbound', unread: 0 });
    await mkMsg({ companyId: COMPANY_A, threadId: th2, tag: 'i18-o5', direction: 'outbound', to: [{ email: 'i18-b@eo1.test' }], contactId: c, timelineId: tl, onTimeline: true, at: t2 });

    const rows = await fetchPage(COMPANY_A);
    const row = oneRowFor(rows, tl, 'fan-out collapse');
    eq(row.email_thread_id, th2, 'newest thread wins under fan-out');
    check(Number(row.total_count) === rows.length, 'total_count counts C once (window count = surfaced set)');

    // Pagination probe: C appears exactly once across sequential pages; no phantom dup.
    const limit = 200;
    let seen = 0;
    for (let offset = 0; ; offset += limit) {
        const page = await fetchPage(COMPANY_A, { limit, offset });
        seen += rowsFor(page, tl).length;
        if (page.length < limit) break;
    }
    eq(seen, 1, 'C appears exactly once across ALL pages (no phantom row on later offsets)');
});

// ---------------------------------------------------------------------------
CASE('TC-EO-I19', 'search', 'route', 'edge 7 / FR-6: search hits an outbound-first subject; alias regression dead', async () => {
    const t1 = T(10);
    const c = await mkContact({ companyId: COMPANY_A, name: 'I19 Cust' });
    await mkContactEmail(c, 'i19-cust@eo1.test');
    const tl = await mkTimeline({ companyId: COMPANY_A, contactId: c });
    // Search terms carry NO digits (a digit would arm the phone-LIKE branch and
    // match unrelated dev rows).
    const th = await mkThread({ companyId: COMPANY_A, tag: 'i19-t1', subject: 'EO1 Graniteeoq countertop quote', lastAt: t1, lastDir: 'outbound', unread: 0 });
    await mkMsg({ companyId: COMPANY_A, threadId: th, tag: 'i19-m1', direction: 'outbound', to: [{ email: 'i19-cust@eo1.test' }], contactId: c, timelineId: tl, onTimeline: true, at: t1 });

    // (1) outbound-first subject found, case-insensitive; exactly this row.
    const rows = await fetchPage(COMPANY_A, { search: 'graniteeoq' });
    eq(rows.length, 1, 'search returns exactly the seeded row');
    eq(Number(rows[0].timeline_id ?? rows[0].tl_id), Number(tl), 'the row is C');
    eq(Number(rows[0].total_count), 1, 'total_count = 1');
    const body = await routeList(COMPANY_A, { search: 'GRANITEEOQ' });
    eq(body.total, 1, 'route search case-insensitive, total 1');
    eq(Number(body.conversations[0].timeline_id), Number(tl), 'route row is C');

    // (2) no-match search → HTTP 200, empty, total 0 (d56db8f alias regression stays dead).
    const none = await routeList(COMPANY_A, { search: 'zzz-eo-no-match-q' });
    eq(none.total, 0, 'no-match total 0');
    eq(none.conversations.length, 0, 'no-match page empty');

    // (3) inbound-first regression: term matching only ANOTHER contact's inbound thread.
    const d = await mkContact({ companyId: COMPANY_A, name: 'I19 Dee' });
    await mkContactEmail(d, 'i19-dee@eo1.test');
    const tlD = await mkTimeline({ companyId: COMPANY_A, contactId: d });
    const thD = await mkThread({ companyId: COMPANY_A, tag: 'i19-t2', subject: 'EO1 Sapphireeoq widget', lastAt: t1, lastDir: 'inbound', unread: 0 });
    await mkMsg({ companyId: COMPANY_A, threadId: thD, tag: 'i19-m2', direction: 'inbound', fromEmail: 'i19-dee@eo1.test', at: t1 });
    const inb = await routeList(COMPANY_A, { search: 'sapphireeoq' });
    eq(inb.total, 1, 'inbound-subject search unchanged');
    eq(Number(inb.conversations[0].timeline_id), Number(tlD), 'inbound search returns D');
});

// ---------------------------------------------------------------------------
CASE('TC-EO-I20', 'edge-no-email', 'cte', 'edge 1: company with no email at all (isolated company A2)', async () => {
    await ensureCompany(COMPANY_A2, 'eo1-a2', 'EO1 NoEmail Co');
    const tl = await mkTimeline({ companyId: COMPANY_A2, phone: nextPhone() });
    await mkCall({ companyId: COMPANY_A2, timelineId: tl, startedAt: T(10) });
    eq(Number(await scalar(`SELECT count(*) FROM email_messages WHERE company_id = $1`, [COMPANY_A2])), 0, 'A2 has zero email_messages');

    const rows = await fetchPage(COMPANY_A2);
    eq(rows.length, 1, 'exactly the call row surfaces');
    const row = rows[0];
    check(row.email_thread_id === null, 'email fields NULL via LEFT JOIN');
    check(row.email_subject === null && row.email_last_message_at === null, 'no email attribution');
    eq(Number(row.total_count), 1, 'total = 1');
    const body = await routeList(COMPANY_A2);
    eq(body.total, 1, 'route total 1');
    eq(body.conversations[0].last_interaction_type, 'call', 'call row normal');
});

// ---------------------------------------------------------------------------
CASE('TC-EO-I21', 'pagination', 'cte', 'edge 9: pagination invariants + AR pinning unaffected by email direction', async () => {
    // ~12 surfaced fixtures in company A, every one findable via the digit-less
    // term 'eopage' (call_sid / sms friendly_name / email subject / contact name),
    // so the search variant sees EXACTLY this set and page math is exact.
    const mk = [];
    // 3 call-only
    for (let i = 0; i < 3; i++) {
        const tl = await mkTimeline({ companyId: COMPANY_A, phone: nextPhone() });
        await mkCall({ companyId: COMPANY_A, timelineId: tl, startedAt: T(2 + i), sid: `EOPAGE-call-${i}` });
        mk.push(tl);
    }
    // 2 SMS (contact-linked so the lateral matches on digits)
    for (let i = 0; i < 2; i++) {
        const phone = nextPhone();
        const c = await mkContact({ companyId: COMPANY_A, name: `I21 eopage sms${i}`, phone });
        const tl = await mkTimeline({ companyId: COMPANY_A, contactId: c });
        await mkSms({ companyId: COMPANY_A, customerE164: phone, lastAt: T(6 + i), friendly: `eopage sms ${i}` });
        mk.push(tl);
    }
    // 2 inbound-email
    for (let i = 0; i < 2; i++) {
        const c = await mkContact({ companyId: COMPANY_A, name: `I21 eml${i}` });
        await mkContactEmail(c, `i21-in${i}@eo1.test`);
        const tl = await mkTimeline({ companyId: COMPANY_A, contactId: c });
        const th = await mkThread({ companyId: COMPANY_A, tag: `i21-tin${i}`, subject: `EO1 eopage inbound ${i}`, lastAt: T(10 + i), lastDir: 'inbound', unread: 0 });
        await mkMsg({ companyId: COMPANY_A, threadId: th, tag: `i21-min${i}`, direction: 'inbound', fromEmail: `i21-in${i}@eo1.test`, at: T(10 + i) });
        mk.push(tl);
    }
    // 3 outbound-email-only (distinct times → recency order assertable)
    const outbound = [];
    for (let i = 0; i < 3; i++) {
        const c = await mkContact({ companyId: COMPANY_A, name: `I21 out${i}` });
        await mkContactEmail(c, `i21-out${i}@eo1.test`);
        const tl = await mkTimeline({ companyId: COMPANY_A, contactId: c });
        const th = await mkThread({ companyId: COMPANY_A, tag: `i21-tout${i}`, subject: `EO1 eopage outbound ${i}`, lastAt: T(20 + i * 2), lastDir: 'outbound', unread: 0 });
        await mkMsg({ companyId: COMPANY_A, threadId: th, tag: `i21-mout${i}`, direction: 'outbound', to: [{ email: `i21-out${i}@eo1.test` }], contactId: c, timelineId: tl, onTimeline: true, at: T(20 + i * 2) });
        outbound.push({ tl, at: T(20 + i * 2) });
        mk.push(tl);
    }
    // 1 open-task AR row (task-only timeline; name carries the term)
    const cAr = await mkContact({ companyId: COMPANY_A, name: 'I21 eopage task person' });
    const tlAr = await mkTimeline({ companyId: COMPANY_A, contactId: cAr });
    await mkTask({ companyId: COMPANY_A, threadId: tlAr, title: 'I21 call them back' });
    mk.push(tlAr);
    // 1 shadow-orphan pair: orphan on the contact's SECONDARY phone must be dropped.
    const priPhone = nextPhone(), secPhone = nextPhone();
    const cK = await mkContact({ companyId: COMPANY_A, name: 'I21 eopage kay', phone: priPhone, secondary: secPhone });
    const tlK = await mkTimeline({ companyId: COMPANY_A, contactId: cK });
    await mkCall({ companyId: COMPANY_A, timelineId: tlK, contactId: cK, startedAt: T(8), sid: 'EOPAGE-kay-canon' });
    const tlShadow = await mkTimeline({ companyId: COMPANY_A, phone: secPhone });
    await mkCall({ companyId: COMPANY_A, timelineId: tlShadow, startedAt: T(9), sid: 'EOPAGE-kay-shadow' });
    mk.push(tlK); // 12 surfaced fixtures; tlShadow must NOT surface

    // Plain pages (dev rows interleave; invariants still hold globally).
    const pages = [];
    for (const offset of [0, 5, 10]) {
        const page = await fetchPage(COMPANY_A, { limit: 5, offset });
        check(page.length === 5, `plain page offset=${offset} is exactly limit-sized (never shrunk post-query)`);
        pages.push(page);
    }
    const totals = pages.map(p => Number(p[0].total_count));
    check(totals.every(t => t === totals[0]), `total_count identical on every plain page (${totals})`);
    const ids = pages.flat().map(r => Number(r.timeline_id ?? r.tl_id));
    check(new Set(ids).size === ids.length, 'plain pages pairwise disjoint by timeline_id');

    // Full fetch: shadow-orphan dedup decided in SQL before LIMIT → absent everywhere.
    const all = await fetchPage(COMPANY_A);
    check(rowsFor(all, tlShadow).length === 0, 'shadow orphan absent from the surfaced set');
    oneRowFor(all, tlK, 'canonical contact row');
    eq(Number(all[0].total_count), all.length, 'window total equals the full surfaced count');

    // AR pinning: the open-task row sits in tier 0, ABOVE the (newer) outbound-email rows.
    const arRow = oneRowFor(all, tlAr, 'AR row');
    check(tierOf(arRow) === 0, 'open-task row is tier 0');
    for (const o of outbound) {
        const oRow = oneRowFor(all, o.tl, 'outbound row');
        check(tierOf(oRow) === 2, 'outbound-email-only row is tier 2 (direction never promotes into AR)');
        check(all.indexOf(arRow) < all.indexOf(oRow), 'AR row pinned above newer outbound-email rows');
    }
    // Outbound rows order among tier 2 by GREATEST recency (newest first).
    const idx = (tl) => all.findIndex(r => Number(r.timeline_id ?? r.tl_id) === Number(tl));
    check(idx(outbound[2].tl) < idx(outbound[1].tl) && idx(outbound[1].tl) < idx(outbound[0].tl),
        'outbound rows ordered by recency within tier 2');

    // Search variant: 'eopage' scopes to EXACTLY the 12 fixtures → exact page math.
    const sPages = [];
    for (const offset of [0, 5, 10]) sPages.push(await fetchPage(COMPANY_A, { limit: 5, offset, search: 'eopage' }));
    eq(sPages[0].length, 5, 'search page 1 full');
    eq(sPages[1].length, 5, 'search page 2 full');
    eq(sPages[2].length, 2, 'search page 3 = the true tail (2 rows)');
    const sTotals = sPages.filter(p => p.length).map(p => Number(p[0].total_count));
    check(sTotals.every(t => t === 12), `search total_count = 12 on every page (${sTotals})`);
    const sIds = sPages.flat().map(r => Number(r.timeline_id ?? r.tl_id));
    check(new Set(sIds).size === sIds.length, 'search pages pairwise disjoint');
    check(!sIds.includes(Number(tlShadow)), 'shadow orphan absent from ALL search pages');
    check(sIds.sort((a, b) => a - b).join(',') === mk.map(Number).sort((a, b) => a - b).join(','),
        'search pages = exactly the 12 seeded surfaced timelines');
    eq(Number(sPages[0][0].timeline_id ?? sPages[0][0].tl_id), Number(tlAr), 'AR row pinned first in the search set too');
});

// ---------------------------------------------------------------------------
CASE('TC-EO-I22', 'edge-orphan', 'cte', 'edge 6: orphan (contactless) timelines never gain email signal', async () => {
    const t1 = T(10);
    const orphan = await mkTimeline({ companyId: COMPANY_A, phone: nextPhone() });
    await mkCall({ companyId: COMPANY_A, timelineId: orphan, startedAt: t1 });
    // Unrelated contact with a linked outbound email.
    const z = await mkContact({ companyId: COMPANY_A, name: 'I22 Zed' });
    await mkContactEmail(z, 'i22-zed@eo1.test');
    const tlZ = await mkTimeline({ companyId: COMPANY_A, contactId: z });
    const th = await mkThread({ companyId: COMPANY_A, tag: 'i22-t1', subject: 'EO1 I22', lastAt: t1, lastDir: 'outbound', unread: 0 });
    await mkMsg({ companyId: COMPANY_A, threadId: th, tag: 'i22-m1', direction: 'outbound', to: [{ email: 'i22-zed@eo1.test' }], contactId: z, timelineId: tlZ, onTimeline: true, at: t1 });

    const rows = await fetchPage(COMPANY_A);
    const oRow = oneRowFor(rows, orphan, 'orphan');
    check(oRow.email_thread_id === null && oRow.email_subject === null
        && oRow.email_last_message_at === null && oRow.email_last_message_direction === null,
        'orphan row has ALL email fields NULL (NULL = NULL never matches)');
    const zRow = oneRowFor(rows, tlZ, 'contact');
    eq(zRow.email_thread_id, th, 'the email belongs only to its contact timeline');
});

// ---------------------------------------------------------------------------
CASE('TC-EO-SEC01', 'sec-cross-tenant', 'route', 'cross-tenant list isolation: same address in two companies', async () => {
    await ensureCompany(COMPANY_B, 'eo1-sec-b', 'EO1 Sec Co B');
    const t1 = T(10), t2 = T(20);
    // Company A: contact with BOTH thread shapes on the shared address.
    const cA = await mkContact({ companyId: COMPANY_A, name: 'SEC01 A' });
    await mkContactEmail(cA, 'shared@eo1.test');
    const tlA = await mkTimeline({ companyId: COMPANY_A, contactId: cA });
    const thOut = await mkThread({ companyId: COMPANY_A, tag: 'sec01-tout', subject: 'EO1 Sharedleakq outbound', lastAt: t2, lastDir: 'outbound', unread: 0 });
    await mkMsg({ companyId: COMPANY_A, threadId: thOut, tag: 'sec01-mout', direction: 'outbound', to: [{ email: 'shared@eo1.test' }], contactId: cA, timelineId: tlA, onTimeline: true, at: t2 });
    const thIn = await mkThread({ companyId: COMPANY_A, tag: 'sec01-tin', subject: 'EO1 Sharedleakq inbound', lastAt: t1, lastDir: 'inbound', unread: 0 });
    await mkMsg({ companyId: COMPANY_A, threadId: thIn, tag: 'sec01-min', direction: 'inbound', fromEmail: 'shared@eo1.test', at: t1 });
    // Company B: SAME address on its own contact + a call so B's list is non-empty.
    const cB = await mkContact({ companyId: COMPANY_B, name: 'SEC01 B' });
    await mkContactEmail(cB, 'shared@eo1.test');
    const tlB = await mkTimeline({ companyId: COMPANY_B, contactId: cB });
    await mkCall({ companyId: COMPANY_B, timelineId: tlB, contactId: cB, startedAt: t1 });

    const aThreadIds = [Number(thOut), Number(thIn)];
    const aSubjects = ['EO1 Sharedleakq outbound', 'EO1 Sharedleakq inbound'];

    // B: query + route — A's threads/subjects/timestamps never appear.
    const bRows = await fetchPage(COMPANY_B);
    check(bRows.length > 0, "B's list is non-empty");
    check(bRows.every(r => !aThreadIds.includes(Number(r.email_thread_id))), "B never sees A's thread ids (query)");
    check(bRows.every(r => !aSubjects.includes(r.email_subject)), "B never sees A's subjects (query)");
    const bRow = oneRowFor(bRows, tlB, 'B contact');
    check(bRow.email_thread_id === null, "B's same-address contact carries NO email signal from A");
    const bBody = await routeList(COMPANY_B);
    check(bBody.conversations.every(r => !aThreadIds.includes(Number(r.email_thread_id))), "B never sees A's thread ids (route)");

    // Direct-access probe: B searches by A's subject term → zero.
    const bSearch = await routeList(COMPANY_B, { search: 'sharedleakq' });
    eq(bSearch.total, 0, "B's search on A's subject returns 0");

    // A's own fetch is normal: one row for the contact, newest thread picked,
    // and BOTH threads reachable by their subjects via search.
    const aRows = await fetchPage(COMPANY_A);
    const aRow = oneRowFor(aRows, tlA, 'A contact');
    eq(aRow.email_thread_id, thOut, "A's row shows its newest thread");
    const aSearch = await routeList(COMPANY_A, { search: 'sharedleakq' });
    eq(aSearch.total, 1, "A finds its own threads by subject");
});

// ---------------------------------------------------------------------------
CASE('TC-EO-SEC02', 'sec-mig-tenant', 'migration', 'mig 155 never links across tenants', async () => {
    await ensureCompany(COMPANY_B, 'eo1-sec-b', 'EO1 Sec Co B');
    const t1 = T(10);
    // Contact exists ONLY in company B for the cross-tenant address.
    const cB = await mkContact({ companyId: COMPANY_B, name: 'SEC02 B-only', email: 'xtenant@eo1.test' });
    // B non-empty list baseline.
    const tlB = await mkTimeline({ companyId: COMPANY_B, contactId: cB, phone: nextPhone() });
    await mkCall({ companyId: COMPANY_B, timelineId: tlB, contactId: cB, startedAt: t1 });
    // A-candidate whose TO matches ONLY that B contact.
    const thX = await mkThread({ companyId: COMPANY_A, tag: 'sec02-tx', subject: 'EO1 SEC02 cross', lastAt: t1, lastDir: 'outbound', unread: 0 });
    const mX = await mkMsg({ companyId: COMPANY_A, threadId: thX, tag: 'sec02-mx', direction: 'outbound', to: [{ email: 'xtenant@eo1.test' }], at: t1 });
    // Control: A-candidate matching an A contact.
    const cCtl = await mkContact({ companyId: COMPANY_A, name: 'SEC02 control', email: 'control@eo1.test' });
    const thC = await mkThread({ companyId: COMPANY_A, tag: 'sec02-tc', subject: 'EO1 SEC02 control', lastAt: t1, lastDir: 'outbound', unread: 0 });
    const mC = await mkMsg({ companyId: COMPANY_A, threadId: thC, tag: 'sec02-mc', direction: 'outbound', to: [{ email: 'control@eo1.test' }], at: t1 });

    const bTimelinesBefore = Number(await scalar(`SELECT count(*) FROM timelines WHERE company_id = $1`, [COMPANY_B]));
    const bListBefore = JSON.stringify(await fetchPage(COMPANY_B));

    const counts = await runMig155();
    eq(counts.linked, 1, 'only the control candidate links');

    const stX = await msgState(mX.provider_message_id);
    check(stX.contact_id === null && stX.timeline_id === null && stX.on_timeline === false,
        'cross-tenant candidate stays unlinked (c.company_id = em.company_id)');
    const stC = await msgState(mC.provider_message_id);
    eq(stC.contact_id, cCtl, 'control candidate links normally');
    check(stC.on_timeline === true, 'control on_timeline');
    eq(Number(await scalar(`SELECT count(*) FROM timelines WHERE company_id = $1`, [COMPANY_B])), bTimelinesBefore,
        "NO timeline created/adopted in B on A's behalf");
    check((await timelinesOf(cB)).length === 1, "B contact keeps exactly its own timeline");
    eq(JSON.stringify(await fetchPage(COMPANY_B)), bListBefore, "B's list unchanged");
});

// ═════════════════════════════════════════════════════════════════════════════
// Runner
// ═════════════════════════════════════════════════════════════════════════════

function parseSectionArg() {
    const arg = process.argv.find(a => a.startsWith('--section='));
    const v = arg ? arg.split('=')[1] : (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'all');
    return v || 'all';
}

async function main() {
    const sel = parseSectionArg();
    const selected = CASES.filter(c =>
        sel === 'all' || c.group === sel || c.section === sel || c.id === sel);
    if (selected.length === 0) {
        console.error(`No cases match --section=${sel}. Groups: cte|migration|route|all; sections: ${CASES.map(c => c.section).join(', ')}`);
        process.exit(2);
    }

    console.log(`EMAIL-OUTBOUND-001 verify — DATABASE_URL=${process.env.DATABASE_URL}`);
    console.log(`Sections: ${sel} → ${selected.length} case(s)\n`);

    await cleanupAll();

    // Baseline drain: NOTICE-count assertions require that MY seeds are the only
    // mig-155 candidates. If the dev DB carries pre-existing unlinked outbound
    // rows, link them once up-front (exactly what the deploy run will do).
    const preexisting = Number(await scalar(
        `SELECT count(*) FROM email_messages
         WHERE direction = 'outbound' AND contact_id IS NULL AND on_timeline = false
           AND message_id_header IS NOT NULL AND message_id_header <> ''`));
    if (preexisting > 0) {
        console.log(`NOTE: ${preexisting} pre-existing mig-155 candidate(s) in this DB — draining once so per-case NOTICE counts are attributable to seeded fixtures.`);
        const drained = await runMig155();
        console.log(`      drained: linked=${drained.linked} adopted=${drained.adopted} created=${drained.created} rehomed=${drained.rehomed}\n`);
    }

    for (const c of selected) {
        await cleanupAll();
        try {
            await c.fn();
            record(c.id, 'PASS', c.title);
        } catch (e) {
            const note = `${c.title} — ${e instanceof CheckError ? e.message : (e.stack || e.message)}`;
            record(c.id, 'FAIL', note);
        }
    }

    await cleanupAll();

    const pass = results.filter(r => r.status === 'PASS').length;
    const fail = results.filter(r => r.status === 'FAIL').length;
    const skip = results.filter(r => r.status === 'SKIP').length;
    console.log(`\n══════════════════════════════════════════════`);
    console.log(`PASS ${pass} · FAIL ${fail} · SKIP ${skip} (of ${results.length})`);
    if (fail > 0) console.log(`FAILED: ${results.filter(r => r.status === 'FAIL').map(r => r.id).join(', ')}`);

    await db.pool.end();
    // Some app modules (SSE keep-alives etc.) may hold timers — exit explicitly.
    process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
    console.error('FATAL:', e);
    try { await db.pool.end(); } catch { /* noop */ }
    process.exit(1);
});
