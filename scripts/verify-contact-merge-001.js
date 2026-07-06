#!/usr/bin/env node
/**
 * CONTACT-MERGE-001 — CM1-T5 real-DB verify harness (integration + security +
 * sabotage + EXPLAIN form-probes).
 *
 * THE load-bearing verification (LIST-PAGINATION-001 lesson): mocked jest proves
 * SQL text / dispatch / call-order only — it can NOT prove an FK held (calls on
 * a deleted dup timeline), an open task survived, a ROLLBACK left the DB
 * byte-identical, or a tenant stayed isolated. Every claim here runs against a
 * REAL local Postgres, self-seeding / self-cleaning by the unique tag CM1.
 *
 * Both conflict rounds are driven through the REAL `PATCH /api/contacts/:id`
 * handler (supertest + express + stub auth injecting req.user / req.authz
 * (`contacts.edit`) / req.companyFilter — same shape as the jest route layer but
 * the REAL `db/connection`). Direct service calls (`mergeContacts`,
 * `transferPhone`, `transferEmail`) only where the test case says so.
 *
 * Sections (Docs/test-cases/CONTACT-MERGE-001.md):
 *   s1  TC-CM-I01  **P0** S1 email-conflict full merge — complete AC-2 checklist
 *                  (open task re-homed, survivor ZB kept, zero dangling FK)
 *   s2  TC-CM-I04  S2 transfer email — row moves, scalar syncs, messages re-linked
 *   s3  TC-CM-I02  **P0 FK-TRAP** S3 phone-merge: dup timeline HOLDS CALLS; 3b
 *                  re-points them BEFORE the timeline delete (real FK, not a mock)
 *   s4  TC-CM-I03  **P0** S4 transfer phone: OQ-3 promotion, this-number-only
 *                  calls move, SMS flips at query time, no event
 *   s5  TC-CM-I05  **P0** S5 cancel: round 1 commits NOTHING — byte-identical DB
 *   s6  TC-CM-I06  S6 transfer_allowed:false end-to-end + hostile transfer → 409
 *   s7  TC-CM-I07  S7 multi-owner: ONE 409 grouped, ONE retry, both resolutions
 *   s8  TC-CM-I11  S8 Decision-E scalar email via the REAL handler (4175/4228)
 *   s9  TC-CM-I09  **P0** S9 stale echo: fresh 409 on mismatch / ignore on gone
 *   s10 TC-CM-I10  S10 double-submit → idempotent no-op (all three actions)
 *   s11 TC-CM-I08  **P0 SECURITY** cross-tenant: 4 legs (detection-invisible,
 *                  forged echo, foreign :id → 404, service tenant-guard)
 *   s12 TC-CM-I16  S12 self-conflict → no dialog, re-save no-op
 *   s13 TC-CM-I17  S13 owner deleted between rounds → resolution ignored
 *   s14 TC-CM-I14  **P0** S14 fault injection mid-resolution → FULL rollback
 *   s15 TC-CM-I12  S15 slot overflow: dropped_phones audited, calls moved, SMS caveat
 *   s16 TC-CM-I13  **P0** silent branches byte-for-byte (D3 / orphan merge /
 *                  ingestion) + TC-CM-I15 Pulse list on the UNCHANGED query
 *   sab TC-CM-ISAB **P0** sabotage ×2: wrong-expectation MUST FAIL; амендмент #5
 *                  feature-neutralize (byte-level, NO git — the feature is in
 *                  HEAD: temp-sabotage the merge service in place, detection→[]
 *                  + sentinel silenced → s1/s5/s8 MUST FAIL → restore original
 *                  bytes, sha256-verified)
 *   explain TC-CM-I18 (dev FORM probe) — plan shape with SET enable_seqscan=off
 *                  (амендмент #7: a dev Seq Scan is not an auto-fail; the FULL
 *                  volumetric I18 gate runs on a prod-copy restore, deploy-gated)
 *
 * Fault injection (I14): env/harness-guarded — `CM1_FAIL_AFTER='mergeContacts'`
 * semantics are implemented HERE by a one-shot monkey-patch of the shared
 * service module (same require-cache instance the route calls), never in
 * product code. No prod semantics.
 *
 * Company A = seed 00000000-0000-0000-0000-000000000001 (real dev rows coexist →
 * assertions are tagged / delta / row-targeted, never absolute counts).
 * Company B = tagged c0000000-0000-4000-8000-0000000000f1, CREATED + deleted here.
 *
 * Usage:
 *   node scripts/verify-contact-merge-001.js [--section=s1|…|s16|sab|explain|all] [--explain]
 *   DATABASE_URL defaults to postgresql://localhost/twilio_calls (house default).
 * Never point this at prod (prod-copy restore only, with explicit owner consent).
 * Exit code 0 only when no case FAILs.
 */
'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/twilio_calls';
// The harness must NEVER reach the real Zenbooker API (I01 asserts no ZB call;
// zenbookerSyncService reads this at require time).
process.env.FEATURE_ZENBOOKER_SYNC = 'false';

const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const db = require(path.join(ROOT, 'backend/src/db/connection'));
const emailQueries = require(path.join(ROOT, 'backend/src/db/emailQueries'));
const timelinesQueries = require(path.join(ROOT, 'backend/src/db/timelinesQueries'));
const merge = require(path.join(ROOT, 'backend/src/services/contactEmailMergeService'));
const zenbookerSyncService = require(path.join(ROOT, 'backend/src/services/zenbookerSyncService'));

const COMPANY_A = '00000000-0000-0000-0000-000000000001'; // seed company (real dev data coexists)
const COMPANY_B = 'c0000000-0000-4000-8000-0000000000f1'; // tagged, created+deleted here

// ─── tiny assert/report kit (verbatim house pattern — CEM1) ──────────────────

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
    const pad = ' '.repeat(Math.max(1, 14 - id.length));
    console.log(`${status} ${id}${pad}${note || ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const digitsOf = (v) => String(v || '').replace(/\D/g, '') || null;

// ─── the REAL route, mounted with stub auth (both rounds over HTTP) ──────────

const request = require('supertest');
const appCache = {};
function appFor(companyId) {
    if (appCache[companyId]) return appCache[companyId];
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { sub: 'cm1-verify', name: 'CM1 Verify', email: 'cm1@cm1.test', crmUser: { id: null } };
        req.authz = { permissions: ['contacts.edit', 'contacts.view'], company: { id: companyId }, scopes: {} };
        req.companyFilter = { company_id: companyId };
        next();
    });
    app.use('/api/contacts', require(path.join(ROOT, 'backend/src/routes/contacts')));
    appCache[companyId] = app;
    return app;
}

async function patchContact(id, body, companyId = COMPANY_A) {
    return request(appFor(companyId)).patch(`/api/contacts/${id}`).send(body);
}

// Strict-echo helper: rebuild resolutions[] from a ROUND-1 409 RESPONSE — the
// client contract (echo exactly the detected attribute set per owner).
function echoResolutions(conflictBody, actionByOwnerId) {
    const conflicts = conflictBody?.conflict?.conflicts || [];
    return conflicts.map(c => ({
        owner_contact_id: c.owner.id,
        action: actionByOwnerId[String(c.owner.id)] || 'merge',
        attributes: c.attributes.map(a => ({ kind: a.kind, value: a.value })),
    }));
}

// ─── seeding helpers (all tagged CM1; phones in the +1999777XXXX block) ──────

let phoneSeq = 100;
function nextPhone() {
    phoneSeq += 1;
    return `+1999777${String(phoneSeq).padStart(4, '0')}`;
}

async function ensureCompany(id, slug, name) {
    await db.query(
        `INSERT INTO companies (id, name, slug, status) VALUES ($1, $2, $3, 'active')
         ON CONFLICT (id) DO NOTHING`,
        [id, name, slug]
    );
}

async function mkContact(companyId, {
    name = 'Contact', phone = null, secondaryPhone = null, secondaryName = null,
    email = null, zbId = null, notes = null,
} = {}) {
    const r = await db.query(
        `INSERT INTO contacts (full_name, phone_e164, secondary_phone, secondary_phone_name,
                               email, zenbooker_customer_id, notes, company_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [`CM1 ${name}`, phone, secondaryPhone, secondaryName, email, zbId, notes, companyId]
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

let callSeq = 0;
async function mkCall(companyId, { timelineId = null, contactId = null, fromNumber = null, toNumber = null, at = null } = {}) {
    callSeq += 1;
    const r = await db.query(
        `INSERT INTO calls (call_sid, direction, status, is_final, from_number, to_number,
                            started_at, company_id, timeline_id, contact_id)
         VALUES ($1, 'inbound', 'completed', true, $2, $3, COALESCE($4, now()), $5, $6, $7)
         RETURNING id`,
        [`CM1-${callSeq}-${Date.now()}`, fromNumber, toNumber, at, companyId, timelineId, contactId]
    );
    return r.rows[0].id;
}

// customer_digits differs BY SCHEMA (portability probe, cached once):
//   - dev twilio_calls: GENERATED ALWAYS (derived from customer_e164) — explicit
//     INSERT is rejected, so the column must be omitted;
//   - prod schema: a PLAIN text column filled by app code at ingest
//     (backend/src/db/conversationsQueries.js: customer_e164.replace(/\D/g,''))
//     — omitting it leaves NULL and the Pulse SMS digit-lateral never matches.
let smsDigitsGeneratedCache = null;
async function smsCustomerDigitsIsGenerated() {
    if (smsDigitsGeneratedCache === null) {
        const r = await db.query(
            `SELECT is_generated FROM information_schema.columns
              WHERE table_name = 'sms_conversations' AND column_name = 'customer_digits'`
        );
        smsDigitsGeneratedCache = (r.rows[0] && r.rows[0].is_generated === 'ALWAYS');
    }
    return smsDigitsGeneratedCache;
}

// Schema portability probe #2 (cached once): the GLOBAL (cross-company!)
// partial unique index `uq_contacts_email` exists on the dev twilio_calls
// schema (v3 pre-multitenant base), but NOT on the prod schema (prod has only
// uq_contacts_zenbooker_customer_id). I08 leg 5 branches on this.
let uqContactsEmailCache = null;
async function hasGlobalUqContactsEmail() {
    if (uqContactsEmailCache === null) {
        const r = await db.query(
            `SELECT indexname AS name FROM pg_indexes
              WHERE tablename = 'contacts' AND indexname = 'uq_contacts_email'
             UNION
             SELECT conname AS name FROM pg_constraint WHERE conname = 'uq_contacts_email'`
        );
        uqContactsEmailCache = r.rows.length > 0;
    }
    return uqContactsEmailCache;
}

async function mkSmsConversation(companyId, { phone, lastAt = null, preview = 'CM1 sms msg' } = {}) {
    if (await smsCustomerDigitsIsGenerated()) {
        // GENERATED column: Postgres computes customer_digits itself.
        const r = await db.query(
            `INSERT INTO sms_conversations (company_id, customer_e164, friendly_name,
                                            last_message_at, last_message_direction, last_message_preview, source)
             VALUES ($1, $2, 'CM1 sms', COALESCE($3, now()), 'inbound', $4, 'twilio')
             RETURNING id`,
            [companyId, phone, lastAt, preview]
        );
        return r.rows[0].id;
    }
    // Plain column: mirror the ingest code (conversationsQueries.js) exactly.
    const r = await db.query(
        `INSERT INTO sms_conversations (company_id, customer_e164, customer_digits, friendly_name,
                                        last_message_at, last_message_direction, last_message_preview, source)
         VALUES ($1, $2, $3, 'CM1 sms', COALESCE($4, now()), 'inbound', $5, 'twilio')
         RETURNING id`,
        [companyId, phone, phone ? String(phone).replace(/\D/g, '') : null, lastAt, preview]
    );
    return r.rows[0].id;
}

// Reuse the company's existing gmail mailbox (company A has a real dev one);
// uniq (company_id, provider) allows only one per company, so seed one for B.
let mailboxCache = {};
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
        [companyId, `mb-${String(companyId).slice(-4)}@cm1.test`]
    );
    mailboxCache[companyId] = created.rows[0].id;
    return created.rows[0].id;
}

let threadSeq = 0;
async function mkEmailThread(companyId, { subject = 'CM1 thread', lastAt = null, lastDir = 'inbound', unread = 0 } = {}) {
    threadSeq += 1;
    const mailboxId = await mailboxFor(companyId);
    const r = await db.query(
        `INSERT INTO email_threads (company_id, mailbox_id, provider_thread_id, subject,
                                    last_message_at, last_message_direction, unread_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [companyId, mailboxId, `cm1-th-${threadSeq}-${Date.now()}`, subject, lastAt, lastDir, unread]
    );
    return r.rows[0].id;
}

let msgSeq = 0;
async function mkEmailMessage(companyId, {
    threadId, direction = 'inbound', fromEmail = null, to = [],
    contactId = null, timelineId = null, onTimeline = false, at = null, subject = null,
} = {}) {
    msgSeq += 1;
    const mailboxId = await mailboxFor(companyId);
    const pmid = `cm1-msg-${msgSeq}-${Date.now()}`;
    const r = await db.query(
        `INSERT INTO email_messages (company_id, mailbox_id, thread_id, provider_message_id,
                                     message_id_header, direction, from_email,
                                     to_recipients_json, subject,
                                     gmail_internal_at, contact_id, timeline_id, on_timeline)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13)
         RETURNING provider_message_id`,
        [companyId, mailboxId, threadId, pmid, `<${pmid}@cm1.test>`, direction, fromEmail,
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

let leadSeq = 0;
async function mkLead(companyId, { contactId = null } = {}) {
    leadSeq += 1;
    const r = await db.query(
        `INSERT INTO leads (uuid, company_id, contact_id, lead_notes)
         VALUES ($1, $2, $3, 'CM1 lead') RETURNING id`,
        [`cm1-ld-${leadSeq}-${Date.now()}`.slice(0, 20), companyId, contactId]
    );
    return r.rows[0].id;
}

async function seedOpenTask(companyId, { threadId = null, contactId = null, title = 'task', status = 'open' } = {}) {
    const r = await db.query(
        `INSERT INTO tasks (company_id, thread_id, contact_id, subject_type, subject_id, title, status, created_by)
         VALUES ($1, $2, $3, 'contact', $4, $5, $6, 'agent') RETURNING id`,
        [companyId, threadId, contactId, contactId, `CM1 ${title}`, status]
    );
    return r.rows[0].id;
}

// ─── cleanup (FK order; run at start, before EVERY case, and at end) ─────────
// domain_events → tasks → email_messages → email_threads → calls →
// sms_conversations → business entities (jobs/leads) → timelines →
// contact_emails → contacts → mailboxes/companies. Tagged CM1 everywhere;
// company B is nuked wholesale. NOTE: calls MUST go before timelines/contacts —
// calls.timeline_id/contact_id are plain FKs (no ON DELETE), the very trap 3b exists for.

async function cleanupAll() {
    mailboxCache = {};
    const taggedContacts = `SELECT id FROM contacts WHERE full_name LIKE 'CM1 %'`;

    // domain_events first (references contacts only by varchar aggregate_id).
    await db.query(`DELETE FROM domain_events WHERE aggregate_type = 'contact' AND aggregate_id IN (SELECT id::text FROM contacts WHERE full_name LIKE 'CM1 %')`);
    await db.query(`DELETE FROM domain_events WHERE company_id = $1`, [COMPANY_B]);

    await db.query(`DELETE FROM tasks WHERE title LIKE 'CM1 %'`);
    await db.query(`DELETE FROM tasks WHERE company_id = $1`, [COMPANY_B]);
    await db.query(`DELETE FROM tasks WHERE contact_id IN (${taggedContacts})`);

    await db.query(`DELETE FROM email_messages WHERE provider_message_id LIKE 'cm1-msg-%'`);
    await db.query(`DELETE FROM email_messages WHERE company_id = $1`, [COMPANY_B]);
    await db.query(`DELETE FROM email_messages WHERE contact_id IN (${taggedContacts})`);
    await db.query(`DELETE FROM email_threads WHERE provider_thread_id LIKE 'cm1-th-%'`);
    await db.query(`DELETE FROM email_threads WHERE company_id = $1`, [COMPANY_B]);

    // calls BEFORE timelines/contacts (plain FKs).
    await db.query(`DELETE FROM calls WHERE call_sid LIKE 'CM1-%'`);
    await db.query(`DELETE FROM calls WHERE company_id = $1`, [COMPANY_B]);
    await db.query(`DELETE FROM calls WHERE contact_id IN (${taggedContacts})`);
    await db.query(`DELETE FROM calls WHERE timeline_id IN (SELECT id FROM timelines WHERE contact_id IN (${taggedContacts}) OR (contact_id IS NULL AND phone_e164 LIKE '+1999777%'))`);

    await db.query(`DELETE FROM sms_conversations WHERE friendly_name = 'CM1 sms' OR customer_digits LIKE '1999777%'`);
    await db.query(`DELETE FROM sms_conversations WHERE company_id = $1`, [COMPANY_B]);

    await db.query(`DELETE FROM jobs WHERE contact_id IN (${taggedContacts})`);
    await db.query(`DELETE FROM jobs WHERE company_id = $1`, [COMPANY_B]);
    // leads.contact_id is a plain REFERENCES (no CASCADE) → delete before contacts.
    await db.query(`DELETE FROM leads WHERE lead_notes LIKE 'CM1 %'`);
    await db.query(`DELETE FROM leads WHERE contact_id IN (${taggedContacts})`);
    await db.query(`DELETE FROM leads WHERE company_id = $1`, [COMPANY_B]);

    await db.query(`DELETE FROM timelines WHERE company_id = $1`, [COMPANY_B]);
    await db.query(`DELETE FROM timelines WHERE contact_id IN (${taggedContacts})`);
    await db.query(`DELETE FROM timelines WHERE contact_id IS NULL AND phone_e164 LIKE '+1999777%'`);

    await db.query(`DELETE FROM contact_emails WHERE contact_id IN (${taggedContacts})`);
    await db.query(`DELETE FROM contact_emails WHERE email_normalized LIKE '%@cm1.test'`);

    await db.query(`DELETE FROM contacts WHERE full_name LIKE 'CM1 %'`);

    await db.query(`DELETE FROM email_mailboxes WHERE email_address LIKE 'mb-%@cm1.test'`);
    await db.query(`DELETE FROM companies WHERE id = $1`, [COMPANY_B]);
}

// ─── shared probes ───────────────────────────────────────────────────────────

async function scalar(sql, params = []) {
    const r = await db.query(sql, params);
    return r.rows[0] ? Object.values(r.rows[0])[0] : null;
}

async function rowExists(table, idCol, id) {
    return Number(await scalar(`SELECT count(*)::int FROM ${table} WHERE ${idCol} = $1`, [id])) > 0;
}

async function contactRow(id) {
    const r = await db.query(`SELECT * FROM contacts WHERE id = $1`, [id]);
    return r.rows[0] || null;
}

async function msgState(providerMessageId) {
    const r = await db.query(
        `SELECT contact_id, timeline_id, on_timeline
         FROM email_messages WHERE provider_message_id = $1`,
        [providerMessageId]
    );
    return r.rows[0] || null;
}

async function timelineOf(contactId) {
    return scalar(`SELECT id FROM timelines WHERE contact_id = $1 ORDER BY id LIMIT 1`, [contactId]);
}

/**
 * THE dangling-FK scan (from CEM1, extended per CM1-T5): after a merge, ZERO
 * rows reference the deleted dup id / dup timeline(s) across every contact_id /
 * thread_id / timeline_id FK — now INCLUDING calls.contact_id and
 * calls.timeline_id (the 3b addition; calls.timeline_id has NO ON DELETE action,
 * a dangling reference is an FK violation waiting at delete time).
 */
async function danglingRefs(dupId, dupTlIds = []) {
    const contactIdTables = [
        'jobs', 'leads', 'estimates', 'invoices', 'payment_transactions',
        'stripe_payment_sessions', 'portal_access_tokens', 'portal_sessions',
        'portal_events', 'crm_account_contacts', 'crm_deal_contacts', 'crm_activities',
        'tasks', 'contact_addresses', 'contact_emails', 'email_messages', 'timelines',
        'calls', // 3b — the phone-world addition
    ];
    const offenders = [];
    for (const t of contactIdTables) {
        const n = Number(await scalar(`SELECT count(*)::int FROM ${t} WHERE contact_id = $1`, [dupId]));
        if (n > 0) offenders.push(`${t}.contact_id (${n})`);
    }
    for (const tlId of (Array.isArray(dupTlIds) ? dupTlIds : [dupTlIds]).filter(x => x != null)) {
        const tn = Number(await scalar(`SELECT count(*)::int FROM tasks WHERE thread_id = $1`, [tlId]));
        if (tn > 0) offenders.push(`tasks.thread_id (${tn})`);
        const en = Number(await scalar(`SELECT count(*)::int FROM email_messages WHERE timeline_id = $1`, [tlId]));
        if (en > 0) offenders.push(`email_messages.timeline_id (${en})`);
        const cn = Number(await scalar(`SELECT count(*)::int FROM calls WHERE timeline_id = $1`, [tlId]));
        if (cn > 0) offenders.push(`calls.timeline_id (${cn})`);
        if (await rowExists('timelines', 'id', tlId)) offenders.push(`timelines.id (${tlId} still present)`);
    }
    if (await rowExists('contacts', 'id', dupId)) offenders.push('contacts.id (dup still present)');
    return offenders;
}

/**
 * THE byte-identical snapshot (S5/S14): ordered row-sets of the 9 fixture
 * tables, JSON'd + hashed. Tag-scoped so concurrent dev rows never pollute it.
 * `stripVolatile` removes updated_at/last_read_at for the idempotency cases
 * (S10 — a re-save legitimately touches updated_at) — the P0 cancel/rollback
 * cases (S5/S14) compare FULL rows including updated_at.
 */
async function snapshotCM1({ stripVolatile = false } = {}) {
    const tagged = `SELECT id FROM contacts WHERE full_name LIKE 'CM1 %' OR company_id = $1`;
    const specs = [
        ['contacts', `SELECT * FROM contacts WHERE full_name LIKE 'CM1 %' OR company_id = $1 ORDER BY id`],
        ['contact_emails', `SELECT * FROM contact_emails WHERE contact_id IN (${tagged}) ORDER BY id`],
        ['timelines', `SELECT * FROM timelines WHERE company_id = $1 OR contact_id IN (${tagged}) OR (contact_id IS NULL AND phone_e164 LIKE '+1999777%') ORDER BY id`],
        ['calls', `SELECT * FROM calls WHERE call_sid LIKE 'CM1-%' OR company_id = $1 ORDER BY id`],
        ['email_messages', `SELECT * FROM email_messages WHERE provider_message_id LIKE 'cm1-msg-%' OR company_id = $1 ORDER BY id`],
        ['email_threads', `SELECT * FROM email_threads WHERE provider_thread_id LIKE 'cm1-th-%' OR company_id = $1 ORDER BY id`],
        ['tasks', `SELECT * FROM tasks WHERE title LIKE 'CM1 %' OR company_id = $1 ORDER BY id`],
        ['leads', `SELECT * FROM leads WHERE lead_notes LIKE 'CM1 %' OR company_id = $1 ORDER BY id`],
        ['jobs', `SELECT * FROM jobs WHERE contact_id IN (${tagged}) OR company_id = $1 ORDER BY id`],
    ];
    const tables = {};
    for (const [name, sql] of specs) {
        const { rows } = await db.query(sql, [COMPANY_B]);
        const cleaned = rows.map(r => {
            if (!stripVolatile) return r;
            const c = { ...r };
            delete c.updated_at;
            delete c.last_read_at;
            return c;
        });
        tables[name] = JSON.stringify(cleaned, (k, v) => (v instanceof Date ? v.toISOString() : v));
    }
    const hash = crypto.createHash('sha256')
        .update(Object.entries(tables).map(([n, j]) => `${n}:${j}`).join('|'))
        .digest('hex');
    return { hash, tables };
}

function eqSnapshots(before, after, label) {
    if (before.hash === after.hash) return;
    const diff = Object.keys(before.tables).filter(t => before.tables[t] !== after.tables[t]);
    throw new CheckError(`${label}: snapshot hash mismatch — differing tables: ${diff.join(', ')}`);
}

// A company-B-only snapshot for the cross-tenant legs.
async function snapshotB() {
    const specs = ['contacts', 'contact_emails', 'timelines', 'calls', 'email_messages', 'email_threads', 'tasks', 'leads', 'jobs'];
    const parts = [];
    for (const t of specs) {
        const sql = t === 'contact_emails'
            ? `SELECT ce.* FROM contact_emails ce JOIN contacts c ON c.id = ce.contact_id WHERE c.company_id = $1 ORDER BY ce.id`
            : `SELECT * FROM ${t} WHERE company_id = $1 ORDER BY id`;
        const { rows } = await db.query(sql, [COMPANY_B]);
        parts.push(`${t}:${JSON.stringify(rows, (k, v) => (v instanceof Date ? v.toISOString() : v))}`);
    }
    return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

// contact_merged events are logged post-COMMIT fire-and-forget → poll.
async function mergedEvents(survivorId) {
    const r = await db.query(
        `SELECT event_data FROM domain_events
          WHERE company_id = $1 AND aggregate_type = 'contact'
            AND aggregate_id = $2 AND event_type = 'contact_merged'
          ORDER BY id`,
        [COMPANY_A, String(survivorId)]
    );
    return r.rows.map(x => x.event_data);
}
async function pollMergedEvent(survivorId, { timeoutMs = 4000, minCount = 1 } = {}) {
    const t0 = Date.now();
    for (;;) {
        const evs = await mergedEvents(survivorId);
        if (evs.length >= minCount) return evs;
        if (Date.now() - t0 > timeoutMs) {
            throw new CheckError(`contact_merged event for ${survivorId}: expected ≥${minCount}, got ${evs.length} after ${timeoutMs}ms`);
        }
        await sleep(120);
    }
}

// Post-commit async legs (mergeOrphanTimelines / leads-cascade) need a moment
// to settle before a baseline snapshot is taken.
const settle = () => sleep(300);

// ═════════════════════════════════════════════════════════════════════════════
// Cases
// ═════════════════════════════════════════════════════════════════════════════

const CASES = [];
function CASE(id, section, title, fn) {
    CASES.push({ id, section, title, fn });
}

// ---------------------------------------------------------------------------
CASE('TC-CM-I01', 's1', 'P0 S1 email-conflict FULL MERGE: 409 round-trip + complete AC-2 checklist + open task re-homed + zero dangling FK', async () => {
    const addr = 'x@cm1.test';
    // Target Jane: phone + ZB linkage + name/notes that must NEVER be overwritten.
    const janePhone = nextPhone();
    const jane = await mkContact(COMPANY_A, { name: 'S1 Jane', phone: janePhone, zbId: 'zb-jane', notes: 'jane notes' });
    // Owner X Acme: scalar + contact_emails, a phone, a lead, an OPEN task on his
    // timeline, 2 calls, an SMS conversation on his number, 2 email messages.
    const xPhone = nextPhone();
    const xAcme = await mkContact(COMPANY_A, { name: 'S1 X Acme', phone: xPhone, email: addr });
    await mkContactEmail(xAcme, addr, true);
    const xTl = await mkTimeline(COMPANY_A, { contactId: xAcme });
    const lead = await mkLead(COMPANY_A, { contactId: xAcme });
    const openTask = await seedOpenTask(COMPANY_A, { threadId: xTl, title: 'S1 AR task' });
    const c1 = await mkCall(COMPANY_A, { timelineId: xTl, contactId: xAcme, fromNumber: xPhone, toNumber: '+15550001111' });
    const c2 = await mkCall(COMPANY_A, { timelineId: xTl, contactId: xAcme, fromNumber: '+15550001111', toNumber: xPhone });
    await mkSmsConversation(COMPANY_A, { phone: xPhone });
    const th = await mkEmailThread(COMPANY_A, { subject: 'CM1 S1 x', lastAt: new Date().toISOString() });
    const m1 = await mkEmailMessage(COMPANY_A, { threadId: th, fromEmail: addr, contactId: xAcme, timelineId: xTl, onTimeline: true });
    const m2 = await mkEmailMessage(COMPANY_A, { threadId: th, fromEmail: addr, contactId: xAcme, timelineId: xTl, onTimeline: true });

    check(zenbookerSyncService.FEATURE_ENABLED === false, 'ZB sync must be OFF in the harness (no real API calls)');

    await settle();
    const before = await snapshotCM1();

    // Round 1 — the conflicting add, NO resolutions → 409 with the full payload.
    const r1 = await patchContact(jane, { emails: [{ email: addr, is_primary: true }] });
    eq(r1.status, 409, 'round-1 status');
    eq(r1.body.ok, false, 'round-1 ok:false envelope');
    eq(r1.body.error.code, 'CONTACT_ATTRIBUTE_CONFLICT', 'round-1 error code');
    check(!!r1.body.error.correlation_id, 'round-1 carries correlation_id');
    const conflicts = r1.body.conflict?.conflicts;
    check(Array.isArray(conflicts) && conflicts.length === 1, `exactly one conflict, got ${JSON.stringify(conflicts)?.slice(0, 200)}`);
    eq(conflicts[0].owner.id, xAcme, 'conflict owner = X Acme');
    eq(conflicts[0].owner.full_name, 'CM1 S1 X Acme', 'owner composition carries name');
    check(conflicts[0].owner.phones.some(p => p.value === xPhone), 'owner composition carries his phone');
    check(conflicts[0].owner.emails.some(e => e.email === addr), 'owner composition carries the address');
    eq(conflicts[0].editing.id, jane, 'editing composition = Jane');
    eq(conflicts[0].attributes.length, 1, 'one conflicting attribute');
    eq(conflicts[0].attributes[0].kind, 'email', 'attribute kind');
    eq(conflicts[0].attributes[0].normalized, addr, 'attribute normalized');
    eq(conflicts[0].transfer_allowed, true, 'transfer_allowed (owner keeps a phone)');

    // Round 1 committed NOTHING (detection precedes all writes).
    eqSnapshots(before, await snapshotCM1(), 'DB unchanged after round-1 409');

    // Round 2 — strict echo, action merge → 200.
    const r2 = await patchContact(jane, {
        emails: [{ email: addr, is_primary: true }],
        resolutions: echoResolutions(r1.body, { [String(xAcme)]: 'merge' }),
    });
    eq(r2.status, 200, 'round-2 status');
    eq(r2.body.ok, true, 'round-2 ok');

    // AC-2 checklist on real rows.
    const j = await contactRow(jane);
    eq(j.full_name, 'CM1 S1 Jane', 'survivor full_name untouched');
    eq(j.notes, 'jane notes', 'survivor notes untouched');
    eq(j.zenbooker_customer_id, 'zb-jane', 'survivor ZB id kept');
    eq(j.phone_e164, janePhone, 'survivor primary phone untouched');
    eq(j.secondary_phone, xPhone, 'dup phone filled the FREE secondary slot (3c)');
    eq(await scalar(`SELECT count(*)::int FROM contact_emails WHERE contact_id = $1 AND email_normalized = $2`, [jane, addr]), 1, 'address on the survivor contact_emails');
    eq(await scalar(`SELECT contact_id FROM leads WHERE id = $1`, [lead]), jane, 'lead re-pointed to Jane');

    const janeTl = await timelineOf(jane);
    check(janeTl != null, 'survivor has a timeline');
    for (const [lbl, cid] of [['call1', c1], ['call2', c2]]) {
        eq(await scalar(`SELECT timeline_id FROM calls WHERE id = $1`, [cid]), janeTl, `${lbl} timeline → survivor (3b)`);
        eq(await scalar(`SELECT contact_id FROM calls WHERE id = $1`, [cid]), jane, `${lbl} contact → survivor (3b)`);
    }
    for (const [lbl, pm] of [['m1', m1], ['m2', m2]]) {
        const s = await msgState(pm);
        eq(s.contact_id, jane, `${lbl} contact → survivor`);
        eq(s.timeline_id, janeTl, `${lbl} timeline → survivor`);
        eq(s.on_timeline, true, `${lbl} on_timeline`);
    }

    // THE open task is alive, open, and re-homed onto the survivor timeline.
    check(await rowExists('tasks', 'id', openTask), 'open task STILL EXISTS (not CASCADE-deleted)');
    const task = (await db.query(`SELECT status, thread_id FROM tasks WHERE id = $1`, [openTask])).rows[0];
    eq(task.status, 'open', 'task still open');
    eq(task.thread_id, janeTl, 'task re-homed onto survivor timeline BEFORE the dup-timeline delete');

    // Dup + his timeline gone; ZERO dangling FKs anywhere (incl. calls.*).
    check(!(await rowExists('contacts', 'id', xAcme)), 'dup contact deleted (LAST)');
    check(!(await rowExists('timelines', 'id', xTl)), 'dup timeline deleted');
    const offenders = await danglingRefs(xAcme, [xTl]);
    check(offenders.length === 0, `ZERO dangling FK required; found: ${offenders.join(', ')}`);

    // Detection now resolves the address to the survivor.
    const owner = await emailQueries.findEmailContact(addr, COMPANY_A);
    eq(owner && owner.id, jane, 'findEmailContact → Jane after the merge');

    // contact_merged audit event on the survivor (post-COMMIT, polled).
    const evs = await pollMergedEvent(jane);
    eq(evs.length, 1, 'exactly one contact_merged event');
    eq(evs[0].merged_contact_id, xAcme, 'event carries merged_contact_id');
    eq(evs[0].merged_name, 'CM1 S1 X Acme', 'event carries merged_name');
    check(Array.isArray(evs[0].dropped_phones) && evs[0].dropped_phones.length === 0, 'no dropped phones (slot was free)');
});

// ---------------------------------------------------------------------------
CASE('TC-CM-I04', 's2', 'S2 transfer email: row moves, owner scalar syncs, messages re-linked, owner intact', async () => {
    const addr = 'bob@cm1.test';
    const bobPhone = nextPhone();
    const bob = await mkContact(COMPANY_A, { name: 'S2 Bob', phone: bobPhone, email: addr });
    await mkContactEmail(bob, addr, true);
    await mkContactEmail(bob, 'bob2@cm1.test', false);
    const bobTl = await mkTimeline(COMPANY_A, { contactId: bob });
    const bobCall = await mkCall(COMPANY_A, { timelineId: bobTl, contactId: bob, fromNumber: bobPhone, toNumber: '+15550001111' });
    const th = await mkEmailThread(COMPANY_A, { subject: 'CM1 S2 bob', lastAt: new Date().toISOString() });
    const m1 = await mkEmailMessage(COMPANY_A, { threadId: th, fromEmail: addr, contactId: bob, timelineId: bobTl, onTimeline: true });
    const m2 = await mkEmailMessage(COMPANY_A, { threadId: th, fromEmail: addr, contactId: bob, timelineId: bobTl, onTimeline: true });

    const target = await mkContact(COMPANY_A, { name: 'S2 Acme Billing', phone: nextPhone() });

    const r1 = await patchContact(target, { emails: [{ email: addr, is_primary: true }] });
    eq(r1.status, 409, 'round-1 409');
    eq(r1.body.conflict.conflicts[0].transfer_allowed, true, 'transfer allowed (Bob keeps phone + other address)');

    const r2 = await patchContact(target, {
        emails: [{ email: addr, is_primary: true }],
        resolutions: echoResolutions(r1.body, { [String(bob)]: 'transfer' }),
    });
    eq(r2.status, 200, 'round-2 200');

    // Address exists ONLY on the target; detection resolves there.
    eq(await scalar(`SELECT count(*)::int FROM contact_emails WHERE email_normalized = $1`, [addr]), 1, 'single ownership of the address');
    eq(await scalar(`SELECT contact_id FROM contact_emails WHERE email_normalized = $1`, [addr]), target, 'the one row is the target');
    const owner = await emailQueries.findEmailContact(addr, COMPANY_A);
    eq(owner && owner.id, target, 'findEmailContact → target');

    // Messages re-linked onto the target's timeline.
    const targetTl = await timelineOf(target);
    for (const [lbl, pm] of [['m1', m1], ['m2', m2]]) {
        const s = await msgState(pm);
        eq(s.contact_id, target, `${lbl} → target`);
        eq(s.timeline_id, targetTl, `${lbl} on target timeline`);
        eq(s.on_timeline, true, `${lbl} on_timeline`);
    }

    // Owner alive with everything else: phone, other address, scalar synced, call, timeline.
    const b = await contactRow(bob);
    check(b, 'Bob alive');
    eq(b.phone_e164, bobPhone, 'Bob keeps his phone');
    eq(b.email, 'bob2@cm1.test', 'Bob scalar synced to his remaining address');
    eq(await scalar(`SELECT count(*)::int FROM contact_emails WHERE contact_id = $1 AND email_normalized = 'bob2@cm1.test'`, [bob]), 1, 'Bob keeps his other address');
    eq(await scalar(`SELECT timeline_id FROM calls WHERE id = $1`, [bobCall]), bobTl, 'Bob call untouched');
    check(await rowExists('timelines', 'id', bobTl), 'Bob timeline intact');
});

// ---------------------------------------------------------------------------
CASE('TC-CM-I02', 's3', 'P0 FK-TRAP S3 phone-merge: dup timeline HOLDS CALLS → merge commits with NO FK error (3b before delete)', async () => {
    const num = nextPhone();
    // Owner Bob: the number + 3 calls ON HIS TIMELINE + a job — the generic-dup
    // shape v1's email-only dups never had. A wrong step order raises a REAL
    // `foreign key violation` here (calls.timeline_id has no ON DELETE action).
    const bob = await mkContact(COMPANY_A, { name: 'S3 Bob', phone: num });
    const bobTl = await mkTimeline(COMPANY_A, { contactId: bob });
    const calls = [];
    for (let i = 0; i < 3; i++) {
        calls.push(await mkCall(COMPANY_A, { timelineId: bobTl, contactId: bob, fromNumber: num, toNumber: '+15550002222' }));
    }
    const job = await mkJob(COMPANY_A, { contactId: bob });

    const target = await mkContact(COMPANY_A, { name: 'S3 Acme Billing', phone: nextPhone() });

    const r1 = await patchContact(target, { secondary_phone: num });
    eq(r1.status, 409, 'round-1 409 (detection digit-matched via the mig-149 legs)');
    eq(r1.body.conflict.conflicts[0].owner.id, bob, 'owner = Bob');
    eq(r1.body.conflict.conflicts[0].attributes[0].kind, 'phone', 'phone attribute');

    const r2 = await patchContact(target, {
        secondary_phone: num,
        resolutions: echoResolutions(r1.body, { [String(bob)]: 'merge' }),
    });
    eq(r2.status, 200, 'merge COMMITTED without an FK error (3b re-pointed calls first)');

    const targetTl = await timelineOf(target);
    for (const c of calls) {
        eq(await scalar(`SELECT timeline_id FROM calls WHERE id = $1`, [c]), targetTl, `call ${c} → survivor timeline`);
        eq(await scalar(`SELECT contact_id FROM calls WHERE id = $1`, [c]), target, `call ${c} → survivor contact`);
    }
    eq(await scalar(`SELECT contact_id FROM jobs WHERE id = $1`, [job]), target, 'job re-pointed');
    eq((await contactRow(target)).secondary_phone, num, 'number in a survivor slot');
    check(!(await rowExists('contacts', 'id', bob)), 'Bob deleted');
    check(!(await rowExists('timelines', 'id', bobTl)), 'Bob timeline deleted');
    const offenders = await danglingRefs(bob, [bobTl]);
    check(offenders.length === 0, `dangling FK after phone merge: ${offenders.join(', ')}`);

    // Inbound resolve now lands on the survivor (digit-match).
    const tl = await timelinesQueries.findOrCreateTimeline(num, COMPANY_A);
    eq(tl.contact_id, target, 'findOrCreateTimeline(digit-match) → survivor');
});

// ---------------------------------------------------------------------------
CASE('TC-CM-I03', 's4', 'P0 S4 transfer phone: OQ-3 promotion, ONLY this number\'s calls move, SMS flips at query time, NO event', async () => {
    const num22 = nextPhone(); // the conflicting/transferred number
    const num33 = nextPhone(); // Bob's other number (promoted)
    const bob = await mkContact(COMPANY_A, { name: 'S4 Bob', phone: num22, secondaryPhone: num33, secondaryName: 'Wife' });
    const bobTl = await mkTimeline(COMPANY_A, { contactId: bob });
    const calls22 = [];
    const calls33 = [];
    for (let i = 0; i < 2; i++) {
        calls22.push(await mkCall(COMPANY_A, { timelineId: bobTl, contactId: bob, fromNumber: num22, toNumber: '+15550003333' }));
        calls33.push(await mkCall(COMPANY_A, { timelineId: bobTl, contactId: bob, fromNumber: '+15550003333', toNumber: num33 }));
    }
    const job = await mkJob(COMPANY_A, { contactId: bob });
    const sms22 = await mkSmsConversation(COMPANY_A, { phone: num22, lastAt: new Date().toISOString() });
    const sms33 = await mkSmsConversation(COMPANY_A, { phone: num33, lastAt: new Date(Date.now() - 60000).toISOString() });
    const smsRowsBefore = JSON.stringify((await db.query(`SELECT id, customer_e164, customer_digits, last_message_at FROM sms_conversations WHERE id IN ($1, $2) ORDER BY id`, [sms22, sms33])).rows);

    const target = await mkContact(COMPANY_A, { name: 'S4 Acme Billing', phone: nextPhone() });

    const r1 = await patchContact(target, { secondary_phone: num22 });
    eq(r1.status, 409, 'round-1 409');
    eq(r1.body.conflict.conflicts[0].transfer_allowed, true, 'transfer allowed (Bob keeps …33)');

    const r2 = await patchContact(target, {
        secondary_phone: num22,
        resolutions: echoResolutions(r1.body, { [String(bob)]: 'transfer' }),
    });
    eq(r2.status, 200, 'round-2 200');

    // OQ-3 promotion on the owner; owner NOT deleted; his world intact.
    const b = await contactRow(bob);
    check(b, 'Bob alive');
    eq(b.phone_e164, num33, 'secondary PROMOTED to primary (OQ-3)');
    eq(b.secondary_phone, null, 'secondary cleared');
    eq(b.secondary_phone_name, null, 'secondary label cleared (accepted micro-loss)');
    eq(await scalar(`SELECT contact_id FROM jobs WHERE id = $1`, [job]), bob, 'Bob job intact');

    // ONLY the …22 calls moved; the …33 calls stayed on Bob's timeline.
    const targetTl = await timelineOf(target);
    for (const c of calls22) {
        eq(await scalar(`SELECT timeline_id FROM calls WHERE id = $1`, [c]), targetTl, `…22 call ${c} → target timeline`);
        eq(await scalar(`SELECT contact_id FROM calls WHERE id = $1`, [c]), target, `…22 call ${c} → target contact`);
    }
    for (const c of calls33) {
        eq(await scalar(`SELECT timeline_id FROM calls WHERE id = $1`, [c]), bobTl, `…33 call ${c} stays on Bob`);
        eq(await scalar(`SELECT contact_id FROM calls WHERE id = $1`, [c]), bob, `…33 call ${c} contact stays Bob`);
    }
    eq((await contactRow(target)).secondary_phone, num22, 'target carries the number (normal PATCH field UPDATE)');

    // SMS: NO row written/changed — the flip is query-time (digit lateral).
    const smsRowsAfter = JSON.stringify((await db.query(`SELECT id, customer_e164, customer_digits, last_message_at FROM sms_conversations WHERE id IN ($1, $2) ORDER BY id`, [sms22, sms33])).rows);
    eq(smsRowsAfter, smsRowsBefore, 'sms_conversations rows untouched');
    await settle(); // let the post-commit orphan-merge leg finish before querying the list
    const rows = await timelinesQueries.getUnifiedTimelinePage({ limit: 2000, offset: 0, companyId: COMPANY_A });
    const targetRow = rows.find(r => Number(r.timeline_id) === Number(targetTl));
    check(targetRow, 'target surfaces on the unified list');
    eq(targetRow.sms_conversation_id, sms22, '…22 SMS conversation now surfaces on the TARGET row');
    const bobRow = rows.find(r => Number(r.timeline_id) === Number(bobTl));
    check(bobRow, 'Bob still surfaces (his calls remain)');
    check(String(bobRow.sms_conversation_id) !== String(sms22), '…22 SMS no longer on Bob\'s row');

    // Future inbound …22 resolves to the target.
    const tl = await timelinesQueries.findOrCreateTimeline(num22, COMPANY_A);
    eq(tl.contact_id, target, 'findOrCreateTimeline(…22) → target');

    // Transfers are event-less by spec.
    eq((await mergedEvents(target)).length, 0, 'no contact_merged event on target');
    eq((await mergedEvents(bob)).length, 0, 'no event on owner');
});

// ---------------------------------------------------------------------------
CASE('TC-CM-I05', 's5', 'P0 S5 cancel: round 1 commits NOTHING — byte-identical snapshot incl. the non-conflicting field edits', async () => {
    const addr = 'x5@cm1.test';
    const jane = await mkContact(COMPANY_A, { name: 'S5 Jane', phone: nextPhone(), zbId: 'zb-s5', notes: 's5 notes' });
    const xPhone = nextPhone();
    const x = await mkContact(COMPANY_A, { name: 'S5 X', phone: xPhone, email: addr });
    await mkContactEmail(x, addr, true);
    const xTl = await mkTimeline(COMPANY_A, { contactId: x });
    await seedOpenTask(COMPANY_A, { threadId: xTl, title: 'S5 task' });
    await mkCall(COMPANY_A, { timelineId: xTl, contactId: x, fromNumber: xPhone, toNumber: '+15550004444' });
    const th = await mkEmailThread(COMPANY_A, { subject: 'CM1 S5' });
    await mkEmailMessage(COMPANY_A, { threadId: th, fromEmail: addr, contactId: x, timelineId: xTl, onTimeline: true });
    await mkLead(COMPANY_A, { contactId: x });

    await settle();
    const before = await snapshotCM1();

    // Round 1: the conflicting email PLUS non-conflicting edits (name + a new
    // secondary phone) → 409; the field edits must NOT have leaked out of the tx.
    const r1 = await patchContact(jane, {
        first_name: 'CM1 Jane',
        last_name: 'Edited',
        secondary_phone: nextPhone(),
        emails: [{ email: addr, is_primary: true }],
    });
    eq(r1.status, 409, 'round-1 409');

    // Cancel = no retry. Byte-identical DB (FULL rows, updated_at included).
    eqSnapshots(before, await snapshotCM1(), 'cancel leaves the DB byte-identical');

    // Re-save WITHOUT the conflicting attribute → 200, no dialog, name persists.
    const r2 = await patchContact(jane, { first_name: 'CM1 Jane', last_name: 'Edited' });
    eq(r2.status, 200, 're-save without the conflict passes');
    eq((await contactRow(jane)).full_name, 'CM1 Jane Edited', 'name persisted only by the clean save');
});

// ---------------------------------------------------------------------------
CASE('TC-CM-I06', 's6', 'S6 single-attribute owner: transfer_allowed:false end-to-end; hostile transfer retry → fresh 409; merge passes', async () => {
    // (a) email-only auto-contact — exactly what old D2a silently ate.
    const addr = 'auto6@cm1.test';
    const auto = await mkContact(COMPANY_A, { name: 'S6 Auto', email: addr });
    await mkContactEmail(auto, addr, true);
    const autoTl = await mkTimeline(COMPANY_A, { contactId: auto });
    const th = await mkEmailThread(COMPANY_A, { subject: 'CM1 S6' });
    await mkEmailMessage(COMPANY_A, { threadId: th, fromEmail: addr, contactId: auto, timelineId: autoTl, onTimeline: true });
    const target = await mkContact(COMPANY_A, { name: 'S6 Target', phone: nextPhone() });

    await settle();
    const before = await snapshotCM1();

    const r1 = await patchContact(target, { emails: [{ email: addr, is_primary: true }] });
    eq(r1.status, 409, 'round-1 409 (no silent D2a auto-merge)');
    eq(r1.body.conflict.conflicts[0].transfer_allowed, false, 'transfer_allowed:false (only attribute)');
    eqSnapshots(before, await snapshotCM1(), 'round 1 changed nothing (no silent auto-merge)');

    // Hostile client forces action:'transfer' anyway → server re-checks the FR-3
    // gate at execution → sentinel → fresh 409; the owner is never stripped.
    const hostile = await patchContact(target, {
        emails: [{ email: addr, is_primary: true }],
        resolutions: echoResolutions(r1.body, { [String(auto)]: 'transfer' }),
    });
    eq(hostile.status, 409, 'hostile transfer rejected with a fresh 409');
    check(await rowExists('contacts', 'id', auto), 'owner untouched by the rejected transfer');
    eq(await scalar(`SELECT count(*)::int FROM contact_emails WHERE contact_id = $1`, [auto]), 1, 'owner still holds his only address');

    // Explicit merge → 200; dup deleted only now.
    const r2 = await patchContact(target, {
        emails: [{ email: addr, is_primary: true }],
        resolutions: echoResolutions(r1.body, { [String(auto)]: 'merge' }),
    });
    eq(r2.status, 200, 'merge retry 200');
    check(!(await rowExists('contacts', 'id', auto)), 'dup deleted after the EXPLICIT confirm');
    const offenders = await danglingRefs(auto, [autoTl]);
    check(offenders.length === 0, `dangling: ${offenders.join(', ')}`);
    await pollMergedEvent(target);

    // (b) owner whose ONLY attribute is the conflicting phone.
    const num = nextPhone();
    const phoneOnly = await mkContact(COMPANY_A, { name: 'S6 PhoneOnly', phone: num });
    const target2 = await mkContact(COMPANY_A, { name: 'S6 Target2', phone: nextPhone() });
    const p1 = await patchContact(target2, { secondary_phone: num });
    eq(p1.status, 409, 'phone param: 409');
    eq(p1.body.conflict.conflicts[0].transfer_allowed, false, 'phone param: transfer_allowed:false');
    const p2 = await patchContact(target2, {
        secondary_phone: num,
        resolutions: echoResolutions(p1.body, { [String(phoneOnly)]: 'merge' }),
    });
    eq(p2.status, 200, 'phone param: merge 200');
    check(!(await rowExists('contacts', 'id', phoneOnly)), 'phone-only dup deleted');
});

// ---------------------------------------------------------------------------
CASE('TC-CM-I07', 's7', 'S7 multi-owner: ONE 409 grouped by owner; ONE retry executes merge(A2) + transfer(B2) in one tx', async () => {
    const numA = nextPhone();
    const emailA = 'a7@cm1.test';
    const emailB = 'b7@cm1.test';
    const a2 = await mkContact(COMPANY_A, { name: 'S7 A2', phone: numA, email: emailA });
    await mkContactEmail(a2, emailA, true);
    const a2Tl = await mkTimeline(COMPANY_A, { contactId: a2 });
    await mkCall(COMPANY_A, { timelineId: a2Tl, contactId: a2, fromNumber: numA, toNumber: '+15550007777' });
    const b2 = await mkContact(COMPANY_A, { name: 'S7 B2', phone: nextPhone(), email: emailB });
    await mkContactEmail(b2, emailB, true);

    const target = await mkContact(COMPANY_A, { name: 'S7 Target', phone: nextPhone() });

    const r1 = await patchContact(target, {
        secondary_phone: numA,
        emails: [{ email: emailA, is_primary: true }, { email: emailB }],
    });
    eq(r1.status, 409, 'ONE 409 for the whole Save');
    const conflicts = r1.body.conflict.conflicts;
    eq(conflicts.length, 2, 'two conflict entries (grouped by owner)');
    const entryA = conflicts.find(c => String(c.owner.id) === String(a2));
    const entryB = conflicts.find(c => String(c.owner.id) === String(b2));
    check(entryA && entryB, 'entries for both owners');
    eq(entryA.attributes.length, 2, 'A2 entry carries BOTH attributes (phone + email)');
    check(entryA.attributes.some(a => a.kind === 'phone') && entryA.attributes.some(a => a.kind === 'email'), 'A2 attrs = phone + email');
    eq(entryB.attributes.length, 1, 'B2 entry carries the email only');

    const r2 = await patchContact(target, {
        secondary_phone: numA,
        emails: [{ email: emailA, is_primary: true }, { email: emailB }],
        resolutions: echoResolutions(r1.body, { [String(a2)]: 'merge', [String(b2)]: 'transfer' }),
    });
    eq(r2.status, 200, 'ONE retry executes both resolutions');

    // A2 fully merged + deleted; ONE contact_merged event.
    check(!(await rowExists('contacts', 'id', a2)), 'A2 deleted');
    const offenders = await danglingRefs(a2, [a2Tl]);
    check(offenders.length === 0, `A2 dangling: ${offenders.join(', ')}`);
    const evs = await pollMergedEvent(target);
    eq(evs.length, 1, 'exactly one contact_merged event (only the merge)');

    // B2 alive minus the transferred address.
    check(await rowExists('contacts', 'id', b2), 'B2 alive');
    eq(await scalar(`SELECT count(*)::int FROM contact_emails WHERE contact_id = $1 AND email_normalized = $2`, [b2, emailB]), 0, 'B2 lost the address');
    eq(await scalar(`SELECT contact_id FROM contact_emails WHERE email_normalized = $1`, [emailB]), target, 'address on the target');
    check((await contactRow(b2)).phone_e164 != null, 'B2 keeps his phone');
});

// ---------------------------------------------------------------------------
CASE('TC-CM-I11', 's8', 'S8 Decision-E scalar email via the REAL handler — 4175/4228 closed on both branches', async () => {
    // (a) no-conflict branch: unowned scalar with 1 inbox-only message.
    const addrA = 'p8a@cm1.test';
    const t1 = await mkContact(COMPANY_A, { name: 'S8 T1', phone: nextPhone() });
    const th = await mkEmailThread(COMPANY_A, { subject: 'CM1 S8a' });
    const stray = await mkEmailMessage(COMPANY_A, { threadId: th, fromEmail: addrA }); // unowned, off-timeline

    const ra = await patchContact(t1, { email: addrA }); // EXACT PulseContactPanel payload — no emails[]
    eq(ra.status, 200, '(a) scalar save 200');
    eq((await contactRow(t1)).email, addrA, '(a) scalar column written');
    // THE 4175/4228 reproduction: pre-fix this row was absent.
    eq(await scalar(`SELECT count(*)::int FROM contact_emails WHERE contact_id = $1 AND email_normalized = $2`, [t1, addrA]), 1,
        '(a) contact_emails row EXISTS (the literal 4175/4228 regression)');
    const strayState = await msgState(stray);
    eq(strayState.contact_id, t1, '(a) stray message linked to the target');
    eq(strayState.on_timeline, true, '(a) stray message on the timeline');

    // (b) conflict branch: scalar owned by another A-contact → 409, same payload
    // shape as the emails[] path → merge retry → I01 outcomes.
    const addrB = 'p8b@cm1.test';
    const ownerB = await mkContact(COMPANY_A, { name: 'S8 Owner', phone: nextPhone(), email: addrB });
    await mkContactEmail(ownerB, addrB, true);
    const ownerTl = await mkTimeline(COMPANY_A, { contactId: ownerB });
    const t2 = await mkContact(COMPANY_A, { name: 'S8 T2', phone: nextPhone() });

    const rb1 = await patchContact(t2, { email: addrB });
    eq(rb1.status, 409, '(b) scalar conflict → 409');
    eq(rb1.body.error.code, 'CONTACT_ATTRIBUTE_CONFLICT', '(b) same error code');
    const c = rb1.body.conflict.conflicts[0];
    eq(c.owner.id, ownerB, '(b) owner in payload');
    eq(c.attributes[0].kind, 'email', '(b) attribute kind');
    eq(c.attributes[0].normalized, addrB, '(b) attribute normalized');
    check(typeof c.transfer_allowed === 'boolean', '(b) transfer_allowed present');

    const rb2 = await patchContact(t2, {
        email: addrB,
        resolutions: echoResolutions(rb1.body, { [String(ownerB)]: 'merge' }),
    });
    eq(rb2.status, 200, '(b) merge retry 200');
    check(!(await rowExists('contacts', 'id', ownerB)), '(b) dup merged away');
    eq(await scalar(`SELECT contact_id FROM contact_emails WHERE email_normalized = $1`, [addrB]), t2, '(b) address on the target');
    const offenders = await danglingRefs(ownerB, [ownerTl]);
    check(offenders.length === 0, `(b) dangling: ${offenders.join(', ')}`);

    // (c) scalar already on the contact → 200, no duplicate row, no dialog.
    const rc = await patchContact(t1, { email: addrA });
    eq(rc.status, 200, '(c) idempotent scalar re-save 200 (no dialog)');
    eq(await scalar(`SELECT count(*)::int FROM contact_emails WHERE contact_id = $1 AND email_normalized = $2`, [t1, addrA]), 1, '(c) no duplicate row');
});

// ---------------------------------------------------------------------------
CASE('TC-CM-I09', 's9', 'P0 S9 stale echo: owner mutated between rounds → fresh 409 (mismatch) / clean ignore (conflict gone)', async () => {
    // (a) mismatch path: between rounds the owner GAINS a second conflicting
    // attribute of the same Save → old echo no longer matches → fresh 409.
    const num = nextPhone();
    const addr = 'stale9@cm1.test';
    const o = await mkContact(COMPANY_A, { name: 'S9 Owner', phone: num, email: 'keep9@cm1.test' });
    await mkContactEmail(o, 'keep9@cm1.test', true);
    const target = await mkContact(COMPANY_A, { name: 'S9 Target', phone: nextPhone() });

    const r1 = await patchContact(target, { secondary_phone: num, emails: [{ email: addr, is_primary: true }] });
    eq(r1.status, 409, '(a) round-1 409');
    eq(r1.body.conflict.conflicts.length, 1, '(a) initially one owner, one attribute (the phone)');
    const staleEcho = echoResolutions(r1.body, { [String(o)]: 'merge' });

    // …another session gives O the second attribute being added.
    await mkContactEmail(o, addr, false);

    await settle();
    const before = await snapshotCM1();
    const retry = await patchContact(target, {
        secondary_phone: num,
        emails: [{ email: addr, is_primary: true }],
        resolutions: staleEcho,
    });
    eq(retry.status, 409, '(a) stale echo → FRESH 409, never a stale action');
    const freshAttrs = retry.body.conflict.conflicts.find(c => String(c.owner.id) === String(o)).attributes;
    eq(freshAttrs.length, 2, '(a) fresh payload carries the CURRENT attribute set (phone + email)');
    eqSnapshots(before, await snapshotCM1(), '(a) nothing committed on the mismatch path');

    // (b) gone path: the conflict disappears between rounds → resolution ignored,
    // plain save proceeds.
    const num2 = nextPhone();
    const o2 = await mkContact(COMPANY_A, { name: 'S9 Owner2', phone: num2, email: 'o2keep@cm1.test' });
    await mkContactEmail(o2, 'o2keep@cm1.test', true);
    const target2 = await mkContact(COMPANY_A, { name: 'S9 Target2', phone: nextPhone() });
    const g1 = await patchContact(target2, { secondary_phone: num2 });
    eq(g1.status, 409, '(b) round-1 409');
    const ghostEcho = echoResolutions(g1.body, { [String(o2)]: 'merge' });

    // …another session transfers the number away from O2.
    await db.query(`UPDATE contacts SET phone_e164 = NULL, updated_at = now() WHERE id = $1`, [o2]);

    const g2 = await patchContact(target2, { secondary_phone: num2, resolutions: ghostEcho });
    eq(g2.status, 200, '(b) conflict gone → resolution ignored, plain save');
    eq((await contactRow(target2)).secondary_phone, num2, '(b) the number landed on the target');
    check(await rowExists('contacts', 'id', o2), '(b) O2 alive (no ghost-merge)');
    eq(await scalar(`SELECT count(*)::int FROM contact_emails WHERE contact_id = $1`, [o2]), 1, '(b) O2 otherwise untouched');
    eq((await mergedEvents(target2)).length, 0, '(b) no merge event');
});

// ---------------------------------------------------------------------------
CASE('TC-CM-I10', 's10', 'S10 double-submit of the confirmed retry → idempotent no-op (merge / transfer-phone / transfer-email)', async () => {
    // — merge —
    const addr = 'i10m@cm1.test';
    const dup = await mkContact(COMPANY_A, { name: 'S10 Dup', email: addr });
    await mkContactEmail(dup, addr, true);
    await mkTimeline(COMPANY_A, { contactId: dup });
    const t1 = await mkContact(COMPANY_A, { name: 'S10 T1', phone: nextPhone() });
    const m1 = await patchContact(t1, { emails: [{ email: addr, is_primary: true }] });
    eq(m1.status, 409, 'merge: round-1 409');
    const mergeBody = {
        emails: [{ email: addr, is_primary: true }],
        resolutions: echoResolutions(m1.body, { [String(dup)]: 'merge' }),
    };
    eq((await patchContact(t1, mergeBody)).status, 200, 'merge: round-2 200');
    await pollMergedEvent(t1);
    await settle();
    const mSnap = await snapshotCM1({ stripVolatile: true });
    const mAgain = await patchContact(t1, mergeBody); // double-submit
    eq(mAgain.status, 200, 'merge: repeated retry 200 (degrades to a plain save)');
    await settle();
    eqSnapshots(mSnap, await snapshotCM1({ stripVolatile: true }), 'merge: state identical after the double-submit');
    eq((await mergedEvents(t1)).length, 1, 'merge: NO second contact_merged event');

    // — transfer phone —
    const num = nextPhone();
    const owner = await mkContact(COMPANY_A, { name: 'S10 POwner', phone: num, secondaryPhone: nextPhone() });
    const ownerTl = await mkTimeline(COMPANY_A, { contactId: owner });
    await mkCall(COMPANY_A, { timelineId: ownerTl, contactId: owner, fromNumber: num, toNumber: '+15550005555' });
    const t2 = await mkContact(COMPANY_A, { name: 'S10 T2', phone: nextPhone() });
    const p1 = await patchContact(t2, { secondary_phone: num });
    eq(p1.status, 409, 'phone: round-1 409');
    const phoneBody = { secondary_phone: num, resolutions: echoResolutions(p1.body, { [String(owner)]: 'transfer' }) };
    eq((await patchContact(t2, phoneBody)).status, 200, 'phone: round-2 200');
    await settle();
    const pSnap = await snapshotCM1({ stripVolatile: true });
    eq((await patchContact(t2, phoneBody)).status, 200, 'phone: repeated retry 200');
    await settle();
    eqSnapshots(pSnap, await snapshotCM1({ stripVolatile: true }), 'phone: state identical after the double-submit');
    // direct primitive re-run → 0-row no-op.
    await merge.transferPhone(t2, owner, num, COMPANY_A);
    await settle();
    eqSnapshots(pSnap, await snapshotCM1({ stripVolatile: true }), 'phone: direct transferPhone re-run is a 0-row no-op');

    // — transfer email —
    const addr2 = 'i10e@cm1.test';
    const eOwner = await mkContact(COMPANY_A, { name: 'S10 EOwner', phone: nextPhone(), email: addr2 });
    await mkContactEmail(eOwner, addr2, true);
    await mkContactEmail(eOwner, 'i10keep@cm1.test', false);
    const t3 = await mkContact(COMPANY_A, { name: 'S10 T3', phone: nextPhone() });
    const e1 = await patchContact(t3, { emails: [{ email: addr2, is_primary: true }] });
    eq(e1.status, 409, 'email: round-1 409');
    const emailBody = {
        emails: [{ email: addr2, is_primary: true }],
        resolutions: echoResolutions(e1.body, { [String(eOwner)]: 'transfer' }),
    };
    eq((await patchContact(t3, emailBody)).status, 200, 'email: round-2 200');
    await settle();
    const eSnap = await snapshotCM1({ stripVolatile: true });
    eq((await patchContact(t3, emailBody)).status, 200, 'email: repeated retry 200');
    await settle();
    eqSnapshots(eSnap, await snapshotCM1({ stripVolatile: true }), 'email: state identical after the double-submit');
    await merge.transferEmail(t3, eOwner, addr2, COMPANY_A);
    await settle();
    eqSnapshots(eSnap, await snapshotCM1({ stripVolatile: true }), 'email: direct transferEmail re-run is a no-op');
});

// ---------------------------------------------------------------------------
CASE('TC-CM-I08', 's11', 'P0 SECURITY cross-tenant: detection-invisible, forged echo ignored, foreign :id → 404, service tenant-guard', async () => {
    await ensureCompany(COMPANY_B, 'cm1-b', 'CM1 Cross Co B');
    const sharedNum = nextPhone();
    const sharedAddr = 'shared11@cm1.test';

    // Company B world: contact BC owning the SAME number and address, with
    // B-scoped calls / messages / timeline / open task / lead.
    const bc = await mkContact(COMPANY_B, { name: 'S11 BC', phone: sharedNum, email: sharedAddr });
    await mkContactEmail(bc, sharedAddr, true);
    const bcTl = await mkTimeline(COMPANY_B, { contactId: bc });
    await mkCall(COMPANY_B, { timelineId: bcTl, contactId: bc, fromNumber: sharedNum, toNumber: '+15550006666' });
    const thB = await mkEmailThread(COMPANY_B, { subject: 'CM1 S11 B' });
    await mkEmailMessage(COMPANY_B, { threadId: thB, fromEmail: sharedAddr, contactId: bc, timelineId: bcTl, onTimeline: true });
    await seedOpenTask(COMPANY_B, { threadId: bcTl, contactId: bc, title: 'S11 B task' });
    await mkLead(COMPANY_B, { contactId: bc });

    const bBefore = await snapshotB();

    // Leg 1 — detection: A-PATCH adds BOTH values → 200, NO 409 (B invisible).
    // NOTE (pre-existing platform limitation, flagged to the owner — NOT a CM1
    // regression): on the DEV twilio_calls schema `uq_contacts_email` is a
    // GLOBAL (cross-company!) partial unique index from the pre-multitenant v3
    // base — there the SAME address can exist in two companies only via
    // contact_emails rows, never as both contacts' SCALAR email. The PROD
    // schema has no such index (scalar coexistence is fine). The realistic
    // shared-address shape portable to BOTH is therefore: saved on the A side
    // as a NON-primary row (own primary keeps the scalar). Leg 5 below probes
    // the schema and documents the scalar collision path per mode.
    const t = await mkContact(COMPANY_A, { name: 'S11 T', phone: nextPhone(), email: 'town11@cm1.test' });
    await mkContactEmail(t, 'town11@cm1.test', true);
    const r1 = await patchContact(t, {
        secondary_phone: sharedNum,
        emails: [{ email: 'town11@cm1.test', is_primary: true }, { email: sharedAddr }],
    });
    eq(r1.status, 200, 'leg 1: NO 409 — company-B owner invisible to detection');
    eq((await contactRow(t)).secondary_phone, sharedNum, 'leg 1: number saved on T');
    eq(await scalar(`SELECT count(*)::int FROM contact_emails WHERE contact_id = $1 AND email_normalized = $2`, [t, sharedAddr]), 1, 'leg 1: address saved on T');
    await settle();
    eq(await snapshotB(), bBefore, 'leg 1: company B byte-untouched');

    // Leg 2 — forged echo: a resolution naming the B contact matches no detected
    // conflict → ignored; B snapshot identical.
    const t2 = await mkContact(COMPANY_A, { name: 'S11 T2', phone: nextPhone() });
    const forged = await patchContact(t2, {
        first_name: 'CM1 S11',
        last_name: 'T2',
        resolutions: [{
            owner_contact_id: bc,
            action: 'merge',
            attributes: [{ kind: 'phone', value: sharedNum }, { kind: 'email', value: sharedAddr }],
        }],
    });
    eq(forged.status, 200, 'leg 2: forged echo ignored, plain save proceeds');
    check(await rowExists('contacts', 'id', bc), 'leg 2: BC alive');
    await settle();
    eq(await snapshotB(), bBefore, 'leg 2: company B snapshot identical (nothing read/re-pointed/deleted)');

    // Leg 3 — foreign :id → 404 with no B data leaked.
    const foreign = await patchContact(bc, { first_name: 'CM1 Hax' });
    eq(foreign.status, 404, 'leg 3: foreign :id → 404 (no existence leak)');
    eq(foreign.body.error.code, 'NOT_FOUND', 'leg 3: NOT_FOUND envelope');
    check(!JSON.stringify(foreign.body).includes('S11 BC'), 'leg 3: body leaks nothing of B');
    eq((await contactRow(bc)).full_name, 'CM1 S11 BC', 'leg 3: BC unmodified');

    // Leg 4 — service belt-and-braces: cross-tenant merge THROWS; transfers 0-row.
    let threw = false;
    try {
        await merge.mergeContacts(t, bc, COMPANY_A);
    } catch (e) {
        threw = /cross-tenant|company/i.test(e.message);
    }
    check(threw, 'leg 4: mergeContacts(A-target, B-dup) throws the tenant guard');
    await merge.transferPhone(t, bc, sharedNum, COMPANY_A);   // foreign owner → 0 rows
    await merge.transferEmail(t, bc, sharedAddr, COMPANY_A);  // foreign owner → 0 rows
    eq(await snapshotB(), bBefore, 'leg 4: transfers against a B owner touched 0 rows');

    // Leg 5 — the SCALAR collision path, SCHEMA-BRANCHED (portability probe):
    // writing an address that is a COMPANY-B contact's scalar as this
    // A-contact's scalar. On the DEV twilio_calls schema the pre-existing
    // GLOBAL `uq_contacts_email` (v3 base, cross-company — flagged to the
    // owner, NOT a CM1 regression) trips → 500 with a full rollback. On the
    // PROD schema that index does NOT exist → the save is a clean 200 and BOTH
    // companies hold the address independently. Either way, detection never
    // sees B and nothing of B may leak or change. (sharedAddr itself gained an
    // A-side owner in leg 1, so a fresh B-only scalar is used.)
    const bScalarAddr = 'bscalar11@cm1.test';
    const bScalar = await mkContact(COMPANY_B, { name: 'S11 BScalar', phone: nextPhone(), email: bScalarAddr });
    const bBefore2 = await snapshotB();
    const t1b = await mkContact(COMPANY_A, { name: 'S11 T1b', phone: nextPhone() });
    const r1b = await patchContact(t1b, { email: bScalarAddr });
    const r1bBody = JSON.stringify(r1b.body);
    check(!r1bBody.includes('S11 BC') && !r1bBody.includes(String(bc))
        && !r1bBody.includes('S11 BScalar') && !r1bBody.includes(String(bScalar)),
        'leg 5: response body leaks nothing of B');
    if (await hasGlobalUqContactsEmail()) {
        console.log('    [s11 leg 5] uq_contacts_email PRESENT (dev-schema mode: expect 500 + full rollback)');
        eq(r1b.status, 500, 'leg 5 (dev mode): global uq_contacts_email collision surfaces as 500 (pre-existing, documented)');
        eq((await contactRow(t1b)).email, null, 'leg 5 (dev mode): rollback — scalar not written');
        eq(await scalar(`SELECT count(*)::int FROM contact_emails WHERE contact_id = $1`, [t1b]), 0, 'leg 5 (dev mode): rollback — no row leaked');
    } else {
        console.log('    [s11 leg 5] uq_contacts_email ABSENT (prod-schema mode: expect 200; both companies hold the address independently)');
        eq(r1b.status, 200, 'leg 5 (prod mode): no global index → clean 200, B owner invisible to detection');
        eq((await contactRow(t1b)).email, bScalarAddr, 'leg 5 (prod mode): scalar written on the A contact');
        eq(await scalar(`SELECT count(*)::int FROM contact_emails WHERE contact_id = $1 AND email_normalized = $2`, [t1b, bScalarAddr]), 1,
            'leg 5 (prod mode): A-side contact_emails row created (Decision-E enrich)');
        eq((await contactRow(bScalar)).email, bScalarAddr, 'leg 5 (prod mode): B keeps its scalar address independently');
    }
    eq(await snapshotB(), bBefore2, 'leg 5: company B untouched by the A-side save');
});

// ---------------------------------------------------------------------------
CASE('TC-CM-I16', 's12', 'S12 self-conflict: re-saving own attributes = no dialog, no-op outcome', async () => {
    const num1 = nextPhone();
    const num2 = nextPhone();
    const addr = 'self12@cm1.test';
    const t = await mkContact(COMPANY_A, { name: 'S12 T', phone: num1, secondaryPhone: num2, email: addr });
    await mkContactEmail(t, addr, true);

    await settle();
    const before = await snapshotCM1({ stripVolatile: true });

    // scalar re-save of its own email + both own phones re-submitted.
    const r1 = await patchContact(t, { email: addr, phone_e164: num1, secondary_phone: num2 });
    eq(r1.status, 200, 'scalar re-save 200, no 409');
    // emails[] re-save of the same address.
    const r2 = await patchContact(t, { emails: [{ email: addr, is_primary: true }] });
    eq(r2.status, 200, 'emails[] re-save 200, no 409');
    // its own secondary number submitted as primary → self-conflict excluded (S12).
    const r3 = await patchContact(t, { phone_e164: num2 });
    eq(r3.status, 200, 'own secondary as primary: 200, no 409');
    // restore the original slots (still self-owned values → still no dialog).
    const r4 = await patchContact(t, { phone_e164: num1 });
    eq(r4.status, 200, 'restore 200');

    await settle();
    eqSnapshots(before, await snapshotCM1({ stripVolatile: true }), 'byte-identical outcome to today\'s re-save (sans volatile timestamps)');
    eq(await scalar(`SELECT count(*)::int FROM contact_emails WHERE contact_id = $1`, [t]), 1, 'no duplicate contact_emails row');
    eq((await mergedEvents(t)).length, 0, 'no merge event');
});

// ---------------------------------------------------------------------------
CASE('TC-CM-I17', 's13', 'S13 owner deleted between rounds: resolution ignored, attribute lands, stray messages linked', async () => {
    const addr = 'ghost13@cm1.test';
    const o = await mkContact(COMPANY_A, { name: 'S13 Ghost', phone: nextPhone(), email: addr });
    await mkContactEmail(o, addr, true);
    const oTl = await mkTimeline(COMPANY_A, { contactId: o });
    const th = await mkEmailThread(COMPANY_A, { subject: 'CM1 S13' });
    const m1 = await mkEmailMessage(COMPANY_A, { threadId: th, fromEmail: addr, contactId: o, timelineId: oTl, onTimeline: true });
    const target = await mkContact(COMPANY_A, { name: 'S13 T', phone: nextPhone() });

    const r1 = await patchContact(target, { emails: [{ email: addr, is_primary: true }] });
    eq(r1.status, 409, 'round-1 409');
    const echo = echoResolutions(r1.body, { [String(o)]: 'merge' });

    // …another session deletes O (his rows become unowned; timelines.contact_id
    // is SET NULL but the identity check needs a phone → delete his timeline
    // explicitly, message timeline_id SET NULLs with it).
    await db.query(`DELETE FROM timelines WHERE id = $1`, [oTl]);
    await db.query(`UPDATE email_messages SET contact_id = NULL, on_timeline = false WHERE contact_id = $1`, [o]);
    await db.query(`DELETE FROM contacts WHERE id = $1`, [o]); // contact_emails CASCADE

    const r2 = await patchContact(target, { emails: [{ email: addr, is_primary: true }], resolutions: echo });
    eq(r2.status, 200, 'ghost resolution ignored — save proceeds');
    eq(await scalar(`SELECT contact_id FROM contact_emails WHERE email_normalized = $1`, [addr]), target, 'address landed on the target');
    // resolveAddedEmail took the now-silent inbox-only branch → stray message linked.
    const s = await msgState(m1);
    eq(s.contact_id, target, 'stray message linked to the target');
    eq(s.on_timeline, true, 'stray message on the timeline');
    eq((await mergedEvents(target)).length, 0, 'no ghost-merge event');
});

// ---------------------------------------------------------------------------
CASE('TC-CM-I14', 's14', 'P0 S14 fault injection mid-resolution: FULL rollback on real Postgres; async legs never fired', async () => {
    // I07's two-resolution fixture: merge(A2) executes FIRST, transfer(B2) SECOND.
    const numA = nextPhone();
    const emailB = 'i14b@cm1.test';
    const a2 = await mkContact(COMPANY_A, { name: 'S14 A2', phone: numA });
    const a2Tl = await mkTimeline(COMPANY_A, { contactId: a2 });
    await mkCall(COMPANY_A, { timelineId: a2Tl, contactId: a2, fromNumber: numA, toNumber: '+15550008888' });
    await seedOpenTask(COMPANY_A, { threadId: a2Tl, title: 'S14 task' });
    const b2 = await mkContact(COMPANY_A, { name: 'S14 B2', phone: nextPhone(), email: emailB });
    await mkContactEmail(b2, emailB, true);
    const lead = await mkLead(COMPANY_A, { contactId: a2 });
    const target = await mkContact(COMPANY_A, { name: 'S14 T', phone: nextPhone() });

    const r1 = await patchContact(target, { secondary_phone: numA, emails: [{ email: emailB, is_primary: true }] });
    eq(r1.status, 409, 'round-1 409');
    eq(r1.body.conflict.conflicts.length, 2, 'two owners detected');
    const echo = echoResolutions(r1.body, { [String(a2)]: 'merge', [String(b2)]: 'transfer' });

    await settle();
    const before = await snapshotCM1();

    // CM1_FAIL_AFTER='mergeContacts' semantics: the SECOND resolution leg throws
    // AFTER the first (the merge) fully executed inside the tx. Implemented as a
    // one-shot monkey-patch of the SHARED service module instance (the same
    // require-cache object the route calls) — harness-only, no prod code.
    const realTransferEmail = merge.transferEmail;
    merge.transferEmail = async () => {
        throw new Error('CM1 injected fault (CM1_FAIL_AFTER=mergeContacts)');
    };
    let res;
    try {
        res = await patchContact(target, {
            secondary_phone: numA,
            emails: [{ email: emailB, is_primary: true }],
            resolutions: echo,
        });
    } finally {
        merge.transferEmail = realTransferEmail;
    }
    eq(res.status, 500, 'faulted round-2 → 500 (generic error, not a half-commit)');
    eq(res.body.error.code, 'INTERNAL_ERROR', 'existing errorResponse shape');

    // FULL rollback: the FIRST resolution (the merge) is undone too.
    await sleep(600); // any (wrongly) fired async leg would land within this window
    eqSnapshots(before, await snapshotCM1(), 'DB snapshot-identical: merge rolled back, contact UPDATE undone, nothing half-done');
    check(await rowExists('contacts', 'id', a2), 'A2 (merged-then-rolled-back) alive');
    check(await rowExists('timelines', 'id', a2Tl), 'A2 timeline alive');
    eq(await scalar(`SELECT contact_id FROM leads WHERE id = $1`, [lead]), a2, 'lead still on A2');
    eq((await mergedEvents(target)).length, 0, 'contact_merged NOT recorded (post-commit-only event)');

    // And the same retry WITHOUT the fault completes cleanly (fixture intact).
    const clean = await patchContact(target, {
        secondary_phone: numA,
        emails: [{ email: emailB, is_primary: true }],
        resolutions: echo,
    });
    eq(clean.status, 200, 'clean retry after the fault succeeds');
    check(!(await rowExists('contacts', 'id', a2)), 'A2 merged for real this time');
});

// ---------------------------------------------------------------------------
CASE('TC-CM-I12', 's15', 'S15 slot overflow: dropped numbers audited in contact_merged, their calls still move, SMS caveat, warn log', async () => {
    // Survivor with 2 phones. Dup owns the added EMAIL and carries 2 phones of
    // his own + calls + an SMS conversation on the number that will be dropped.
    const addr = 'over15@cm1.test';
    const survNum1 = nextPhone();
    const survNum2 = nextPhone();
    const dupNum1 = nextPhone();
    const dupNum2 = nextPhone();
    const surv = await mkContact(COMPANY_A, { name: 'S15 Surv', phone: survNum1, secondaryPhone: survNum2 });
    const dup = await mkContact(COMPANY_A, { name: 'S15 Dup', phone: dupNum1, secondaryPhone: dupNum2, email: addr });
    await mkContactEmail(dup, addr, true);
    const dupTl = await mkTimeline(COMPANY_A, { contactId: dup });
    const dropCall = await mkCall(COMPANY_A, { timelineId: dupTl, contactId: dup, fromNumber: dupNum1, toNumber: '+15550009999' });
    const smsDrop = await mkSmsConversation(COMPANY_A, { phone: dupNum1, lastAt: new Date().toISOString() });

    const r1 = await patchContact(surv, { emails: [{ email: addr, is_primary: true }] });
    eq(r1.status, 409, 'round-1 409');

    // capture the overflow warn log emitted inside the merge.
    const warns = [];
    const realWarn = console.warn;
    console.warn = (...args) => { warns.push(args.join(' ')); realWarn(...args); };
    let r2;
    try {
        r2 = await patchContact(surv, {
            emails: [{ email: addr, is_primary: true }],
            resolutions: echoResolutions(r1.body, { [String(dup)]: 'merge' }),
        });
    } finally {
        console.warn = realWarn;
    }
    eq(r2.status, 200, 'merge 200');

    // No slot overwritten — the survivor keeps exactly its own two numbers.
    const s = await contactRow(surv);
    eq(s.phone_e164, survNum1, 'survivor primary untouched');
    eq(s.secondary_phone, survNum2, 'survivor secondary untouched');

    // dropped_phones audited in the contact_merged event.
    const evs = await pollMergedEvent(surv);
    const dropped = evs[0].dropped_phones || [];
    check(dropped.includes(dupNum1) && dropped.includes(dupNum2), `event dropped_phones carries both dup numbers, got ${JSON.stringify(dropped)}`);
    check(warns.some(w => /overflow phone/i.test(w)), 'warn log emitted for the overflow');

    // The dropped number's CALLS still moved (they rode the dup timeline via 3b)…
    const survTl = await timelineOf(surv);
    eq(await scalar(`SELECT timeline_id FROM calls WHERE id = $1`, [dropCall]), survTl, 'dropped-number call moved to survivor timeline');
    eq(await scalar(`SELECT contact_id FROM calls WHERE id = $1`, [dropCall]), surv, 'dropped-number call on survivor contact');

    // …its SMS conversation no longer surfaces on the survivor's Pulse row
    // (query-time digit match — documented v1 limitation) while the row is NOT deleted.
    check(await rowExists('sms_conversations', 'id', smsDrop), 'SMS conversation row NOT deleted');
    await settle();
    const rows = await timelinesQueries.getUnifiedTimelinePage({ limit: 2000, offset: 0, companyId: COMPANY_A });
    const survRow = rows.find(r => Number(r.timeline_id) === Number(survTl));
    check(survRow, 'survivor surfaces on the list');
    check(String(survRow.sms_conversation_id || '') !== String(smsDrop), 'dropped-number SMS does NOT surface on the survivor row');

    const offenders = await danglingRefs(dup, [dupTl]);
    check(offenders.length === 0, `dangling: ${offenders.join(', ')}`);
});

// ---------------------------------------------------------------------------
CASE('TC-CM-I13', 's16', 'P0 S16 silent branches byte-for-byte: D3 inbox-only, orphan mergeOrphanTimelines, ingestion never throws', async () => {
    // Leg 1 — D3 inbox-only: nobody owns the address; 2 unowned messages → the
    // PATCH links them silently, 200, NO 409 (TC-CEM-I01 behavior re-asserted).
    const addr = 'd316@cm1.test';
    const t1 = await mkContact(COMPANY_A, { name: 'S16 T1', phone: nextPhone() });
    const th = await mkEmailThread(COMPANY_A, { subject: 'CM1 S16 d3' });
    const m1 = await mkEmailMessage(COMPANY_A, { threadId: th, fromEmail: addr });
    const m2 = await mkEmailMessage(COMPANY_A, { threadId: th, fromEmail: ` ${addr.toUpperCase()} ` });
    const r1 = await patchContact(t1, { emails: [{ email: addr, is_primary: true }] });
    eq(r1.status, 200, 'leg 1: inbox-only add → 200, NO dialog');
    const t1Tl = await timelineOf(t1);
    for (const [lbl, pm] of [['m1', m1], ['m2', m2]]) {
        const s = await msgState(pm);
        eq(s.contact_id, t1, `leg 1: ${lbl} linked to target`);
        eq(s.timeline_id, t1Tl, `leg 1: ${lbl} on target timeline`);
        eq(s.on_timeline, true, `leg 1: ${lbl} on_timeline`);
    }

    // Leg 2 — orphan phones: an ownerless orphan timeline on the number a PATCH
    // gives the contact is adopted by the async post-commit mergeOrphanTimelines
    // (byte-for-byte, no dialog); ALSO after a TRANSFER the just-gained number's
    // orphan is adopted the same way.
    const numO = nextPhone();
    const orphanTl = await mkTimeline(COMPANY_A, { phone: numO }); // contact_id NULL
    const orphanCall = await mkCall(COMPANY_A, { timelineId: orphanTl, fromNumber: numO, toNumber: '+15550001010' });
    const t2 = await mkContact(COMPANY_A, { name: 'S16 T2', phone: nextPhone() });
    const r2 = await patchContact(t2, { secondary_phone: numO });
    eq(r2.status, 200, 'leg 2: no owner → plain 200 save');
    // poll the async adoption: the orphan either gets contact_id=t2 or is merged
    // away with its calls re-pointed onto t2's timeline.
    let adopted = false;
    for (let i = 0; i < 30 && !adopted; i++) {
        const own = await scalar(`SELECT contact_id FROM timelines WHERE id = $1`, [orphanTl]);
        if (String(own) === String(t2)) adopted = true;
        else if (own == null && !(await rowExists('timelines', 'id', orphanTl))) {
            const callTl = await scalar(`SELECT timeline_id FROM calls WHERE id = $1`, [orphanCall]);
            const t2Tl = await timelineOf(t2);
            if (String(callTl) === String(t2Tl)) adopted = true;
        }
        if (!adopted) await sleep(150);
    }
    check(adopted, 'leg 2: mergeOrphanTimelines adopted the orphan post-commit (byte-for-byte async leg)');

    // Leg 2b — after a transfer, the target's just-gained number's orphan is adopted.
    const numT = nextPhone();
    const owner = await mkContact(COMPANY_A, { name: 'S16 Owner', phone: numT, secondaryPhone: nextPhone() });
    const orphanTl2 = await mkTimeline(COMPANY_A, { phone: numT });
    const t3 = await mkContact(COMPANY_A, { name: 'S16 T3', phone: nextPhone() });
    const tr1 = await patchContact(t3, { secondary_phone: numT });
    eq(tr1.status, 409, 'leg 2b: 409 (owner exists)');
    const tr2 = await patchContact(t3, {
        secondary_phone: numT,
        resolutions: echoResolutions(tr1.body, { [String(owner)]: 'transfer' }),
    });
    eq(tr2.status, 200, 'leg 2b: transfer 200');
    let adopted2 = false;
    for (let i = 0; i < 30 && !adopted2; i++) {
        const own = await scalar(`SELECT contact_id FROM timelines WHERE id = $1`, [orphanTl2]);
        if (String(own) === String(t3) || own === null && !(await rowExists('timelines', 'id', orphanTl2))) adopted2 = true;
        if (!adopted2) await sleep(150);
    }
    check(adopted2, 'leg 2b: post-transfer orphan of the just-gained number adopted');

    // Leg 3 — ingestion path: the REAL linkInboundMessage with an address owned
    // by ANOTHER contact links silently onto the OWNER (background never dialogs,
    // never throws ContactConflictError).
    const addrI = 'ing16@cm1.test';
    const ownerI = await mkContact(COMPANY_A, { name: 'S16 IngOwner', phone: nextPhone(), email: addrI });
    await mkContactEmail(ownerI, addrI, true);
    const thI = await mkEmailThread(COMPANY_A, { subject: 'CM1 S16 ing' });
    const pmid = await mkEmailMessage(COMPANY_A, { threadId: thI, fromEmail: addrI });
    const { linkInboundMessage } = require(path.join(ROOT, 'backend/src/services/email/emailTimelineService'));
    let out;
    try {
        out = await linkInboundMessage(COMPANY_A, {
            provider_message_id: pmid,
            from_email: addrI,
            is_outbound: false,
            labelIds: ['INBOX'],
            internal_at: new Date().toISOString(),
        }, { skipAgent: true });
    } catch (e) {
        throw new CheckError(`leg 3: ingestion THREW (${e.name}: ${e.message}) — the sentinel must never reach ingestion`);
    }
    check(out && out.linked === true, `leg 3: ingestion linked silently, got ${JSON.stringify(out)}`);
    eq(out.contactId, ownerI, 'leg 3: linked onto the OWNER (background behavior unchanged)');
});

// ---------------------------------------------------------------------------
CASE('TC-CM-I15', 's16', 'S16 Pulse list after merge/transfer: dup row gone, survivor surfaces, thread flips — UNCHANGED query', async () => {
    // Merge leg: dup with an email thread on his timeline → after the merge his
    // row disappears and the SURVIVOR's row surfaces via the unchanged
    // email_by_contact CTE.
    const addr = 'p15@cm1.test';
    const dup = await mkContact(COMPANY_A, { name: 'S15p Dup', email: addr });
    await mkContactEmail(dup, addr, true);
    const dupTl = await mkTimeline(COMPANY_A, { contactId: dup });
    const th = await mkEmailThread(COMPANY_A, { subject: 'CM1 S15p', lastAt: new Date().toISOString(), unread: 1 });
    await mkEmailMessage(COMPANY_A, { threadId: th, fromEmail: addr, contactId: dup, timelineId: dupTl, onTimeline: true });
    const surv = await mkContact(COMPANY_A, { name: 'S15p Surv', phone: nextPhone() });

    const r1 = await patchContact(surv, { emails: [{ email: addr, is_primary: true }] });
    eq(r1.status, 409, 'merge leg: 409');
    const r2 = await patchContact(surv, {
        emails: [{ email: addr, is_primary: true }],
        resolutions: echoResolutions(r1.body, { [String(dup)]: 'merge' }),
    });
    eq(r2.status, 200, 'merge leg: 200');

    // Transfer leg: owner's number with an SMS conversation flips to the target row.
    const num = nextPhone();
    const owner = await mkContact(COMPANY_A, { name: 'S15p Owner', phone: num, secondaryPhone: nextPhone() });
    const ownerTl = await mkTimeline(COMPANY_A, { contactId: owner });
    await mkCall(COMPANY_A, { timelineId: ownerTl, contactId: owner, fromNumber: num, toNumber: '+15550002020' });
    const sms = await mkSmsConversation(COMPANY_A, { phone: num, lastAt: new Date().toISOString() });
    const t1 = await patchContact(surv, { secondary_phone: num });
    eq(t1.status, 409, 'transfer leg: 409');
    const t2 = await patchContact(surv, {
        secondary_phone: num,
        resolutions: echoResolutions(t1.body, { [String(owner)]: 'transfer' }),
    });
    eq(t2.status, 200, 'transfer leg: 200');

    await settle();
    // THE unchanged master-shape function (TC-R-3): no query change needed.
    const rows = await timelinesQueries.getUnifiedTimelinePage({ limit: 2000, offset: 0, companyId: COMPANY_A });
    check(!rows.some(r => Number(r.timeline_id) === Number(dupTl)), 'dup conversation row GONE from the list');
    const survTl = await timelineOf(surv);
    const survRow = rows.find(r => Number(r.timeline_id) === Number(survTl));
    check(survRow, 'survivor row present');
    eq(survRow.email_thread_id, th, 'survivor row carries the merged email thread');
    eq(survRow.sms_conversation_id, sms, 'transferred number\'s SMS thread under the survivor row');
    const ownerRow = rows.find(r => Number(r.timeline_id) === Number(ownerTl));
    if (ownerRow) {
        check(String(ownerRow.sms_conversation_id || '') !== String(sms), 'SMS thread NOT under the owner row anymore');
    }
});

// ---------------------------------------------------------------------------
// TC-CM-ISAB — sabotage negative controls (P0, two legs).
// ---------------------------------------------------------------------------
CASE('TC-CM-ISAB-1', 'sab', 'sabotage (wrong-expectation): a deliberately-wrong assert MUST trip a FAIL, then restore green', async () => {
    // Run a real merge, then assert KNOWN-WRONG expectations through the SAME
    // assert kit and require them to throw.
    const addr = 'sab1@cm1.test';
    const dup = await mkContact(COMPANY_A, { name: 'SAB Dup', email: addr });
    await mkContactEmail(dup, addr, true);
    const dupTl = await mkTimeline(COMPANY_A, { contactId: dup });
    const target = await mkContact(COMPANY_A, { name: 'SAB Target', phone: nextPhone() });
    const r1 = await patchContact(target, { emails: [{ email: addr, is_primary: true }] });
    eq(r1.status, 409, 'setup 409');
    const r2 = await patchContact(target, {
        emails: [{ email: addr, is_primary: true }],
        resolutions: echoResolutions(r1.body, { [String(dup)]: 'merge' }),
    });
    eq(r2.status, 200, 'setup merge 200');

    // (1) wrong: "the dup still exists" → must throw CheckError.
    let threw1 = false;
    try {
        check(await rowExists('contacts', 'id', dup), 'SABOTAGE: dup should be gone but we assert present');
    } catch (e) {
        threw1 = e instanceof CheckError;
    }
    check(threw1, 'SABOTAGE FAILED TO TRIP (existence): the detector did not throw on a wrong expectation');

    // (2) wrong: "dangling-FK count = 999" → must throw CheckError.
    let threw2 = false;
    try {
        const offenders = await danglingRefs(dup, [dupTl]); // truly [] (clean)
        eq(offenders.length, 999, 'SABOTAGE: real dangling is 0 but we assert 999');
    } catch (e) {
        threw2 = e instanceof CheckError;
    }
    check(threw2, 'SABOTAGE FAILED TO TRIP (dangling): the detector did not throw on a wrong count');

    // (3) restore the TRUE expectations → green.
    check(!(await rowExists('contacts', 'id', dup)), 'restored: dup truly deleted');
    const offenders = await danglingRefs(dup, [dupTl]);
    check(offenders.length === 0, `restored: zero dangling (found ${offenders.join(', ')})`);
});

// ---------------------------------------------------------------------------
CASE('TC-CM-ISAB-2', 'sab', 'sabotage (амендмент #5, feature-neutralize): byte-neutralize the merge service → s1/s5/s8 MUST FAIL → restore bytes → green', async () => {
    // The feature is COMMITTED to HEAD now, so the old `git stash push`
    // mechanism has nothing to stash (empty diff → children stay green →
    // vacuous sabotage). Instead: byte-level neutralization, NO git — read the
    // service into memory, write a temporarily sabotaged version in place
    // (detection returns [] AND the Decision-B sentinel is silenced), run the
    // s1/s5/s8 children (fresh processes require the file from disk), then
    // restore the original bytes in a finally and sha-verify the restore. The
    // parent's own require-cache instance keeps the original code throughout.
    if (process.env.CM1_CHILD) {
        record('TC-CM-ISAB-2', 'SKIP', 'child process — feature-neutralize runs only in the parent');
        return;
    }
    const fs = require('fs');
    const SERVICE = path.join(ROOT, 'backend/src/services/contactEmailMergeService.js');
    const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
    const original = fs.readFileSync(SERVICE);
    const originalSha = sha256(original);

    const src = original.toString('utf8');
    // Seam 1: detectAttributeConflicts reports "no conflicts" (round-1 409 gone).
    const anchor1 = 'async function detectAttributeConflicts(targetContactId, added = {}, companyId, client = db) {';
    // Seam 2: the in-tx Decision-B sentinel in resolveAddedEmail never throws
    // (the fresh-409 backstop gone too — pre-feature silent world).
    const anchor2 = 'throw new ContactConflictError(owner.id, [\n' +
        '        { kind: \'email\', value: normalized, normalized },\n' +
        '    ]);';
    check(src.includes(anchor1), 'sab-2: detection anchor present in the service source');
    check(src.includes(anchor2), 'sab-2: sentinel anchor present in the service source');
    const sabotaged = src
        .replace(anchor1, anchor1 + '\n    return []; // CM1-ISAB-2 TEMPORARY SABOTAGE — must never survive the run')
        .replace(anchor2, 'return; // CM1-ISAB-2 TEMPORARY SABOTAGE — sentinel silenced');
    check(sabotaged !== src && sha256(Buffer.from(sabotaged, 'utf8')) !== originalSha,
        'sab-2: sabotage actually changed the bytes');

    const runChild = (section) => spawnSync(process.execPath, [__filename, `--section=${section}`], {
        cwd: ROOT,
        env: { ...process.env, CM1_CHILD: '1' },
        encoding: 'utf8',
        timeout: 180000,
    });

    console.log('    [sab-2] writing the byte-neutralized service (detection→[] + sentinel silenced; no git)…');
    const sabotagedExits = {};
    try {
        fs.writeFileSync(SERVICE, sabotaged);
        for (const s of ['s1', 's5', 's8']) {
            const r = runChild(s);
            sabotagedExits[s] = r.status;
            console.log(`    [sab-2] sabotaged run --section=${s} → exit ${r.status}`);
        }
    } finally {
        fs.writeFileSync(SERVICE, original);
        const restoredSha = sha256(fs.readFileSync(SERVICE));
        if (restoredSha !== originalSha) {
            throw new Error(`sab-2 CRITICAL: restore mismatch — sha ${restoredSha} != original ${originalSha}`);
        }
        console.log('    [sab-2] original bytes restored (sha256 verified)');
    }
    for (const s of ['s1', 's5', 's8']) {
        check(sabotagedExits[s] === 1,
            `--section=${s} with the service NEUTRALIZED must exit 1 (recorded FAILs); got exit ${sabotagedExits[s]}. ` +
            'A harness that stays green against the pre-feature world makes every PASS vacuous → release blocked.');
    }

    // Restored world → the same sections must be green again.
    for (const s of ['s1', 's5', 's8']) {
        const r = runChild(s);
        console.log(`    [sab-2] restored run --section=${s} → exit ${r.status}`);
        check(r.status === 0, `--section=${s} after restore must exit 0; got ${r.status}\n${(r.stdout || '').slice(-1500)}`);
    }
});

// ---------------------------------------------------------------------------
// TC-CM-I18 (dev FORM probe) — plan shape with SET enable_seqscan = off.
// Амендмент #7: on the dev DB a Seq Scan produced by the COST model is not an
// auto-fail — we force the planner (enable_seqscan=off) and assert the FORM:
// the full-digit detection legs MUST be servable by the mig-149 expression
// indexes, and the transfer call-filter by idx_calls_timeline_id. The last-10
// fallback is documented (accepted bounded per-Save cost per architecture).
// The FULL volumetric I18 gate (EXPLAIN ANALYZE, BUFFERS on a prod-copy
// restore) is deploy-gated — owner consent required; NOT run here.
// ---------------------------------------------------------------------------
CASE('TC-CM-I18-dev', 'explain', 'I18 dev form-probe: detection full-digit legs = mig-149 BitmapOr; calls filter = idx_calls_timeline_id; last-10 + legacy 4-leg documented', async () => {
    const plan = async (sql, params) => {
        const r = await db.query(`EXPLAIN ${sql}`, params);
        return r.rows.map(x => x['QUERY PLAN']).join('\n');
    };
    await db.query('SET enable_seqscan = off');
    try {
        // (0) the PRE-FIX 4-leg OR — documented evidence for review finding #5:
        // even with seqscan disabled the planner cannot use the digit indexes.
        const legacy = await plan(
            `SELECT id FROM contacts
              WHERE company_id = $1 AND id <> $2
                AND (NULLIF(regexp_replace(phone_e164, '\\D', '', 'g'), '') = $3
                  OR NULLIF(regexp_replace(secondary_phone, '\\D', '', 'g'), '') = $3
                  OR RIGHT(NULLIF(regexp_replace(phone_e164, '\\D', '', 'g'), ''), 10) = $4
                  OR RIGHT(NULLIF(regexp_replace(secondary_phone, '\\D', '', 'g'), ''), 10) = $4)
              ORDER BY updated_at DESC NULLS LAST, id ASC LIMIT 1`,
            [COMPANY_A, 1, '16175550022', '6175550022']);
        console.log('── legacy 4-leg OR (finding #5 evidence — NOT the shipped shape):\n' + legacy);
        check(!/idx_contacts_phone_digits/.test(legacy),
            'finding #5 sanity: the 4-leg OR indeed cannot use the mig-149 expression indexes (if this trips, the finding is obsolete — re-evaluate the split)');

        // (1) the SHIPPED full-digit query (query 1 of the split lookup).
        const full = await plan(
            `SELECT id FROM contacts
              WHERE company_id = $1 AND id <> $2
                AND (NULLIF(regexp_replace(phone_e164, '\\D', '', 'g'), '') = $3
                  OR NULLIF(regexp_replace(secondary_phone, '\\D', '', 'g'), '') = $3)
              ORDER BY updated_at DESC NULLS LAST, id ASC LIMIT 1`,
            [COMPANY_A, 1, '16175550022']);
        console.log('── detection full-digit legs (shipped query 1):\n' + full);
        check(/idx_contacts_phone_digits/.test(full), 'full-digit plan uses idx_contacts_phone_digits');
        check(/idx_contacts_secondary_phone_digits/.test(full), 'full-digit plan uses idx_contacts_secondary_phone_digits');
        check(!/Seq Scan on contacts/.test(full), 'no Seq Scan on contacts in the forced full-digit plan');

        // (2) the last-10 fallback (query 2, runs only on a full-digit miss) —
        // documented fact-plan; per architecture this is the accepted bounded
        // per-Save cost, NOT an auto-fail on dev (амендмент #7).
        const last10 = await plan(
            `SELECT id FROM contacts
              WHERE company_id = $1 AND id <> $2
                AND (RIGHT(NULLIF(regexp_replace(phone_e164, '\\D', '', 'g'), ''), 10) = $3
                  OR RIGHT(NULLIF(regexp_replace(secondary_phone, '\\D', '', 'g'), ''), 10) = $3)
              ORDER BY updated_at DESC NULLS LAST, id ASC LIMIT 1`,
            [COMPANY_A, 1, '6175550022']);
        console.log('── detection last-10 fallback (query 2, miss-only — documented, accepted per-Save cost):\n' + last10);

        // (3) the transferPhone calls filter (as a SELECT).
        const callsPlan = await plan(
            `SELECT id FROM calls
              WHERE timeline_id = ANY($1) AND company_id = $2
                AND (RIGHT(NULLIF(regexp_replace(from_number, '\\D', '', 'g'), ''), 10) = $3
                  OR RIGHT(NULLIF(regexp_replace(to_number, '\\D', '', 'g'), ''), 10) = $3)`,
            [[1, 2], COMPANY_A, '6175550022']);
        console.log('── transferPhone calls filter:\n' + callsPlan);
        check(/idx_calls_timeline_id/.test(callsPlan), 'calls filter uses idx_calls_timeline_id');
        check(!/Seq Scan on calls/.test(callsPlan), 'no Seq Scan on calls in the forced plan');

        console.log('NOTE: full I18 (EXPLAIN (ANALYZE, BUFFERS) at prod scale) runs on a prod-copy restore ONLY — deploy-gated, explicit owner consent.');
    } finally {
        await db.query('RESET enable_seqscan');
    }
});

// ═════════════════════════════════════════════════════════════════════════════
// Runner
// ═════════════════════════════════════════════════════════════════════════════

function parseArgs() {
    const sectionArg = process.argv.find(a => a.startsWith('--section='));
    const section = sectionArg ? sectionArg.split('=')[1] : 'all';
    const explain = process.argv.includes('--explain');
    return { section, explain };
}

async function main() {
    const { section, explain } = parseArgs();
    // `all` = every DB-behavior section + sabotage; the explain form-probe joins
    // only via --explain / --section=explain (the FULL I18 is prod-copy/deploy-gated).
    const selected = CASES.filter(c => {
        if (c.section === 'explain') return explain || section === 'explain' || c.id === section;
        if (section === 'all') return true;
        return c.section === section || c.id === section;
    });
    if (selected.length === 0) {
        console.error(`No cases match --section=${section}. Sections: ${[...new Set(CASES.map(c => c.section))].join(', ')}, all`);
        process.exit(2);
    }

    console.log(`CONTACT-MERGE-001 verify — DATABASE_URL=${process.env.DATABASE_URL}`);
    console.log(`Company A=${COMPANY_A} (seed, delta/tagged asserts) · Company B=${COMPANY_B} (tagged, temp)`);
    console.log(`Cases: ${section}${explain ? ' +explain' : ''} → ${selected.length}\n`);

    await cleanupAll();

    for (const c of selected) {
        await cleanupAll();
        try {
            await c.fn();
            // a case may self-record (SKIP) — don't double-record it.
            if (!results.some(r => r.id === c.id)) record(c.id, 'PASS', c.title);
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
