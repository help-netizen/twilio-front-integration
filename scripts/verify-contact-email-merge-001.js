#!/usr/bin/env node
/**
 * CONTACT-EMAIL-MERGE-001 — T4 real-DB integration + security verify script.
 *
 * The LOAD-BEARING verification: this feature DELETEs contacts, so no-dangling-FK
 * (S2) and cross-tenant isolation (S7) must be proven on real data, not mocks
 * (mocked jest only checks the SQL string — LIST-PAGINATION-001 lesson). Runs the
 * REAL merge service (and, where stated, the REAL getUnifiedTimelinePage) against
 * a local Postgres, self-seeding / self-cleaning by the unique tag CEM1.
 *
 * The real functions exercised (unmocked; the merge is driven at the service layer,
 * which is simpler + deterministic than routing through HTTP, and the emails are
 * seeded via real INSERTs):
 *   • contactEmailMergeService.resolveAddedEmail / mergeContacts / isContactEmailOnly
 *   • emailQueries.findEmailContact / linkMessageToContact / listMessageIdsForAddress
 *   • timelinesQueries.findOrCreateTimelineByContact / reassignShadowOrphanOpenTasks
 *   • timelinesQueries.getUnifiedTimelinePage (S1 surfacing)
 *
 * Cases (Docs/test-cases/CONTACT-EMAIL-MERGE-001.md):
 *   s1  TC-CEM-I01  inbox-only link onto target timeline + surfaces on the list
 *   s2  TC-CEM-I02  **P0** full-merge of an EMPTY auto-contact: dup DELETED, all
 *                   email moved, open task RE-HOMED (not CASCADE-deleted), ZERO
 *                   dangling FK  (+ I03 multi-address dup, + I13 phone-path regress)
 *   s3  TC-CEM-I04  non-empty owner (phone+job): emails re-pointed, owner+job KEPT
 *                   (+ I16 D2b is address-scoped, not contact-scoped)
 *   s6  TC-CEM-I08  idempotence: re-run the add → owner==target no-op, identical state
 *   s7  TC-CEM-I09/I10 **P0** cross-tenant: a company-B owner of the same address is
 *                   NEVER read/moved/deleted; mergeContacts across companies THROWS
 *   s8  TC-CEM-I11  removal: contact_emails row gone, linked history KEPT
 *   sab TC-CEM-ISAB sabotage negative control — a deliberately-wrong expectation
 *                   MUST trip a FAIL, else every PASS above is vacuous
 *
 * Company A = seed 00000000-0000-0000-0000-000000000001 (real dev rows coexist →
 * assertions are tagged / delta / row-targeted, never absolute whole-company counts).
 * Company B = tagged c0000000-0000-4000-8000-0000000000e1, CREATED + deleted here.
 *
 * Usage:
 *   node scripts/verify-contact-email-merge-001.js [--section=s1|s2|s3|s6|s7|s8|sab|all]
 *   DATABASE_URL defaults to postgresql://localhost/twilio_calls (house default).
 * Never point this at prod. Exit code 0 only when no case FAILs.
 */
'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/twilio_calls';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const db = require(path.join(ROOT, 'backend/src/db/connection'));
const emailQueries = require(path.join(ROOT, 'backend/src/db/emailQueries'));
const timelinesQueries = require(path.join(ROOT, 'backend/src/db/timelinesQueries'));
const merge = require(path.join(ROOT, 'backend/src/services/contactEmailMergeService'));

const COMPANY_A = '00000000-0000-0000-0000-000000000001'; // seed company (real dev data coexists)
const COMPANY_B = 'c0000000-0000-4000-8000-0000000000e1'; // tagged, created+deleted here

// ─── tiny assert/report kit (mirrors verify-tasks-count-001.js) ─────────────

class CheckError extends Error {}
function check(cond, msg) {
    if (!cond) throw new CheckError(msg);
}
function eq(actual, expected, label) {
    check(String(actual) === String(expected), `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const results = [];
function record(id, status, note) {
    results.push({ id, status, note: note || '' });
    const pad = ' '.repeat(Math.max(1, 12 - id.length));
    console.log(`${status} ${id}${pad}${note || ''}`);
}

// ─── seeding helpers (all tagged CEM1) ──────────────────────────────────────

let phoneSeq = 100;
function nextPhone() {
    phoneSeq += 1;
    return `+1999666${String(phoneSeq).padStart(4, '0')}`;
}

async function ensureCompany(id, slug, name) {
    await db.query(
        `INSERT INTO companies (id, name, slug, status) VALUES ($1, $2, $3, 'active')
         ON CONFLICT (id) DO NOTHING`,
        [id, name, slug]
    );
}

// A tagged contact. name is prefixed 'CEM1 ' for cleanup; phone optional (an
// email-only dup gets none, a survivor/owner gets one so it is clearly identity).
async function mkContact(companyId, { name = 'Contact', phone = null, email = null } = {}) {
    const r = await db.query(
        `INSERT INTO contacts (full_name, phone_e164, email, company_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [`CEM1 ${name}`, phone, email, companyId]
    );
    return r.rows[0].id;
}

async function mkContactEmail(contactId, addr, isPrimary = false) {
    await db.query(
        `INSERT INTO contact_emails (contact_id, email, email_normalized, is_primary)
         VALUES ($1, $2, lower(trim($2)), $3)
         ON CONFLICT (contact_id, email_normalized) DO NOTHING`,
        [contactId, addr, isPrimary]
    );
}

// A timeline needs contact_id OR phone_e164 (chk_timelines_identity).
async function mkTimeline(companyId, { contactId = null, phone = null } = {}) {
    const r = await db.query(
        `INSERT INTO timelines (contact_id, phone_e164, company_id) VALUES ($1, $2, $3) RETURNING id`,
        [contactId, contactId ? null : (phone || nextPhone()), companyId]
    );
    return r.rows[0].id;
}

// Reuse the company's existing gmail mailbox (company A has a real dev one);
// uniq (company_id, provider) allows only one per company, so seed one for B.
const mailboxCache = {};
async function mailboxFor(companyId) {
    if (mailboxCache[companyId]) return mailboxCache[companyId];
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
        [companyId, `mb-${String(companyId).slice(-4)}@cem1.test`]
    );
    mailboxCache[companyId] = created.rows[0].id;
    return created.rows[0].id;
}

let threadSeq = 0;
async function mkThread(companyId, { subject = 'CEM1 thread', lastAt = null, lastDir = 'inbound', unread = 0 } = {}) {
    threadSeq += 1;
    const mailboxId = await mailboxFor(companyId);
    const r = await db.query(
        `INSERT INTO email_threads (company_id, mailbox_id, provider_thread_id, subject,
                                    last_message_at, last_message_direction, unread_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [companyId, mailboxId, `cem1-th-${threadSeq}-${Date.now()}`, subject, lastAt, lastDir, unread]
    );
    return r.rows[0].id;
}

let msgSeq = 0;
async function mkMsg(companyId, {
    threadId, direction = 'inbound', fromEmail = null, to = [],
    contactId = null, timelineId = null, onTimeline = false, at = null, subject = null,
} = {}) {
    msgSeq += 1;
    const mailboxId = await mailboxFor(companyId);
    const pmid = `cem1-msg-${msgSeq}-${Date.now()}`;
    const r = await db.query(
        `INSERT INTO email_messages (company_id, mailbox_id, thread_id, provider_message_id,
                                     message_id_header, direction, from_email,
                                     to_recipients_json, subject,
                                     gmail_internal_at, contact_id, timeline_id, on_timeline)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13)
         RETURNING id, provider_message_id`,
        [companyId, mailboxId, threadId, pmid, `<${pmid}@cem1.test>`, direction, fromEmail,
            JSON.stringify(to), subject, at, contactId, timelineId, onTimeline]
    );
    return r.rows[0].provider_message_id;
}

async function mkJob(companyId, { contactId = null } = {}) {
    const r = await db.query(
        `INSERT INTO jobs (company_id, contact_id) VALUES ($1, $2) RETURNING id`,
        [companyId, contactId]
    );
    return r.rows[0].id;
}

// A lead on a contact. leads.company_id is NOT NULL (mig 012); uuid is NOT NULL
// UNIQUE. Tagged in lead_notes ('CEM1 ') for cleanup. Exercises the company-scoped
// leads re-point leg of mergeContacts (CONTACT-EMAIL-MERGE-001 Reviewer fix).
let leadSeq = 0;
async function mkLead(companyId, { contactId = null } = {}) {
    leadSeq += 1;
    const r = await db.query(
        `INSERT INTO leads (uuid, company_id, contact_id, lead_notes)
         VALUES ($1, $2, $3, 'CEM1 lead') RETURNING id`,
        [`cem1-ld-${leadSeq}-${Date.now()}`.slice(0, 20), companyId, contactId]
    );
    return r.rows[0].id;
}

// An Action-Required open task on a timeline (the ORPHAN-TASK-REHOME-001 trap
// subject). Title tagged 'CEM1 ' for cleanup.
async function seedOpenTask(companyId, { threadId = null, contactId = null, title = 'task', status = 'open' } = {}) {
    const r = await db.query(
        `INSERT INTO tasks (company_id, thread_id, contact_id, subject_type, subject_id, title, status, created_by)
         VALUES ($1, $2, $3, 'contact', $4, $5, $6, 'agent') RETURNING id`,
        [companyId, threadId, contactId, contactId, `CEM1 ${title}`, status]
    );
    return r.rows[0].id;
}

// ─── cleanup (FK order; run before every case + at start/end) ───────────────
// tasks → email_messages → email_threads → timelines → business entities →
// contact_emails → contacts → companies. Tagged CEM1 everywhere; company B is
// nuked wholesale (CASCADE mops stragglers).

async function cleanupAll() {
    mailboxCache[COMPANY_B] = undefined;
    const taggedContacts = `SELECT id FROM contacts WHERE full_name LIKE 'CEM1 %'`;

    // tasks first (thread_id CASCADE, but target by tag/company so company A row survives).
    await db.query(`DELETE FROM tasks WHERE title LIKE 'CEM1 %'`);
    await db.query(`DELETE FROM tasks WHERE company_id = $1`, [COMPANY_B]);
    await db.query(`DELETE FROM tasks WHERE contact_id IN (${taggedContacts})`);

    // email footprint tagged by provider ids / tagged company / tagged contact.
    await db.query(`DELETE FROM email_messages WHERE provider_message_id LIKE 'cem1-msg-%'`);
    await db.query(`DELETE FROM email_messages WHERE company_id = $1`, [COMPANY_B]);
    await db.query(`DELETE FROM email_messages WHERE contact_id IN (${taggedContacts})`);
    await db.query(`DELETE FROM email_threads WHERE provider_thread_id LIKE 'cem1-th-%'`);
    await db.query(`DELETE FROM email_threads WHERE company_id = $1`, [COMPANY_B]);

    // business entities on tagged contacts (tasks already gone → no CASCADE surprise).
    await db.query(`DELETE FROM jobs WHERE contact_id IN (${taggedContacts})`);
    await db.query(`DELETE FROM jobs WHERE company_id = $1`, [COMPANY_B]);
    // leads.contact_id is a plain REFERENCES (no CASCADE) → delete tagged/B-scoped
    // leads BEFORE the contacts delete or the FK blocks it.
    await db.query(`DELETE FROM leads WHERE lead_notes LIKE 'CEM1 %'`);
    await db.query(`DELETE FROM leads WHERE contact_id IN (${taggedContacts})`);
    await db.query(`DELETE FROM leads WHERE company_id = $1`, [COMPANY_B]);

    // timelines: tagged company B, or hung on a tagged contact / tagged phone.
    await db.query(`DELETE FROM timelines WHERE company_id = $1`, [COMPANY_B]);
    await db.query(`DELETE FROM timelines WHERE contact_id IN (${taggedContacts})`);
    await db.query(`DELETE FROM timelines WHERE contact_id IS NULL AND phone_e164 LIKE '+1999666%'`);

    // contact_emails on tagged contacts (also CASCADE-covered, explicit for clarity).
    await db.query(`DELETE FROM contact_emails WHERE contact_id IN (${taggedContacts})`);

    await db.query(`DELETE FROM contacts WHERE full_name LIKE 'CEM1 %'`);

    // company B mailbox + company row last (CASCADE mops any straggler child rows).
    await db.query(`DELETE FROM email_mailboxes WHERE company_id = $1`, [COMPANY_B]);
    await db.query(`DELETE FROM companies WHERE id = $1`, [COMPANY_B]);
}

// ─── shared probes ──────────────────────────────────────────────────────────

async function msgState(providerMessageId) {
    const r = await db.query(
        `SELECT contact_id, timeline_id, on_timeline
         FROM email_messages WHERE provider_message_id = $1`,
        [providerMessageId]
    );
    return r.rows[0] || null;
}

async function scalar(sql, params = []) {
    const r = await db.query(sql, params);
    return r.rows[0] ? Object.values(r.rows[0])[0] : null;
}

async function rowExists(table, idCol, id) {
    return Number(await scalar(`SELECT count(*)::int FROM ${table} WHERE ${idCol} = $1`, [id])) > 0;
}

/**
 * THE S2 "dangling FK" scan: after a full-merge, assert ZERO rows reference the
 * deleted dup id across EVERY contact_id / thread_id FK enumerated in the
 * architecture emptiness table, plus the dup contact + dup timeline rows are gone.
 * Returns the list of offending "table.col" strings (empty ⇒ clean).
 */
async function danglingRefs(dupId, dupTlId) {
    const contactIdTables = [
        'jobs', 'leads', 'estimates', 'invoices', 'payment_transactions',
        'stripe_payment_sessions', 'portal_access_tokens', 'portal_sessions',
        'portal_events', 'crm_account_contacts', 'crm_deal_contacts', 'crm_activities',
        'tasks', 'contact_addresses', 'contact_emails', 'email_messages', 'timelines',
    ];
    const offenders = [];
    for (const t of contactIdTables) {
        const n = Number(await scalar(`SELECT count(*)::int FROM ${t} WHERE contact_id = $1`, [dupId]));
        if (n > 0) offenders.push(`${t}.contact_id (${n})`);
    }
    // thread_id (= dupTl) references: tasks + email_messages.timeline_id.
    if (dupTlId != null) {
        const tn = Number(await scalar(`SELECT count(*)::int FROM tasks WHERE thread_id = $1`, [dupTlId]));
        if (tn > 0) offenders.push(`tasks.thread_id (${tn})`);
        const en = Number(await scalar(`SELECT count(*)::int FROM email_messages WHERE timeline_id = $1`, [dupTlId]));
        if (en > 0) offenders.push(`email_messages.timeline_id (${en})`);
        if (await rowExists('timelines', 'id', dupTlId)) offenders.push('timelines.id (dupTl still present)');
    }
    if (await rowExists('contacts', 'id', dupId)) offenders.push('contacts.id (dup still present)');
    return offenders;
}

// ═════════════════════════════════════════════════════════════════════════════
// Cases
// ═════════════════════════════════════════════════════════════════════════════

const CASES = [];
function CASE(id, section, title, fn) {
    CASES.push({ id, section, title, fn });
}

// ---------------------------------------------------------------------------
CASE('TC-CEM-I01', 's1', 'S1 inbox-only: messages get contact_id + timeline_id = target, on_timeline=true, surface on list', async () => {
    const addr = 'inbox@cem1.test';
    // Target T with a phone (clearly identity); no owning contact for the address.
    const T = await mkContact(COMPANY_A, { name: 'S1 Target', phone: nextPhone() });
    await mkContactEmail(T, addr, true); // the editor upserts the address; we seed the row (T-owned).

    // Two inbound inbox-only messages: contact_id NULL, timeline_id NULL, on_timeline false.
    const th = await mkThread(COMPANY_A, { subject: 'CEM1 S1 inbox', lastAt: new Date().toISOString(), lastDir: 'inbound', unread: 1 });
    const m1 = await mkMsg(COMPANY_A, { threadId: th, direction: 'inbound', fromEmail: addr, subject: 'CEM1 S1 inbox' });
    const m2 = await mkMsg(COMPANY_A, { threadId: th, direction: 'inbound', fromEmail: ' Inbox@CEM1.test ', subject: 'CEM1 S1 inbox' });

    // Owner resolution: T owns the address (contact_emails), so resolveAddedEmail
    // for the SAME address on T would be a no-op. To exercise the inbox-only LINK
    // branch we resolve as the target (owner==target path still links nothing);
    // the true inbox-only path is when no contact owns it. Model it precisely:
    // remove the seed row, resolve (owner=none → link), then the editor's upsert
    // adds the contact_emails row. Order-independent for the message move.
    await db.query(`DELETE FROM contact_emails WHERE contact_id = $1`, [T]);

    await merge.resolveAddedEmail(T, addr, COMPANY_A);

    // both messages now linked onto the target's timeline.
    const s1 = await msgState(m1); const s2 = await msgState(m2);
    eq(s1.contact_id, T, 'm1 contact_id = T');
    eq(s2.contact_id, T, 'm2 contact_id = T');
    eq(s1.on_timeline, true, 'm1 on_timeline');
    eq(s2.on_timeline, true, 'm2 on_timeline');
    check(s1.timeline_id != null, 'm1 got a timeline');
    eq(s1.timeline_id, s2.timeline_id, 'both messages on the SAME (target) timeline');
    const TL_T = s1.timeline_id;
    // that timeline belongs to T.
    eq(await scalar(`SELECT contact_id FROM timelines WHERE id = $1`, [TL_T]), T, 'timeline is the target contact timeline');

    // now the editor persists the address so the list CTE (which joins contact→thread
    // via contact_emails) can surface it.
    await mkContactEmail(T, addr, true);

    // surfaces on the unified list, positioned by the thread, with the email thread id.
    const rows = await timelinesQueries.getUnifiedTimelinePage({ limit: 2000, offset: 0, companyId: COMPANY_A });
    const mine = rows.filter(r => Number(r.timeline_id) === Number(TL_T));
    check(mine.length === 1, `exactly one list row for TL_T, got ${mine.length}`);
    eq(mine[0].email_thread_id, th, 'list row carries the email thread id');

    // idempotent re-link (owner is now T → no-op; message state identical).
    await merge.resolveAddedEmail(T, addr, COMPANY_A);
    const s1b = await msgState(m1);
    eq(s1b.timeline_id, TL_T, 're-run keeps same timeline (idempotent)');
    eq(s1b.on_timeline, true, 're-run keeps on_timeline');
});

// ---------------------------------------------------------------------------
CASE('TC-CEM-I02', 's2', 'S2 P0 FULL-MERGE: empty auto-contact dup DELETED, all email moved, open task RE-HOMED, ZERO dangling FK', async () => {
    const addr = 'x@cem1.test';
    // Dup D = bare email-only auto-contact: no phone, blank-ish name, NO identity rows.
    const D = await mkContact(COMPANY_A, { name: 'S2 Dup (auto)' });
    await mkContactEmail(D, addr, true);
    const dupTl = await mkTimeline(COMPANY_A, { contactId: D });
    const th = await mkThread(COMPANY_A, { subject: 'CEM1 S2 dup', lastAt: new Date().toISOString(), lastDir: 'inbound', unread: 2 });
    const dm1 = await mkMsg(COMPANY_A, { threadId: th, direction: 'inbound', fromEmail: addr, contactId: D, timelineId: dupTl, onTimeline: true });
    const dm2 = await mkMsg(COMPANY_A, { threadId: th, direction: 'outbound', to: [{ email: addr }], contactId: D, timelineId: dupTl, onTimeline: true });
    const dm3 = await mkMsg(COMPANY_A, { threadId: th, direction: 'inbound', fromEmail: addr, contactId: D, timelineId: dupTl, onTimeline: true });
    // ONE OPEN agent task on the dup TIMELINE (tasks.thread_id=dupTl) — the
    // Action-Required CASCADE trap (ORPHAN-TASK-REHOME-001). It is thread-parented
    // (NO contact_id): a timeline task is the mergeable email footprint, not
    // independent identity, so it must NOT make the dup look non-empty. (A
    // contact_id-parented task WOULD degrade to D2b — asserted in the jest U07.)
    const openTaskId = await seedOpenTask(COMPANY_A, { threadId: dupTl, title: 'S2 AR task', status: 'open' });

    // Target T = a real contact with its own identity (a phone) → survivor.
    const T = await mkContact(COMPANY_A, { name: 'S2 Target', phone: nextPhone() });

    // Sanity: the emptiness gate sees D as email-only (→ D2a full merge).
    eq(await merge.isContactEmailOnly(D, COMPANY_A), true, 'dup is email-only (D2a)');
    eq(await merge.isContactEmailOnly(T, COMPANY_A), false, 'target has a phone → not email-only');

    // run the resolution (D2a → mergeContacts(T, D)).
    await merge.resolveAddedEmail(T, addr, COMPANY_A);

    // dup contact + its timeline are GONE.
    check(!(await rowExists('contacts', 'id', D)), 'dup contact DELETED');
    check(!(await rowExists('timelines', 'id', dupTl)), 'dup timeline DELETED');

    // findEmailContact now resolves the address to the survivor T.
    const owner = await emailQueries.findEmailContact(addr, COMPANY_A);
    eq(owner && owner.id, T, 'findEmailContact(x) → survivor T after merge');

    // survivor timeline: all 3 messages re-pointed onto it, on_timeline=true.
    const TL_T = await scalar(`SELECT id FROM timelines WHERE contact_id = $1 AND company_id = $2`, [T, COMPANY_A]);
    check(TL_T != null, 'survivor has a timeline');
    for (const [id, m] of [['dm1', dm1], ['dm2', dm2], ['dm3', dm3]]) {
        const s = await msgState(m);
        eq(s.contact_id, T, `${id} contact_id = T`);
        eq(s.timeline_id, TL_T, `${id} timeline_id = survivor TL`);
        eq(s.on_timeline, true, `${id} on_timeline`);
    }

    // the OPEN task is RE-HOMED (still exists, open, thread_id → survivor TL) — NOT
    // cascade-deleted. It is thread-parented (contact_id NULL), so the re-home that
    // matters is thread_id = survivor TL BEFORE the dup timeline delete (step 2 of
    // the FK recipe); a missing task here = the exact ORPHAN-TASK-REHOME regression.
    check(await rowExists('tasks', 'id', openTaskId), 'open task STILL EXISTS (not CASCADE-deleted — the ORPHAN-TASK-REHOME regression)');
    const task = (await db.query(`SELECT status, thread_id FROM tasks WHERE id = $1`, [openTaskId])).rows[0];
    eq(task.status, 'open', 'task still open');
    eq(task.thread_id, TL_T, 'task re-homed onto survivor timeline (thread_id repointed before dupTl delete)');

    // THE dangling-FK scan: zero rows reference the deleted dup id/timeline anywhere.
    const offenders = await danglingRefs(D, dupTl);
    check(offenders.length === 0, `ZERO dangling FK required; found: ${offenders.join(', ')}`);

    // contact_emails moved to survivor (address on file under T now).
    eq(await scalar(`SELECT count(*)::int FROM contact_emails WHERE contact_id = $1 AND email_normalized = $2`, [T, addr]), 1,
        'address now on the survivor contact_emails');
});

// ---------------------------------------------------------------------------
CASE('TC-CEM-I03', 's2', 'S2 corner: dup owns MULTIPLE addresses → both threads move, delete still clean', async () => {
    const D = await mkContact(COMPANY_A, { name: 'S2b MultiDup' });
    await mkContactEmail(D, 'x2@cem1.test', true);
    await mkContactEmail(D, 'y2@cem1.test', false);
    const dupTl = await mkTimeline(COMPANY_A, { contactId: D });
    const thX = await mkThread(COMPANY_A, { subject: 'CEM1 S2b X' });
    const thY = await mkThread(COMPANY_A, { subject: 'CEM1 S2b Y' });
    const mx1 = await mkMsg(COMPANY_A, { threadId: thX, direction: 'inbound', fromEmail: 'x2@cem1.test', contactId: D, timelineId: dupTl, onTimeline: true });
    const mx2 = await mkMsg(COMPANY_A, { threadId: thX, direction: 'inbound', fromEmail: 'x2@cem1.test', contactId: D, timelineId: dupTl, onTimeline: true });
    const my1 = await mkMsg(COMPANY_A, { threadId: thY, direction: 'inbound', fromEmail: 'y2@cem1.test', contactId: D, timelineId: dupTl, onTimeline: true });
    const my2 = await mkMsg(COMPANY_A, { threadId: thY, direction: 'inbound', fromEmail: 'y2@cem1.test', contactId: D, timelineId: dupTl, onTimeline: true });

    const T = await mkContact(COMPANY_A, { name: 'S2b Target', phone: nextPhone() });

    // add ONLY x2 → mergeContacts moves the whole contact (D2a is whole-contact).
    await merge.resolveAddedEmail(T, 'x2@cem1.test', COMPANY_A);

    check(!(await rowExists('contacts', 'id', D)), 'dup deleted');
    const TL_T = await scalar(`SELECT id FROM timelines WHERE contact_id = $1`, [T]);
    for (const m of [mx1, mx2, my1, my2]) {
        const s = await msgState(m);
        eq(s.contact_id, T, 'both threads messages → T');
        eq(s.timeline_id, TL_T, 'both threads messages on survivor TL');
    }
    // BOTH contact_emails rows re-pointed to T (NOT-EXISTS guarded, no clash).
    eq(await scalar(`SELECT count(*)::int FROM contact_emails WHERE contact_id = $1 AND email_normalized IN ('x2@cem1.test','y2@cem1.test')`, [T]), 2,
        'both addresses on survivor');
    const offenders = await danglingRefs(D, dupTl);
    check(offenders.length === 0, `dangling after multi-address merge: ${offenders.join(', ')}`);
});

// ---------------------------------------------------------------------------
CASE('TC-CEM-I13', 's2', 'S2 regression: mergeContacts re-homes a shadow-orphan open task on the survivor number too', async () => {
    // Survivor T has a phone AND a leftover shadow-orphan timeline (contact_id NULL)
    // on that same number carrying an open task. mergeContacts step 1
    // (findOrCreateTimelineByContact) must re-home that task onto the survivor —
    // proves the reused REHOME-001 path fires inside the merge tx.
    const addr = 'reh@cem1.test';
    const phone = nextPhone();
    const T = await mkContact(COMPANY_A, { name: 'S2reh Target', phone });
    const shadow = await mkTimeline(COMPANY_A, { phone }); // orphan on T's number
    const shadowTask = await seedOpenTask(COMPANY_A, { threadId: shadow, title: 'S2reh shadow task', status: 'open' });

    // empty dup owning the added address.
    const D = await mkContact(COMPANY_A, { name: 'S2reh Dup' });
    await mkContactEmail(D, addr, true);
    const dupTl = await mkTimeline(COMPANY_A, { contactId: D });
    await mkMsg(COMPANY_A, { threadId: await mkThread(COMPANY_A, { subject: 'CEM1 S2reh' }), direction: 'inbound', fromEmail: addr, contactId: D, timelineId: dupTl, onTimeline: true });

    await merge.resolveAddedEmail(T, addr, COMPANY_A);

    const TL_T = await scalar(`SELECT id FROM timelines WHERE contact_id = $1`, [T]);
    check(await rowExists('tasks', 'id', shadowTask), 'shadow-orphan task survives');
    eq((await db.query(`SELECT thread_id FROM tasks WHERE id = $1`, [shadowTask])).rows[0].thread_id, TL_T,
        'shadow-orphan open task re-homed onto survivor timeline');
    check(!(await rowExists('contacts', 'id', D)), 'dup still deleted alongside');
});

// ---------------------------------------------------------------------------
CASE('TC-CEM-I14', 's2', 'S2 leads leg: mergeContacts re-points a same-company lead from dup → survivor (company-scoped)', async () => {
    // Direct mergeContacts (generic-merge path) so the lead-bearing dup is not
    // gated out by the emptiness test. Proves the company-A leads UPDATE fires:
    // the dup's lead follows the survivor, dup deleted with no FK block.
    const survivor = await mkContact(COMPANY_A, { name: 'S2ld Survivor', phone: nextPhone() });
    const dup = await mkContact(COMPANY_A, { name: 'S2ld Dup', phone: nextPhone() });
    const lead = await mkLead(COMPANY_A, { contactId: dup });

    await merge.mergeContacts(survivor, dup, COMPANY_A);

    check(await rowExists('leads', 'id', lead), 'lead survived the merge');
    eq(await scalar(`SELECT contact_id FROM leads WHERE id = $1`, [lead]), survivor, 'lead re-pointed dup → survivor');
    check(!(await rowExists('contacts', 'id', dup)), 'dup deleted (no leads.contact_id FK block)');
});

// ---------------------------------------------------------------------------
CASE('TC-CEM-I04', 's3', 'S3 non-empty owner (phone+job): emails re-pointed to target, owner + its job STILL EXIST', async () => {
    const addr = 'bob@cem1.test';
    // Owner O = contact WITH a phone AND a job AND its own timeline.
    const O = await mkContact(COMPANY_A, { name: 'S3 Owner Bob', phone: nextPhone() });
    await mkContactEmail(O, addr, true);
    const TL_O = await mkTimeline(COMPANY_A, { contactId: O });
    const job = await mkJob(COMPANY_A, { contactId: O });
    const th = await mkThread(COMPANY_A, { subject: 'CEM1 S3 bob' });
    const bm1 = await mkMsg(COMPANY_A, { threadId: th, direction: 'inbound', fromEmail: addr, contactId: O, timelineId: TL_O, onTimeline: true });
    const bm2 = await mkMsg(COMPANY_A, { threadId: th, direction: 'inbound', fromEmail: addr, contactId: O, timelineId: TL_O, onTimeline: true });

    const T = await mkContact(COMPANY_A, { name: 'S3 Target Acme', phone: nextPhone() });

    // gate: O is NOT email-only (phone + job) → D2b re-point only.
    eq(await merge.isContactEmailOnly(O, COMPANY_A), false, 'owner not email-only (phone+job)');

    await merge.resolveAddedEmail(T, addr, COMPANY_A);

    // the 2 messages re-pointed onto T's timeline.
    const TL_T = await scalar(`SELECT id FROM timelines WHERE contact_id = $1`, [T]);
    for (const m of [bm1, bm2]) {
        const s = await msgState(m);
        eq(s.contact_id, T, 'message re-pointed to T');
        eq(s.timeline_id, TL_T, 'message on T timeline');
        eq(s.on_timeline, true, 'message on_timeline');
    }
    // O + its job + its timeline all STILL EXIST — no delete anywhere.
    check(await rowExists('contacts', 'id', O), 'owner O still exists (NOT deleted)');
    eq(await scalar(`SELECT phone_e164 FROM contacts WHERE id = $1`, [O]) != null, true, 'owner keeps its phone');
    check(await rowExists('jobs', 'id', job), 'owner job still exists');
    eq(await scalar(`SELECT contact_id FROM jobs WHERE id = $1`, [job]), O, 'job still owned by O');
    check(await rowExists('timelines', 'id', TL_O), 'owner timeline still exists');
});

// ---------------------------------------------------------------------------
CASE('TC-CEM-I16', 's3', 'S3 precision: D2b re-point moves ONLY the added address, not the owner other-address email', async () => {
    const O = await mkContact(COMPANY_A, { name: 'S3b Owner', phone: nextPhone() });
    await mkContactEmail(O, 'bob@cem1.test', true);
    await mkContactEmail(O, 'bob2@cem1.test', false);
    const TL_O = await mkTimeline(COMPANY_A, { contactId: O });
    await mkJob(COMPANY_A, { contactId: O }); // makes O non-empty
    const th1 = await mkThread(COMPANY_A, { subject: 'CEM1 S3b bob' });
    const th2 = await mkThread(COMPANY_A, { subject: 'CEM1 S3b bob2' });
    const added = await mkMsg(COMPANY_A, { threadId: th1, direction: 'inbound', fromEmail: 'bob@cem1.test', contactId: O, timelineId: TL_O, onTimeline: true });
    const other = await mkMsg(COMPANY_A, { threadId: th2, direction: 'inbound', fromEmail: 'bob2@cem1.test', contactId: O, timelineId: TL_O, onTimeline: true });

    const T = await mkContact(COMPANY_A, { name: 'S3b Target', phone: nextPhone() });
    await merge.resolveAddedEmail(T, 'bob@cem1.test', COMPANY_A);

    const TL_T = await scalar(`SELECT id FROM timelines WHERE contact_id = $1`, [T]);
    eq((await msgState(added)).timeline_id, TL_T, 'added-address message moved to T');
    // the OTHER address message stays on O/TL_O.
    const os = await msgState(other);
    eq(os.contact_id, O, 'other-address message stays on O');
    eq(os.timeline_id, TL_O, 'other-address message stays on TL_O');
    check(await rowExists('contacts', 'id', O), 'owner intact');
});

// ---------------------------------------------------------------------------
CASE('TC-CEM-I08', 's6', 'S6 idempotence: re-run the add → owner==target no-op, no second delete, identical state', async () => {
    const addr = 'idem@cem1.test';
    // run a full merge once (empty dup → T).
    const D = await mkContact(COMPANY_A, { name: 'S6 Dup' });
    await mkContactEmail(D, addr, true);
    const dupTl = await mkTimeline(COMPANY_A, { contactId: D });
    const th = await mkThread(COMPANY_A, { subject: 'CEM1 S6' });
    const dm = await mkMsg(COMPANY_A, { threadId: th, direction: 'inbound', fromEmail: addr, contactId: D, timelineId: dupTl, onTimeline: true });
    // thread-parented AR trap task (see I02) — mergeable footprint, not identity.
    const openTaskId = await seedOpenTask(COMPANY_A, { threadId: dupTl, title: 'S6 task', status: 'open' });
    const T = await mkContact(COMPANY_A, { name: 'S6 Target', phone: nextPhone() });

    await merge.resolveAddedEmail(T, addr, COMPANY_A);

    // snapshot after first run.
    const TL_T = await scalar(`SELECT id FROM timelines WHERE contact_id = $1`, [T]);
    const snap = async () => ({
        msg: JSON.stringify(await msgState(dm)),
        task: JSON.stringify((await db.query(`SELECT status, thread_id, contact_id FROM tasks WHERE id = $1`, [openTaskId])).rows[0] || null),
        ce: Number(await scalar(`SELECT count(*)::int FROM contact_emails WHERE contact_id = $1`, [T])),
        tCount: Number(await scalar(`SELECT count(*)::int FROM contacts WHERE full_name LIKE 'CEM1 %'`)),
        tlCount: Number(await scalar(`SELECT count(*)::int FROM timelines WHERE contact_id = $1`, [T])),
    });
    const before = await snap();
    eq(before.tlCount, 1, 'survivor has exactly one timeline after merge');

    // owner is now T; re-run twice → pure no-op (owner==target branch).
    await merge.resolveAddedEmail(T, addr, COMPANY_A);
    await merge.resolveAddedEmail(T, addr, COMPANY_A);

    const after = await snap();
    eq(after.msg, before.msg, 'message state byte-identical after re-runs');
    eq(after.task, before.task, 'task state byte-identical (still open, still re-homed)');
    eq(after.ce, before.ce, 'no duplicate contact_emails row');
    eq(after.tCount, before.tCount, 'no contact re-created / re-deleted');
    eq(after.tlCount, before.tlCount, 'no duplicate timeline');
    eq(await scalar(`SELECT timeline_id FROM email_messages WHERE provider_message_id = $1`, [dm]), TL_T, 'message still on survivor TL');
});

// ---------------------------------------------------------------------------
CASE('TC-CEM-I09', 's7', 'S7 P0 CROSS-TENANT: company-B owner of the same address is NEVER touched; A resolves to no-op', async () => {
    const addr = 'shared@cem1.test';
    await ensureCompany(COMPANY_B, 'cem1-b', 'CEM1 Cross Co B');

    // Company B: its own contact BC owns the SAME address string, with B-scoped
    // messages / thread / timeline / open task.
    const BC = await mkContact(COMPANY_B, { name: 'S7 BC', phone: nextPhone() });
    await mkContactEmail(BC, addr, true);
    const TL_B = await mkTimeline(COMPANY_B, { contactId: BC });
    const thB = await mkThread(COMPANY_B, { subject: 'CEM1 S7 B' });
    const bMsg = await mkMsg(COMPANY_B, { threadId: thB, direction: 'inbound', fromEmail: addr, contactId: BC, timelineId: TL_B, onTimeline: true });
    const bTask = await seedOpenTask(COMPANY_B, { threadId: TL_B, contactId: BC, title: 'S7 B task', status: 'open' });
    // A company-B lead hung on BC — exercises the company-scoped leads leg: the
    // A-side resolve must NEVER re-point / touch this B lead.
    const bLead = await mkLead(COMPANY_B, { contactId: BC });

    // Company A target T; A has NO footprint for the address.
    const T = await mkContact(COMPANY_A, { name: 'S7 Target', phone: nextPhone() });

    // resolution scoped to A: findEmailContact(A) sees NO A-side owner → inbox-only
    // for A with ZERO A messages → no-op. Must not reach into B.
    eq(await emailQueries.findEmailContact(addr, COMPANY_A), null, 'no A-side owner for the shared address');
    await merge.resolveAddedEmail(T, addr, COMPANY_A);

    // B is entirely untouched.
    check(await rowExists('contacts', 'id', BC), 'B contact still exists');
    const bs = await msgState(bMsg);
    eq(bs.contact_id, BC, 'B message still owned by BC (not re-pointed to T)');
    eq(bs.timeline_id, TL_B, 'B message still on B timeline');
    check(await rowExists('timelines', 'id', TL_B), 'B timeline still exists');
    check(await rowExists('tasks', 'id', bTask), 'B open task untouched');
    // The B lead is untouched: still exists AND still owned by BC (never re-pointed).
    check(await rowExists('leads', 'id', bLead), 'B lead still exists');
    eq(await scalar(`SELECT contact_id FROM leads WHERE id = $1`, [bLead]), BC, 'B lead still owned by BC (not re-pointed to T)');
    // company_id of the B message never changed to A.
    eq(await scalar(`SELECT company_id FROM email_messages WHERE provider_message_id = $1`, [bMsg]), COMPANY_B, 'B message still company B');
    // T gained nothing from B (no message re-pointed to T's timeline).
    const TL_T = await scalar(`SELECT id FROM timelines WHERE contact_id = $1`, [T]);
    if (TL_T != null) {
        eq(await scalar(`SELECT count(*)::int FROM email_messages WHERE timeline_id = $1`, [TL_T]), 0, 'T timeline has no B messages');
    }
});

// ---------------------------------------------------------------------------
CASE('TC-CEM-I10', 's7', 'S7 P0 symmetric: a full-merge in A never deletes/touches an identically-addressed B contact; cross-company merge THROWS', async () => {
    const addr = 'dup@cem1.test';
    await ensureCompany(COMPANY_B, 'cem1-b', 'CEM1 Cross Co B');

    // A has an EMPTY auto-contact D_A owning the address (→ D2a deletes it).
    const DA = await mkContact(COMPANY_A, { name: 'S7b DupA' });
    await mkContactEmail(DA, addr, true);
    const dupTlA = await mkTimeline(COMPANY_A, { contactId: DA });
    await mkMsg(COMPANY_A, { threadId: await mkThread(COMPANY_A, { subject: 'CEM1 S7b A' }), direction: 'inbound', fromEmail: addr, contactId: DA, timelineId: dupTlA, onTimeline: true });

    // B has a REAL contact BC also owning the same address (B-scoped, phone + msg).
    const BC = await mkContact(COMPANY_B, { name: 'S7b BC', phone: nextPhone() });
    await mkContactEmail(BC, addr, true);
    const TL_B = await mkTimeline(COMPANY_B, { contactId: BC });
    const bMsg = await mkMsg(COMPANY_B, { threadId: await mkThread(COMPANY_B, { subject: 'CEM1 S7b B' }), direction: 'inbound', fromEmail: addr, contactId: BC, timelineId: TL_B, onTimeline: true });
    // A company-B lead on BC — the A-side full-merge's company-scoped leads UPDATE
    // (WHERE company_id = A) must leave this B lead owned by BC.
    const bLead = await mkLead(COMPANY_B, { contactId: BC });

    const T = await mkContact(COMPANY_A, { name: 'S7b Target', phone: nextPhone() });
    await merge.resolveAddedEmail(T, addr, COMPANY_A);

    // D_A deleted + merged into T; BC (company B) COMPLETELY untouched.
    check(!(await rowExists('contacts', 'id', DA)), 'A dup deleted');
    check(await rowExists('contacts', 'id', BC), 'B contact untouched (still exists)');
    eq((await msgState(bMsg)).contact_id, BC, 'B message still on BC');
    check(await rowExists('timelines', 'id', TL_B), 'B timeline untouched');
    // The B lead survived the A-side merge unchanged (proves leads company-scoping).
    eq(await scalar(`SELECT contact_id FROM leads WHERE id = $1`, [bLead]), BC, 'B lead still owned by BC after A-side merge');

    // mergeContacts across companies THROWS (company guard) — never a cross-tenant merge.
    let threw = false;
    try {
        await merge.mergeContacts(T /* A */, BC /* B */, COMPANY_A);
    } catch (e) {
        threw = /cross-tenant|company/i.test(e.message);
    }
    check(threw, 'mergeContacts(A-survivor, B-dup) must THROW the cross-tenant guard');
    // and after the throw, B is still intact (guard fires before any mutation).
    check(await rowExists('contacts', 'id', BC), 'B contact still intact after blocked merge');
    eq((await msgState(bMsg)).contact_id, BC, 'B message untouched after blocked merge');
});

// ---------------------------------------------------------------------------
CASE('TC-CEM-I11', 's8', 'S8 removal: drop the address from contact_emails → row gone, linked history KEEPS contact_id', async () => {
    const addr = 'old@cem1.test';
    // Contact T with the address on file AND previously-linked messages for it.
    const T = await mkContact(COMPANY_A, { name: 'S8 Target', phone: nextPhone() });
    await mkContactEmail(T, 'primary@cem1.test', true);
    await mkContactEmail(T, addr, false);
    const TL_T = await mkTimeline(COMPANY_A, { contactId: T });
    const th = await mkThread(COMPANY_A, { subject: 'CEM1 S8' });
    const hist1 = await mkMsg(COMPANY_A, { threadId: th, direction: 'inbound', fromEmail: addr, contactId: T, timelineId: TL_T, onTimeline: true });
    const hist2 = await mkMsg(COMPANY_A, { threadId: th, direction: 'outbound', to: [{ email: addr }], contactId: T, timelineId: TL_T, onTimeline: true });

    // FR-8 non-destructive removal: the PATCH deletes the contact_emails row for a
    // dropped address; nothing un-links the messages. Model the DB effect directly
    // (the route's removal leg is a plain DELETE, no merge-service call).
    await db.query(`DELETE FROM contact_emails WHERE contact_id = $1 AND email_normalized = lower(trim($2))`, [T, addr]);

    // row gone.
    eq(await scalar(`SELECT count(*)::int FROM contact_emails WHERE contact_id = $1 AND email_normalized = $2`, [T, addr]), 0,
        'contact_emails row deleted');
    // history preserved: messages KEEP contact_id / timeline_id / on_timeline.
    for (const m of [hist1, hist2]) {
        const s = await msgState(m);
        eq(s.contact_id, T, 'history message keeps contact_id = T');
        eq(s.timeline_id, TL_T, 'history message keeps timeline_id');
        eq(s.on_timeline, true, 'history message keeps on_timeline');
    }
    // contact + timeline intact; the primary address still on file.
    check(await rowExists('contacts', 'id', T), 'contact intact');
    check(await rowExists('timelines', 'id', TL_T), 'timeline intact');
    eq(await scalar(`SELECT count(*)::int FROM contact_emails WHERE contact_id = $1 AND email_normalized = 'primary@cem1.test'`, [T]), 1,
        'primary address kept');
});

// ---------------------------------------------------------------------------
// Sabotage negative control — proves the harness actually reports FAIL when an
// expectation is violated. Runs the SAME assert kit against a KNOWN-WRONG
// expectation and asserts it throws; then re-asserts the TRUE expectation green.
// If this ever stops tripping, every PASS above is suspect.
CASE('TC-CEM-ISAB', 'sab', 'sabotage negative control: a deliberately-wrong expectation MUST trip a FAIL, then restore green', async () => {
    // Seed + run the S2 full-merge so we have a real deleted dup to assert against.
    const addr = 'sab@cem1.test';
    const D = await mkContact(COMPANY_A, { name: 'SAB Dup' });
    await mkContactEmail(D, addr, true);
    const dupTl = await mkTimeline(COMPANY_A, { contactId: D });
    await mkMsg(COMPANY_A, { threadId: await mkThread(COMPANY_A, { subject: 'CEM1 SAB' }), direction: 'inbound', fromEmail: addr, contactId: D, timelineId: dupTl, onTimeline: true });
    const T = await mkContact(COMPANY_A, { name: 'SAB Target', phone: nextPhone() });
    await merge.resolveAddedEmail(T, addr, COMPANY_A);

    // (1) deliberately-wrong: assert the dup STILL exists (it does NOT) → must throw.
    let threw1 = false;
    try {
        check(await rowExists('contacts', 'id', D), 'SABOTAGE: dup should be gone but we assert present');
    } catch (e) {
        threw1 = e instanceof CheckError;
    }
    check(threw1, 'SABOTAGE FAILED TO TRIP (existence): the detector did not throw on a wrong expectation');

    // (2) deliberately-wrong: assert the dangling-FK count is 999 → must throw.
    let threw2 = false;
    try {
        const offenders = await danglingRefs(D, dupTl); // truly [] (clean)
        eq(offenders.length, 999, 'SABOTAGE: real dangling is 0 but we assert 999');
    } catch (e) {
        threw2 = e instanceof CheckError;
    }
    check(threw2, 'SABOTAGE FAILED TO TRIP (dangling): the detector did not throw on a wrong count');

    // (3) restore the TRUE expectations → green: dup gone, zero dangling.
    check(!(await rowExists('contacts', 'id', D)), 'restored: dup truly deleted');
    const offenders = await danglingRefs(D, dupTl);
    check(offenders.length === 0, `restored: zero dangling (found ${offenders.join(', ')})`);
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
    const selected = CASES.filter(c => sel === 'all' || c.section === sel || c.id === sel);
    if (selected.length === 0) {
        console.error(`No cases match --section=${sel}. Sections: ${[...new Set(CASES.map(c => c.section))].join(', ')}`);
        process.exit(2);
    }

    console.log(`CONTACT-EMAIL-MERGE-001 verify — DATABASE_URL=${process.env.DATABASE_URL}`);
    console.log(`Company A=${COMPANY_A} (seed, delta/tagged asserts) · Company B=${COMPANY_B} (tagged, temp)`);
    console.log(`Cases: ${sel} → ${selected.length}\n`);

    await cleanupAll();

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
    process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
    console.error('FATAL:', e);
    try { await db.pool.end(); } catch { /* noop */ }
    process.exit(1);
});
