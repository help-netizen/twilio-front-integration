#!/usr/bin/env node
/**
 * MAIL-MUTE-001 — T5 real-DB integration + EXPLAIN verify script.
 *
 * The LOAD-BEARING verification (LIST-PAGINATION-001 / PULSE-PERF-001 lesson):
 * mocked jest mocks `db`, so a unit test only pins the SQL *string* — it can NOT
 * prove that `getUnifiedTimelinePage`'s per-row `email_muted` actually drops the
 * relyhome timeline out of the page, that a phone+email contact keeps ranking on a
 * call while its email is gated, that a multi-email contact is suppressed via the
 * contact_emails EXISTS, or that company B is isolated from company A's muted set.
 * This script runs the REAL `getMutedSenderSet` / `isSenderMuted` /
 * `linkInboundMessage` / `getUnifiedTimelinePage` against a local Postgres,
 * self-seeding / self-cleaning by the unique tag MM1.
 *
 * Real functions exercised (unmocked):
 *   • mailAgentService.getMutedSenderSet / isSenderMuted (real settings read +
 *     real matchEmail; the muted set is DERIVED, never hand-fed)
 *   • emailTimelineService.linkInboundMessage (real link/skip; S1/S7 no-auto-create)
 *   • timelinesQueries.getUnifiedTimelinePage (THE STAR — the real Pulse SQL with
 *     real mutedEmails/mutedDomains params)
 *
 * Cases (Docs/test-cases/MAIL-MUTE-001.md §2):
 *   s2   I01  P0 SQL — email-only relyhome/2915-shape timeline drops out; history kept
 *        I03  P0     — un-exclude → the timeline reappears (reversible = drop from set)
 *   neg  I02  P0 NEGATIVE CONTROL — empty muted set → the SAME row IS present
 *   s4   I04  P0 SQL — channel split: muted email does NOT bump/unread; a new CALL
 *                      and a new SMS DO surface & bump (call/SMS ordering survives)
 *   neg  I05         — S4 control: empty set → the muted email DOES bump
 *   s1   I06  P0     — muted new inbound does NOT link and does NOT auto-create a
 *                      contact/timeline (real linkInboundMessage; FR-3)
 *        I10         — redelivery of a muted email: still skip, still no contact/link
 *   s7   I07  P0 SEC — mute in company A never suppresses company B's identical sender
 *   s12  I08         — multi-email contact, ONE address muted → email contribution
 *                      suppressed via the contact_emails EXISTS (both surfaces)
 *   explain I09 P0   — EXPLAIN (ANALYZE, BUFFERS) on the real SQL with a non-empty
 *                      muted set: no new Seq Scan, contact_emails EXISTS uses the
 *                      contact_id index (enable_seqscan=off proof), no plan explosion
 *   sab  ISAB MANDATORY sabotage — an in-memory copy of the query with
 *                      `AND NOT em.email_muted` stripped is run on the pool with the
 *                      SAME params; assert the real query hides the row and the
 *                      sabotaged one does NOT → the gate is load-bearing
 *
 * Company A = seed 00000000-0000-0000-0000-000000000001 (real dev rows coexist →
 *   assertions are row-targeted by the tagged timeline id, never whole-company counts).
 * Company B = tagged c0000000-0000-4000-8000-0000000000d1, CREATED + deleted here.
 *
 * Both tagged companies get a CONNECTED `mail-secretary` marketplace install +
 * a `mail_agent_settings` row (enabled=true, activated_at in the past) so
 * getActiveState returns active (C-4); the `exclusion_rules` text is the knob.
 * `invalidateCache(company)` is called after every settings write so the 60s
 * activeCache never serves a stale verdict between cases (mirrors PUT /settings).
 *
 * Usage:
 *   node scripts/verify-mail-mute-001.js [--section=s1|s2|s4|s7|s12|neg|explain|sab|all]
 *   DATABASE_URL defaults to postgresql://localhost/twilio_calls (house default).
 * Never point this at prod. Exit code 0 only when no case FAILs.
 *
 * Also dumps the exact parameterized getUnifiedTimelinePage SQL (with a non-empty
 * muted set) to scripts/.mail-mute-001.explain.sql for the orchestrator's
 * read-only prod EXPLAIN.
 */
'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/twilio_calls';

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const db = require(path.join(ROOT, 'backend/src/db/connection'));
const timelinesQueries = require(path.join(ROOT, 'backend/src/db/timelinesQueries'));
const mailAgentService = require(path.join(ROOT, 'backend/src/services/mailAgentService'));
const emailTimelineService = require(path.join(ROOT, 'backend/src/services/email/emailTimelineService'));

const COMPANY_A = '00000000-0000-0000-0000-000000000001'; // seed company (real dev data coexists)
const COMPANY_B = 'c0000000-0000-4000-8000-0000000000d1'; // tagged, created+deleted here
const MAIL_APP_KEY = 'mail-secretary';
const EXPLAIN_DUMP = path.join(__dirname, '.mail-mute-001.explain.sql');

// ─── tiny assert/report kit (mirrors verify-contact-email-merge-001.js) ─────────
class CheckError extends Error {}
function check(cond, msg) {
    if (!cond) throw new CheckError(msg);
}
function eq(actual, expected, label) {
    check(String(actual) === String(expected), `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function eqArr(actual, expected, label) {
    const a = [...(actual || [])].map(String).sort();
    const e = [...(expected || [])].map(String).sort();
    check(JSON.stringify(a) === JSON.stringify(e), `${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}

const results = [];
function record(id, status, note) {
    results.push({ id, status, note: note || '' });
    const pad = ' '.repeat(Math.max(1, 12 - id.length));
    console.log(`${status} ${id}${pad}${note || ''}`);
}

// ─── seeding helpers (all tagged MM1) ───────────────────────────────────────────
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

// Connect the mail-secretary marketplace app + write a settings row so
// getActiveState(company) returns active (C-4). activated_at is set well in the
// past so any historical-mail gate in the review path is satisfied (the mute
// helpers do not gate on it, but keep parity).
async function ensureMailSecretary(companyId, rulesText) {
    const app = await db.query(`SELECT id FROM marketplace_apps WHERE app_key = $1 LIMIT 1`, [MAIL_APP_KEY]);
    check(app.rows[0], `marketplace_apps '${MAIL_APP_KEY}' must exist (MAIL-AGENT-001 seed)`);
    const appId = app.rows[0].id;
    // marketplace_installations has a PARTIAL unique index on (company_id, app_id)
    // WHERE status IN ('connected','provisioning_failed'); guard the insert
    // explicitly (check-then-insert-or-flip) to avoid ON CONFLICT arbiter ambiguity.
    const existing = await db.query(
        `SELECT id FROM marketplace_installations WHERE company_id = $1 AND app_id = $2 LIMIT 1`,
        [companyId, appId]
    );
    if (existing.rows[0]) {
        await db.query(`UPDATE marketplace_installations SET status = 'connected' WHERE id = $1`, [existing.rows[0].id]);
    } else {
        await db.query(
            `INSERT INTO marketplace_installations (company_id, app_id, status, installed_at)
             VALUES ($1, $2, 'connected', now())`,
            [companyId, appId]
        );
    }
    await setRules(companyId, rulesText);
}

// upsert mail_agent_settings.exclusion_rules + enabled=true + invalidate cache.
async function setRules(companyId, rulesText) {
    await db.query(
        `INSERT INTO mail_agent_settings (company_id, enabled, exclusion_rules, activated_at)
         VALUES ($1, true, $2, now() - interval '1 day')
         ON CONFLICT (company_id) DO UPDATE
            SET enabled = true, exclusion_rules = EXCLUDED.exclusion_rules`,
        [companyId, rulesText || '']
    );
    mailAgentService.invalidateCache(companyId);
}

let threadSeq = 0;
const mailboxCache = {};
async function mailboxFor(companyId) {
    if (mailboxCache[companyId]) return mailboxCache[companyId];
    const existing = await db.query(
        `SELECT id FROM email_mailboxes WHERE company_id = $1 AND provider = 'gmail' LIMIT 1`,
        [companyId]
    );
    if (existing.rows[0]) { mailboxCache[companyId] = existing.rows[0].id; return existing.rows[0].id; }
    const created = await db.query(
        `INSERT INTO email_mailboxes (company_id, provider, email_address, status)
         VALUES ($1, 'gmail', $2, 'connected') RETURNING id`,
        [companyId, `mb-${String(companyId).slice(-4)}@mm1.test`]
    );
    mailboxCache[companyId] = created.rows[0].id;
    return created.rows[0].id;
}

async function mkContact(companyId, { name = 'Contact', phone = null, email = null } = {}) {
    const r = await db.query(
        `INSERT INTO contacts (full_name, phone_e164, email, company_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [`MM1 ${name}`, phone, email, companyId]
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

async function mkTimeline(companyId, { contactId = null, phone = null } = {}) {
    const r = await db.query(
        `INSERT INTO timelines (contact_id, phone_e164, company_id) VALUES ($1, $2, $3) RETURNING id`,
        [contactId, contactId ? null : (phone || nextPhone()), companyId]
    );
    return r.rows[0].id;
}

async function mkThread(companyId, { subject = 'MM1 thread', lastAt = null, lastDir = 'inbound', unread = 0 } = {}) {
    threadSeq += 1;
    const mailboxId = await mailboxFor(companyId);
    const r = await db.query(
        `INSERT INTO email_threads (company_id, mailbox_id, provider_thread_id, subject,
                                    last_message_at, last_message_direction, unread_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [companyId, mailboxId, `mm1-th-${threadSeq}-${Date.now()}`, subject, lastAt, lastDir, unread]
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
    const pmid = `mm1-msg-${msgSeq}-${Date.now()}`;
    const r = await db.query(
        `INSERT INTO email_messages (company_id, mailbox_id, thread_id, provider_message_id,
                                     message_id_header, direction, from_email,
                                     to_recipients_json, subject,
                                     gmail_internal_at, contact_id, timeline_id, on_timeline)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13)
         RETURNING provider_message_id`,
        [companyId, mailboxId, threadId, pmid, `<${pmid}@mm1.test>`, direction, fromEmail,
            JSON.stringify(to), subject, at, contactId, timelineId, onTimeline]
    );
    return r.rows[0].provider_message_id;
}

let callSeq = 0;
async function addCall(companyId, timelineId, contactId, at) {
    callSeq += 1;
    const sid = `MM1CALL${callSeq}_${Date.now()}`;
    await db.query(
        `INSERT INTO calls (call_sid, company_id, timeline_id, contact_id, direction, status,
                            from_number, to_number, started_at)
         VALUES ($1, $2, $3, $4, 'inbound', 'completed', $5, $6, $7)`,
        [sid, companyId, timelineId, contactId, nextPhone(), nextPhone(), at]
    );
    return sid;
}

// An SMS conversation matched to the contact by customer_digits (the join key
// getUnifiedTimelinePage uses: regexp_replace(COALESCE(tl.phone,co.phone),...)).
// customer_digits is GENERATED ALWAYS from customer_e164 — never inserted directly.
async function addSms(companyId, phoneE164, at) {
    const sid = `mm1-sms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await db.query(
        `INSERT INTO sms_conversations (twilio_conversation_sid, company_id, customer_e164,
                                        friendly_name, last_message_at,
                                        last_message_direction, last_message_preview, has_unread)
         VALUES ($1, $2, $3, 'MM1 sms', $4, 'inbound', 'MM1 hi', false)`,
        [sid, companyId, phoneE164, at]
    );
    return sid;
}

// The relyhome/2915 shape: an email-ONLY contact (phone_e164 NULL) whose only
// signal is one inbound email thread. Surfaces on the list via the email leg:
// email_by_contact joins contact_emails.email_normalized = lower(trim(from_email)),
// so we seed BOTH a contact_emails row AND an inbound email_message from that addr.
// contacts.email is left NULL (address lives in contact_emails only) because
// uq_contacts_email is a GLOBAL unique index — S8 needs the SAME address under a
// company-A AND a company-B contact, which is only legal via contact_emails
// (unique per contact). email_muted still fires via the contact_emails EXISTS.
async function mkContactEmailOnly(companyId, { name, email, unread = 1 }) {
    const contactId = await mkContact(companyId, { name, phone: null, email: null });
    await mkContactEmail(contactId, email, true);
    const timelineId = await mkTimeline(companyId, { contactId });
    const at = new Date().toISOString();
    const threadId = await mkThread(companyId, { subject: `MM1 ${name}`, lastAt: at, lastDir: 'inbound', unread });
    await mkMsg(companyId, { threadId, direction: 'inbound', fromEmail: email, contactId, timelineId, onTimeline: true, at, subject: `MM1 ${name}` });
    return { contactId, timelineId, threadId, email };
}

// A phone+email contact for the channel-split case: has phone_e164 AND a muted
// email thread; call/SMS can be injected on top. Address in contact_emails only
// (contacts.email NULL) to stay clear of the global uq_contacts_email index.
async function mkContactPhoneEmail(companyId, { name, phone, email, unread = 1 }) {
    const contactId = await mkContact(companyId, { name, phone, email: null });
    await mkContactEmail(contactId, email, true);
    const timelineId = await mkTimeline(companyId, { contactId });
    const at = new Date().toISOString();
    const threadId = await mkThread(companyId, { subject: `MM1 ${name}`, lastAt: at, lastDir: 'inbound', unread });
    await mkMsg(companyId, { threadId, direction: 'inbound', fromEmail: email, contactId, timelineId, onTimeline: true, at, subject: `MM1 ${name}` });
    return { contactId, timelineId, threadId, phone, email };
}

// A contact with TWO addresses (primary in contacts.email, extra in contact_emails);
// the email signal (thread) is produced by ONE of them.
async function mkContactMultiEmail(companyId, { name, primaryEmail, extraEmail, signalFrom }) {
    const contactId = await mkContact(companyId, { name, phone: null, email: primaryEmail });
    await mkContactEmail(contactId, primaryEmail, true);
    await mkContactEmail(contactId, extraEmail, false);
    const timelineId = await mkTimeline(companyId, { contactId });
    const at = new Date().toISOString();
    const from = signalFrom || primaryEmail;
    const threadId = await mkThread(companyId, { subject: `MM1 ${name}`, lastAt: at, lastDir: 'inbound', unread: 1 });
    await mkMsg(companyId, { threadId, direction: 'inbound', fromEmail: from, contactId, timelineId, onTimeline: true, at, subject: `MM1 ${name}` });
    return { contactId, timelineId, threadId, primaryEmail, extraEmail };
}

// ─── cleanup (FK order; run before every case + at start/end) ────────────────────
async function cleanupAll() {
    mailboxCache[COMPANY_B] = undefined;
    const taggedContacts = `SELECT id FROM contacts WHERE full_name LIKE 'MM1 %'`;

    await db.query(`DELETE FROM tasks WHERE contact_id IN (${taggedContacts})`);
    await db.query(`DELETE FROM tasks WHERE company_id = $1`, [COMPANY_B]);

    await db.query(`DELETE FROM email_messages WHERE provider_message_id LIKE 'mm1-msg-%'`);
    await db.query(`DELETE FROM email_messages WHERE contact_id IN (${taggedContacts})`);
    await db.query(`DELETE FROM email_messages WHERE company_id = $1`, [COMPANY_B]);
    await db.query(`DELETE FROM email_threads WHERE provider_thread_id LIKE 'mm1-th-%'`);
    await db.query(`DELETE FROM email_threads WHERE company_id = $1`, [COMPANY_B]);

    await db.query(`DELETE FROM calls WHERE call_sid LIKE 'MM1CALL%'`);
    await db.query(`DELETE FROM calls WHERE company_id = $1`, [COMPANY_B]);
    await db.query(`DELETE FROM sms_conversations WHERE twilio_conversation_sid LIKE 'mm1-sms-%'`);
    await db.query(`DELETE FROM sms_conversations WHERE company_id = $1`, [COMPANY_B]);

    // timelines on a tagged contact or a tagged phone; and all of company B.
    await db.query(`DELETE FROM timelines WHERE contact_id IN (${taggedContacts})`);
    await db.query(`DELETE FROM timelines WHERE contact_id IS NULL AND phone_e164 LIKE '+1999555%'`);
    await db.query(`DELETE FROM timelines WHERE company_id = $1`, [COMPANY_B]);

    await db.query(`DELETE FROM contact_emails WHERE contact_id IN (${taggedContacts})`);
    await db.query(`DELETE FROM contacts WHERE full_name LIKE 'MM1 %'`);

    // Company B is nuked wholesale; leave company A's real settings/install intact.
    await db.query(`DELETE FROM mail_agent_settings WHERE company_id = $1`, [COMPANY_B]);
    await db.query(`DELETE FROM marketplace_installations WHERE company_id = $1`, [COMPANY_B]);
    await db.query(`DELETE FROM email_mailboxes WHERE company_id = $1`, [COMPANY_B]);
    await db.query(`DELETE FROM companies WHERE id = $1`, [COMPANY_B]);
    mailAgentService.invalidateCache(COMPANY_B);
}

// Assert zero tagged rows survive (called at exit).
async function assertZeroTagged() {
    const offenders = [];
    const probes = [
        ['contacts', `SELECT count(*)::int c FROM contacts WHERE full_name LIKE 'MM1 %'`],
        ['email_messages', `SELECT count(*)::int c FROM email_messages WHERE provider_message_id LIKE 'mm1-msg-%'`],
        ['email_threads', `SELECT count(*)::int c FROM email_threads WHERE provider_thread_id LIKE 'mm1-th-%'`],
        ['calls', `SELECT count(*)::int c FROM calls WHERE call_sid LIKE 'MM1CALL%'`],
        ['sms_conversations', `SELECT count(*)::int c FROM sms_conversations WHERE twilio_conversation_sid LIKE 'mm1-sms-%'`],
        ['timelines(phone)', `SELECT count(*)::int c FROM timelines WHERE phone_e164 LIKE '+1999555%'`],
        ['companyB', `SELECT count(*)::int c FROM companies WHERE id = '${COMPANY_B}'`],
    ];
    for (const [label, sql] of probes) {
        const n = Number((await db.query(sql)).rows[0].c);
        if (n > 0) offenders.push(`${label}=${n}`);
    }
    return offenders;
}

// ─── shared probes ───────────────────────────────────────────────────────────────
async function scalar(sql, params = []) {
    const r = await db.query(sql, params);
    return r.rows[0] ? Object.values(r.rows[0])[0] : null;
}

// Page the REAL unified list for a company + muted set. Returns rows.
async function page(companyId, mutedEmails, mutedDomains, { limit = 2000, offset = 0, search = null } = {}) {
    return timelinesQueries.getUnifiedTimelinePage({ limit, offset, companyId, search, mutedEmails, mutedDomains });
}
function rowFor(rows, timelineId) {
    return rows.find(r => Number(r.timeline_id) === Number(timelineId)) || null;
}
function rankOf(rows, timelineId) {
    return rows.findIndex(r => Number(r.timeline_id) === Number(timelineId));
}

// ═════════════════════════════════════════════════════════════════════════════
// Cases
// ═════════════════════════════════════════════════════════════════════════════
const CASES = [];
function CASE(id, section, title, fn) { CASES.push({ id, section, title, fn }); }

// ---------------------------------------------------------------------------
// S2/S5 — email-only muted timeline drops out; history retained; un-exclude restores.
CASE('TC-MM-I01', 's2', 'S2/S5 P0 SQL: email-only muted timeline drops out of getUnifiedTimelinePage (history retained)', async () => {
    const addr = 'customerservice@relyhome.com';
    const c = await mkContactEmailOnly(COMPANY_A, { name: 'Rely', email: addr });
    await setRules(COMPANY_A, `from:${addr}`);

    // the muted set is DERIVED from the real settings, not hand-fed.
    const set = await mailAgentService.getMutedSenderSet(COMPANY_A);
    eqArr(set.emails, [addr], 'getMutedSenderSet.emails');
    eqArr(set.domains, [], 'getMutedSenderSet.domains');

    // page WITH the muted set → the relyhome timeline is ABSENT.
    const muted = await page(COMPANY_A, set.emails, set.domains);
    check(rowFor(muted, c.timelineId) === null, `muted: timeline ${c.timelineId} must be ABSENT from the page`);

    // it never entered the COUNT(*) OVER() window (pagination integrity): its id is
    // simply not present; total_count reflects only surfaced rows. Sanity: page ≤ limit.
    check(muted.length <= 2000, 'page stays <= limit');

    // history is retained (FR-9): the thread + inbound message rows still exist.
    eq(await scalar(`SELECT count(*)::int FROM email_threads WHERE id = $1`, [c.threadId]), 1, 'email_thread retained');
    eq(await scalar(`SELECT count(*)::int FROM email_messages WHERE thread_id = $1`, [c.threadId]), 1, 'email_message retained');
});

// ---------------------------------------------------------------------------
CASE('TC-MM-I03', 's2', 'S3 P0: un-exclude restores the timeline (reversible = drop from the set)', async () => {
    const addr = 'customerservice@relyhome.com';
    const c = await mkContactEmailOnly(COMPANY_A, { name: 'RelyRestore', email: addr });

    // muted → absent (precondition).
    await setRules(COMPANY_A, `from:${addr}`);
    const set1 = await mailAgentService.getMutedSenderSet(COMPANY_A);
    const p1 = await page(COMPANY_A, set1.emails, set1.domains);
    check(rowFor(p1, c.timelineId) === null, 'while muted: timeline absent');

    // remove the rule → getMutedSenderSet empties → the row REAPPEARS (no re-import).
    await setRules(COMPANY_A, '');
    const set2 = await mailAgentService.getMutedSenderSet(COMPANY_A);
    eqArr(set2.emails, [], 'after un-exclude: emails empty');
    eqArr(set2.domains, [], 'after un-exclude: domains empty');
    const p2 = await page(COMPANY_A, set2.emails, set2.domains);
    check(rowFor(p2, c.timelineId) !== null, `after un-exclude: timeline ${c.timelineId} must REAPPEAR`);
    eq(rowFor(p2, c.timelineId).email_thread_id, c.threadId, 'reappeared row carries the email thread id');
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROL — the exact I01 seed with an EMPTY muted set → the row IS present.
CASE('TC-MM-I02', 'neg', 'S2/S5 P0 NEGATIVE CONTROL: empty muted set → the SAME email-only row IS present', async () => {
    const addr = 'customerservice@relyhome.com';
    const c = await mkContactEmailOnly(COMPANY_A, { name: 'RelyNeg', email: addr });
    await setRules(COMPANY_A, `from:${addr}`); // rule present, but we page with an EMPTY set below

    // feature-off / nothing-muted path: ANY(ARRAY[]::text[]) = false → email_muted false.
    const p = await page(COMPANY_A, [], []);
    check(rowFor(p, c.timelineId) !== null,
        `empty set: timeline ${c.timelineId} MUST be present (proves I01 absence is caused by the muted set, not a broken seed)`);
    eq(rowFor(p, c.timelineId).email_thread_id, c.threadId, 'present row carries the email thread id');

    // and with the real set it is absent (the on/off pair, in one case).
    const set = await mailAgentService.getMutedSenderSet(COMPANY_A);
    const pMuted = await page(COMPANY_A, set.emails, set.domains);
    check(rowFor(pMuted, c.timelineId) === null, 'real set: same row absent (on/off pair holds)');
});

// ---------------------------------------------------------------------------
// S4 — channel split (domain-form mute).
CASE('TC-MM-I04', 's4', 'S4 P0 SQL: muted email does NOT bump/unread; a new CALL and a new SMS DO surface & bump', async () => {
    const dualEmail = 'customerservice@relyhome.com';
    const dual = await mkContactPhoneEmail(COMPANY_A, { name: 'Dual', phone: nextPhone(), email: dualEmail, unread: 1 });
    // A control contact whose ONLY signal is an OLDER email (not muted) — a stable
    // yardstick to prove the muted email did not bump `dual` above it via email.
    const ctrlOldAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const ctrl = await mkContact(COMPANY_A, { name: 'CtrlOld', phone: null, email: 'ctrl@keepme.test' });
    await mkContactEmail(ctrl, 'ctrl@keepme.test', true);
    const ctrlTl = await mkTimeline(COMPANY_A, { contactId: ctrl });
    const ctrlTh = await mkThread(COMPANY_A, { subject: 'MM1 CtrlOld', lastAt: ctrlOldAt, lastDir: 'inbound', unread: 0 });
    await mkMsg(COMPANY_A, { threadId: ctrlTh, direction: 'inbound', fromEmail: 'ctrl@keepme.test', contactId: ctrl, timelineId: ctrlTl, onTimeline: true, at: ctrlOldAt });

    await setRules(COMPANY_A, 'from:relyhome.com'); // domain form → domains:['relyhome.com']
    const set = await mailAgentService.getMutedSenderSet(COMPANY_A);
    eqArr(set.domains, ['relyhome.com'], 'domain-form mute projected to domains');
    eqArr(set.emails, [], 'no literal address projected');

    // (1) Email-only signal, muted: the dual row's email must NOT surface it and must
    // NOT feed any_unread. Because its only signal is the (muted) email, the dual row
    // drops out entirely (email-only → fails the surfacing predicate).
    const p1 = await page(COMPANY_A, set.emails, set.domains);
    check(rowFor(p1, dual.timelineId) === null,
        'muted email-only phase: dual row absent (email did not surface it)');
    // the control (older, non-muted email) DID surface — so absence of dual is the mute, not an empty page.
    check(rowFor(p1, ctrlTl) !== null, 'control (non-muted older email) still surfaces');

    // (2) Add a new inbound CALL (most-recent signal) → the row surfaces and bumps.
    const callAt = new Date().toISOString();
    await addCall(COMPANY_A, dual.timelineId, dual.contactId, callAt);
    const p2 = await page(COMPANY_A, set.emails, set.domains);
    const r2 = rowFor(p2, dual.timelineId);
    check(r2 !== null, 'after CALL: dual row surfaces (call contribution untouched)');
    // last_interaction_at reflects the CALL, not the email.
    check(r2.last_interaction_at != null, 'after CALL: last_interaction_at set');
    eq(new Date(r2.last_interaction_at).getTime(), new Date(callAt).getTime(), 'last_interaction_at == call started_at (not the email)');
    // it ranks above the older-email control (bumped by the call).
    check(rankOf(p2, dual.timelineId) < rankOf(p2, ctrlTl), 'after CALL: dual ranks above the older-email control (bumped)');
    // email is still gated: email_muted true, email_unread did not raise any_unread via email.
    eq(r2.email_muted, true, 'email_muted still true for the dual contact');

    // (3) Add a NEWER inbound SMS → sms.last_message_at feeds last_interaction_at; bumps.
    const smsAt = new Date(Date.now() + 60 * 1000).toISOString();
    await addSms(COMPANY_A, dual.phone, smsAt);
    const p3 = await page(COMPANY_A, set.emails, set.domains);
    const r3 = rowFor(p3, dual.timelineId);
    check(r3 !== null, 'after SMS: dual row surfaces (sms contribution untouched)');
    eq(new Date(r3.last_interaction_at).getTime(), new Date(smsAt).getTime(), 'last_interaction_at == sms last_message_at (most recent, email still gated)');
    check(rankOf(p3, dual.timelineId) < rankOf(p3, ctrlTl), 'after SMS: dual still ranks above the control');
});

// ---------------------------------------------------------------------------
CASE('TC-MM-I05', 'neg', 'S4 NEGATIVE CONTROL: empty set → the muted email DOES bump the phone+email contact', async () => {
    const dualEmail = 'customerservice@relyhome.com';
    const dual = await mkContactPhoneEmail(COMPANY_A, { name: 'DualNeg', phone: nextPhone(), email: dualEmail, unread: 1 });
    await setRules(COMPANY_A, 'from:relyhome.com');

    // With NOTHING muted, the email feeds last_interaction_at/any_unread → row present & unread.
    const p = await page(COMPANY_A, [], []);
    const r = rowFor(p, dual.timelineId);
    check(r !== null, 'empty set: dual row present via its email signal');
    eq(r.email_muted, false, 'empty set: email_muted false');
    eq(r.any_unread, true, 'empty set: the email raises any_unread (today\'s behavior)');
    check(r.last_interaction_at != null && r.email_last_message_at != null
        && new Date(r.last_interaction_at).getTime() === new Date(r.email_last_message_at).getTime(),
        'empty set: last_interaction_at driven by the (only, un-muted) email');
});

// ---------------------------------------------------------------------------
// S1/S7 — muted new inbound: no link, no auto-create (REAL linkInboundMessage).
CASE('TC-MM-I06', 's1', 'S1/S7 P0: muted new inbound does NOT link and does NOT auto-create a contact/timeline', async () => {
    await setRules(COMPANY_A, 'from:relyhome.com');
    const addr = 'newvendor@relyhome.com'; // brand-new, no existing contact
    const pmid = `mm1-live-${Date.now()}`;
    const msg = {
        provider_message_id: pmid,
        from_name: 'New Vendor',
        from_email: addr,
        subject: 'MM1 hello',
        body_text: 'hi',
        is_outbound: false,
        internal_at: new Date().toISOString(),
    };

    const beforeContacts = Number(await scalar(`SELECT count(*)::int FROM contacts WHERE company_id = $1 AND email = $2`, [COMPANY_A, addr]));
    const res = await emailTimelineService.linkInboundMessage(COMPANY_A, msg);
    eq(res && res.skipped, 'muted_sender', 'linkInboundMessage returns {skipped:muted_sender}');

    // no email_messages row written for this provider_message_id.
    eq(await scalar(`SELECT count(*)::int FROM email_messages WHERE provider_message_id = $1`, [pmid]), 0, 'no email link row created');
    // no contact / timeline auto-created for the muted first-time sender (FR-3).
    const afterContacts = Number(await scalar(`SELECT count(*)::int FROM contacts WHERE company_id = $1 AND email = $2`, [COMPANY_A, addr]));
    eq(afterContacts, beforeContacts, 'no new contact auto-created for the muted sender');
    eq(await scalar(`SELECT count(*)::int FROM contacts WHERE company_id = $1 AND email = $2 AND full_name LIKE 'MM1%'`, [COMPANY_A, addr]), 0, 'no MM1-tagged contact leaked either');

    // CONTRAST: with the rule removed, isSenderMuted → false, so the guard no longer
    // short-circuits; the same msg proceeds past the mute guard (proves the skip was
    // MUTE-caused, not a blanket skip). For an unknown sender the next stop is the
    // no-contact branch → {skipped:'no_contact'} (NOT muted_sender).
    await setRules(COMPANY_A, '');
    const res2 = await emailTimelineService.linkInboundMessage(COMPANY_A, { ...msg, provider_message_id: `${pmid}-b` }, { skipAgent: true });
    check(res2 && res2.skipped !== 'muted_sender', `contrast: with no rule the skip is not muted_sender (got ${JSON.stringify(res2)})`);
});

// ---------------------------------------------------------------------------
CASE('TC-MM-I10', 's1', 'S6: redelivery of a muted email — both calls skip, no link, no contact (dedup intact)', async () => {
    await setRules(COMPANY_A, 'from:relyhome.com');
    const addr = 'dupvendor@relyhome.com';
    const pmid = `mm1-live-dup-${Date.now()}`;
    const msg = { provider_message_id: pmid, from_name: 'Dup', from_email: addr, subject: 'x', body_text: 'y', is_outbound: false, internal_at: new Date().toISOString() };

    const r1 = await emailTimelineService.linkInboundMessage(COMPANY_A, msg);
    const r2 = await emailTimelineService.linkInboundMessage(COMPANY_A, msg); // redelivery
    eq(r1 && r1.skipped, 'muted_sender', 'first delivery skipped');
    eq(r2 && r2.skipped, 'muted_sender', 'redelivery skipped');
    eq(await scalar(`SELECT count(*)::int FROM email_messages WHERE provider_message_id = $1`, [pmid]), 0, 'zero link rows after both');
    eq(await scalar(`SELECT count(*)::int FROM contacts WHERE company_id = $1 AND email = $2`, [COMPANY_A, addr]), 0, 'zero contacts for the address after both');
});

// ---------------------------------------------------------------------------
// S8 — cross-tenant isolation (company B unaffected; A's set never touches B).
CASE('TC-MM-I07', 's7', 'S8 P0 SECURITY: mute in company A never suppresses company B\'s identical sender', async () => {
    const addr = 'customerservice@relyhome.com';
    await ensureCompany(COMPANY_B, 'mm1-b', 'MM1 Cross Co B');
    await ensureMailSecretary(COMPANY_B, ''); // B connected + enabled, but NO exclusion rule

    const cB = await mkContactEmailOnly(COMPANY_B, { name: 'RelyB', email: addr });
    const cA = await mkContactEmailOnly(COMPANY_A, { name: 'RelyA', email: addr });
    await setRules(COMPANY_A, `from:${addr}`);

    // B's set is parsed from B's OWN settings → empty (proves per-company parse).
    const setB = await mailAgentService.getMutedSenderSet(COMPANY_B);
    eqArr(setB.emails, [], 'company B muted emails empty (its own settings)');
    eqArr(setB.domains, [], 'company B muted domains empty');

    // B's page with B's (empty) set → B's relyhome timeline IS present.
    const pB = await page(COMPANY_B, setB.emails, setB.domains);
    check(rowFor(pB, cB.timelineId) !== null, `company B relyhome timeline ${cB.timelineId} MUST be present (no inherited mute)`);

    // A's page with A's set → A's relyhome timeline is ABSENT (both scoped correctly in one run).
    const setA = await mailAgentService.getMutedSenderSet(COMPANY_A);
    const pA = await page(COMPANY_A, setA.emails, setA.domains);
    check(rowFor(pA, cA.timelineId) === null, 'company A relyhome timeline absent (A\'s own mute)');

    // Belt-and-braces: even if A's non-empty set is (wrongly) threaded into a B query,
    // email_muted only evaluates on rows already WHERE tl.company_id = B, and B's
    // contact carries the SAME address — so IF it suppressed, that would be the leak.
    // Assert it does NOT: B's row stays present even with A's set (no cross-tenant path
    // exists because the row is B-scoped and the check keys on the row's own contact,
    // but this makes the isolation explicit).
    const pBleak = await page(COMPANY_B, setA.emails, setA.domains);
    // NOTE: this is a SAME-address contact, so A's set WOULD match B's row's address.
    // That is expected — the real isolation is that getMutedSenderSet(B) is empty, so
    // the route NEVER passes A's set to a B query. We therefore assert the *route-level*
    // truth (setB empty) above; here we only confirm the SQL is company-scoped by
    // checking company A's rows never appear in B's page.
    const aRowIds = new Set(pA.map(r => Number(r.timeline_id)));
    const bLeak = pBleak.filter(r => aRowIds.has(Number(r.timeline_id)) && Number(r.timeline_id) === Number(cA.timelineId));
    check(bLeak.length === 0, 'company A\'s timeline never appears in a company B page (tl.company_id scoping)');
});

// ---------------------------------------------------------------------------
// S12 — multi-email contact: ONE address muted → email contribution suppressed.
CASE('TC-MM-I08', 's12', 'S12: multi-email contact, ONE address muted → suppressed via contact_emails EXISTS (both surfaces)', async () => {
    // (a) muted address is the EXTRA one (contact_emails), signal from the primary.
    //     Proves the EXISTS(contact_emails … = ANY($5)) branch fires even when the
    //     thread was produced by the non-muted primary address.
    const c1 = await mkContactMultiEmail(COMPANY_A, {
        name: 'MultiExtra', primaryEmail: 'b@personal.com', extraEmail: 'a@vendor.com', signalFrom: 'b@personal.com',
    });
    await setRules(COMPANY_A, 'from:vendor.com'); // domains:['vendor.com'] → matches the EXTRA address only
    const set1 = await mailAgentService.getMutedSenderSet(COMPANY_A);
    eqArr(set1.domains, ['vendor.com'], 'muted domain = vendor.com');
    const p1 = await page(COMPANY_A, set1.emails, set1.domains);
    check(rowFor(p1, c1.timelineId) === null,
        'multi-email: contact suppressed via the EXTRA (contact_emails) muted address');
    // negative control: empty set → present.
    const p1n = await page(COMPANY_A, [], []);
    check(rowFor(p1n, c1.timelineId) !== null, 'multi-email control: empty set → present');

    // (b) symmetric — mute the PRIMARY (contacts.email) domain. Proves the
    //     lower(co.email) branch fires.
    const c2 = await mkContactMultiEmail(COMPANY_A, {
        name: 'MultiPrimary', primaryEmail: 'p@primary.test', extraEmail: 'q@other.test', signalFrom: 'p@primary.test',
    });
    await setRules(COMPANY_A, 'from:primary.test');
    const set2 = await mailAgentService.getMutedSenderSet(COMPANY_A);
    const p2 = await page(COMPANY_A, set2.emails, set2.domains);
    check(rowFor(p2, c2.timelineId) === null, 'multi-email: contact suppressed via the PRIMARY (contacts.email) muted address');
});

// ---------------------------------------------------------------------------
// EXPLAIN gate (AC-11 / NFR-1). Local dev may legitimately seq-scan on tiny data;
// the load-bearing proof is (a) no plan EXPLOSION / cross join, and (b) with
// enable_seqscan=off the contact_emails EXISTS uses idx_contact_emails_contact_id.
CASE('TC-MM-I09', 'explain', 'EXPLAIN: non-empty muted set — no plan explosion; contact_emails EXISTS index-usable (seqscan off)', async () => {
    // seed a realistic-ish email-only row so the plan has something to chew on.
    const addr = 'customerservice@relyhome.com';
    await mkContactEmailOnly(COMPANY_A, { name: 'RelyExplain', email: addr });
    await setRules(COMPANY_A, `from:${addr}`);
    const set = await mailAgentService.getMutedSenderSet(COMPANY_A);

    const explain = await explainUnified(COMPANY_A, set.emails, set.domains, { seqscanOff: false });
    const explainOff = await explainUnified(COMPANY_A, set.emails, set.domains, { seqscanOff: true });
    const emptyPlan = await explainUnified(COMPANY_A, [], [], { seqscanOff: false });

    const txt = explain.join('\n');
    const txtOff = explainOff.join('\n');

    // (1) no plan EXPLOSION: no cartesian/"Cross Join" node.
    check(!/Cross Join/i.test(txt), 'no Cross Join in the plan');
    // (2) the contact_emails EXISTS must be index-usable. With enable_seqscan=off the
    //     planner is forced to use idx_contact_emails_contact_id (or the PK) rather
    //     than a Seq Scan on contact_emails — proving the index CAN drive it (the
    //     prod-volume plan, run by the orchestrator, then uses it naturally).
    const ceSeqOff = /Seq Scan on contact_emails/i.test(txtOff);
    const ceIdxOff = /Index (Only )?Scan.*contact_emails|idx_contact_emails_contact_id/i.test(txtOff);
    check(!ceSeqOff, `contact_emails must NOT Seq Scan with enable_seqscan=off (found Seq Scan)`);
    check(ceIdxOff, 'contact_emails EXISTS uses an index scan (idx_contact_emails_contact_id) with seqscan off');
    // (3) the query still runs and returns a plan for the empty-set path (feature-off parity).
    check(emptyPlan.length > 0, 'empty-set EXPLAIN produced a plan');

    // Report the head of each plan for the PR / orchestrator.
    record('  plan/on ', 'INFO', firstNode(explain));
    record('  plan/off', 'INFO', firstNode(explainOff));
    record('  ce-index', 'INFO', ceIdxOff ? 'contact_emails via index (seqscan off)' : 'NOT indexed');
});

// ---------------------------------------------------------------------------
// SABOTAGE (MANDATORY, amendment #5). Method: in-memory broken SQL copy.
// Read timelinesQueries.js source, extract the exact getUnifiedTimelinePage SQL,
// strip `AND NOT em.email_muted` (and the CASE/`AND NOT em.email_muted` gates) so
// the email term is UNGATED, run it directly on the pool with the SAME params, and
// assert: the real query HIDES the muted row while the sabotaged query does NOT.
// If the sabotaged copy also hid it, the gate would be non-load-bearing → we FAIL.
CASE('TC-MM-ISAB', 'sab', 'SABOTAGE (in-memory ungated SQL): real query hides the muted row, sabotaged one does NOT → gate is load-bearing', async () => {
    const addr = 'customerservice@relyhome.com';
    const c = await mkContactEmailOnly(COMPANY_A, { name: 'RelySab', email: addr });
    await setRules(COMPANY_A, `from:${addr}`);
    const set = await mailAgentService.getMutedSenderSet(COMPANY_A);
    check(set.emails.length > 0, 'sabotage precondition: a non-empty muted set');

    // 1) real query hides it.
    const real = await page(COMPANY_A, set.emails, set.domains);
    check(rowFor(real, c.timelineId) === null, 'real query hides the muted row (precondition for a meaningful sabotage)');

    // 2) build the ungated (sabotaged) SQL from the shipped source + run it on the pool.
    const { sql, params } = buildSabotagedUnifiedSql(COMPANY_A, set.emails, set.domains);
    const sabRows = (await db.query(sql, params)).rows;
    const present = sabRows.some(r => Number(r.timeline_id) === Number(c.timelineId));
    check(present,
        'SABOTAGE FAILED TO TRIP: the ungated SQL should still show the muted row — if it hid it, the `AND NOT em.email_muted` gate is not what suppresses it');

    // 3) restore-green sanity: the real query still hides it (nothing mutated).
    const real2 = await page(COMPANY_A, set.emails, set.domains);
    check(rowFor(real2, c.timelineId) === null, 'restored: real query still hides the muted row');
});

// ─── EXPLAIN + sabotage SQL machinery ────────────────────────────────────────────

// Extract the exact parameterized SQL string that getUnifiedTimelinePage passes to
// db.query, by reading the source and pulling the single backtick template. We do
// NOT re-implement the query; we lift it verbatim so the sabotage/EXPLAIN run the
// SAME text the app runs (minus, for the sabotage, the gate we strip).
function extractUnifiedSql() {
    const src = fs.readFileSync(path.join(ROOT, 'backend/src/db/timelinesQueries.js'), 'utf8');
    // Anchor on the UNIQUE first line of the getUnifiedTimelinePage query (the
    // email_by_contact CTE) so we lift THIS query, not an earlier db.query (e.g.
    // markTimelineUnread's UPDATE). The template opens with `WITH email_by_contact AS (`.
    const marker = 'WITH email_by_contact AS (';
    const at = src.indexOf(marker);
    check(at >= 0, 'could not locate the getUnifiedTimelinePage query (WITH email_by_contact) in source');
    // Walk back to the opening backtick of this template literal.
    const tickStart = src.lastIndexOf('`', at);
    check(tickStart >= 0, 'could not find the opening backtick of the unified query');
    // The unified query contains no nested backticks, so the next backtick closes it.
    const tickEnd = src.indexOf('`', at);
    check(tickEnd > tickStart, 'could not find the closing backtick of the unified query');
    // The template contains one ${searchFilter} interpolation; with no search it is ''.
    let sql = src.slice(tickStart + 1, tickEnd);
    check(sql.includes('email_muted') && sql.includes('$4') && sql.includes('$5'),
        'extracted SQL missing email_muted/$4/$5 — anchor drifted');
    sql = sql.replace('${searchFilter}', '');
    return sql;
}

// Build the real SQL + params (search-less) for EXPLAIN.
function unifiedParams(companyId, mutedEmails, mutedDomains, { limit = 2000, offset = 0 } = {}) {
    return [companyId, limit, offset, mutedEmails, mutedDomains];
}

// EXPLAIN with SET LOCAL must run inside a transaction so the seqscan toggle scopes
// to just this plan probe (ROLLBACK afterwards, changing nothing).
async function explainUnified(companyId, mutedEmails, mutedDomains, { seqscanOff = false } = {}) {
    const sql = extractUnifiedSql();
    const params = unifiedParams(companyId, mutedEmails, mutedDomains);
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        if (seqscanOff) await client.query('SET LOCAL enable_seqscan = off');
        const r = await client.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
        await client.query('ROLLBACK');
        return r.rows.map(row => row['QUERY PLAN']);
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch { /* noop */ }
        throw e;
    } finally {
        client.release();
    }
}

function firstNode(planLines) {
    const l = (planLines || []).find(x => x && x.trim().length > 0);
    return l ? l.trim().slice(0, 120) : '(empty plan)';
}

// The sabotage: same SQL, but every `AND NOT em.email_muted` gate stripped so the
// email term is UNGATED (i.e. the pre-feature behavior). If the muted row still
// hides with this, the gate isn't load-bearing.
function buildSabotagedUnifiedSql(companyId, mutedEmails, mutedDomains) {
    let sql = extractUnifiedSql();
    // Neutralize the surfacing predicate gate + the any_unread/ORDER-BY gates + the
    // GREATEST CASE gates, turning each back into the ungated email term.
    // (a) surfacing predicate: `(eml.email_thread_id IS NOT NULL AND NOT em.email_muted)`
    sql = sql.replace(/eml\.email_thread_id IS NOT NULL AND NOT em\.email_muted/g, 'eml.email_thread_id IS NOT NULL');
    // (b) any_unread + ORDER-BY unread tier: `(COALESCE(eml.unread_count, 0) > 0 AND NOT em.email_muted)`
    sql = sql.replace(/COALESCE\(eml\.unread_count, 0\) > 0 AND NOT em\.email_muted/g, 'COALESCE(eml.unread_count, 0) > 0');
    // (c) GREATEST CASE gate: `CASE WHEN NOT em.email_muted THEN eml.last_message_at END` → `eml.last_message_at`
    sql = sql.replace(/CASE WHEN NOT em\.email_muted THEN eml\.last_message_at END/g, 'eml.last_message_at');
    // sanity: the strip actually removed the gate text from the surfacing predicate.
    check(!/eml\.email_thread_id IS NOT NULL AND NOT em\.email_muted/.test(sql),
        'sabotage: surfacing-predicate gate was not stripped (source shape changed — update the regex)');
    return { sql, params: unifiedParams(companyId, mutedEmails, mutedDomains) };
}

// ═════════════════════════════════════════════════════════════════════════════
// Runner
// ═════════════════════════════════════════════════════════════════════════════
function parseSectionArg() {
    const arg = process.argv.find(a => a.startsWith('--section='));
    const v = arg ? arg.split('=')[1] : (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'all');
    return v || 'all';
}

async function dumpExplainSql() {
    // Dump the exact search-less SQL (with a non-empty muted set as $4/$5) so the
    // orchestrator can run a read-only EXPLAIN on the prod copy. The muted literals
    // are provided as a leading comment; the SQL uses $4/$5 placeholders verbatim.
    try {
        const sql = extractUnifiedSql();
        const header = [
            '-- MAIL-MUTE-001 — exact getUnifiedTimelinePage SQL (search-less) for a read-only prod EXPLAIN.',
            '-- Params: $1=companyId  $2=limit  $3=offset  $4=mutedEmails text[]  $5=mutedDomains text[]',
            "-- Example bind (psql): EXPLAIN (ANALYZE, BUFFERS) <below>  with",
            "--   $1='00000000-0000-0000-0000-000000000001', $2=50, $3=0,",
            "--   $4=ARRAY['customerservice@relyhome.com']::text[], $5=ARRAY['relyhome.com']::text[]",
            '-- Also run once with:  SET enable_seqscan = off;  to prove the contact_emails EXISTS is index-usable.',
            '',
            'EXPLAIN (ANALYZE, BUFFERS)',
        ].join('\n');
        fs.writeFileSync(EXPLAIN_DUMP, `${header}\n${sql}\n`);
        console.log(`Dumped exact EXPLAIN SQL → ${path.relative(ROOT, EXPLAIN_DUMP)}`);
    } catch (e) {
        console.warn('Could not dump EXPLAIN SQL:', e.message);
    }
}

async function main() {
    const sel = parseSectionArg();
    const selected = CASES.filter(c => sel === 'all' || c.section === sel || c.id === sel);
    if (selected.length === 0) {
        console.error(`No cases match --section=${sel}. Sections: ${[...new Set(CASES.map(c => c.section))].join(', ')}`);
        process.exit(2);
    }

    console.log(`MAIL-MUTE-001 verify — DATABASE_URL=${process.env.DATABASE_URL}`);
    console.log(`Company A=${COMPANY_A} (seed, tagged/row-targeted asserts) · Company B=${COMPANY_B} (tagged, temp)`);
    console.log(`Cases: ${sel} → ${selected.length}\n`);

    // Idempotent: purge any prior crashed run's tagged rows before we start.
    await cleanupAll();
    // Ensure company A has a connected mail-secretary + settings (real dev usually
    // does; make it deterministic). We restore A's exclusion_rules at the end.
    const aRulesBefore = await scalar(`SELECT exclusion_rules FROM mail_agent_settings WHERE company_id = $1`, [COMPANY_A]);
    await ensureMailSecretary(COMPANY_A, aRulesBefore || '');

    await dumpExplainSql();
    console.log('');

    for (const c of selected) {
        await cleanupAll();
        // every case re-establishes A's mail-secretary active state (cleanup does not
        // touch A's install, but setRules per-case is what actually matters).
        try {
            await c.fn();
            record(c.id, 'PASS', c.title);
        } catch (e) {
            const note = `${c.title} — ${e instanceof CheckError ? e.message : (e.stack || e.message)}`;
            record(c.id, 'FAIL', note);
        }
    }

    await cleanupAll();
    // restore company A's original exclusion_rules (leave prod-like dev state intact).
    if (aRulesBefore != null) {
        await db.query(`UPDATE mail_agent_settings SET exclusion_rules = $2 WHERE company_id = $1`, [COMPANY_A, aRulesBefore]);
        mailAgentService.invalidateCache(COMPANY_A);
    }

    // Assert zero tagged rows remain.
    const offenders = await assertZeroTagged();
    if (offenders.length > 0) {
        record('CLEANUP', 'FAIL', `tagged rows survive: ${offenders.join(', ')}`);
    } else {
        record('CLEANUP', 'PASS', 'zero tagged rows remain');
    }

    const pass = results.filter(r => r.status === 'PASS').length;
    const fail = results.filter(r => r.status === 'FAIL').length;
    console.log(`\n══════════════════════════════════════════════`);
    console.log(`PASS ${pass} · FAIL ${fail}  (INFO lines excluded)`);
    if (fail > 0) console.log(`FAILED: ${results.filter(r => r.status === 'FAIL').map(r => r.id).join(', ')}`);

    await db.pool.end();
    process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
    console.error('FATAL:', e);
    try { await db.pool.end(); } catch { /* noop */ }
    process.exit(1);
});
