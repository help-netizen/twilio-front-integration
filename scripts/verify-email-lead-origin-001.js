#!/usr/bin/env node
/**
 * EMAIL-LEAD-ORIGIN-001 — T4 real-DB integration + security verify script.
 *
 * The LOAD-BEARING verification: this feature lets a lead be born from an email
 * with NO phone, and adds a by-contact lookup. Mocked jest only checks the SQL
 * string / dispatch shape (LIST-PAGINATION-001 / created_by-FK lessons) — it can
 * NOT prove that a phoneless row landed with `phone` NULL (not '' / not a
 * fabricated +1…), that getLeadByContact returned the right lead, or that a
 * foreign-company contactId is excluded. Those are proven here against a local
 * Postgres, self-seeding / self-cleaning by the unique tag ELO1.
 *
 * The real functions exercised (unmocked; no Zenbooker/Gmail — the create path is
 * exercised at the service boundary leadsService.createLead, leads are seeded via
 * real INSERTs for status control incl. Lost/Converted):
 *   • leadsService.getLeadByContact  (the NEW lookup — the star of the section)
 *   • leadsService.getLeadByPhone     (S8 regression — must be byte-identical on the same seed)
 *   • leadsService.createLead         (phoneless + phone-origin)
 *   • leadsService.listLeads          (S6 — email-origin lead lists on the Leads page)
 *
 * Cases (Docs/test-cases/EMAIL-LEAD-ORIGIN-001.md):
 *   s4      TC-ELO-I01  **P0 must-pass** phoneless create → row has phone NULL,
 *                       email set, contact_id set, linked to the SAME contact (no fabricated phone)
 *   s2      TC-ELO-I02/I03/I04/I10  **P0** lookup correctness: open lead returned;
 *                       null when contact has a JOB; null when only lead is Lost/Converted;
 *                       newest OPEN wins; no-dup (open lead present → truthy before any create)
 *   s7      TC-ELO-I05/I06  **P0 SECURITY** cross-tenant: getLeadByContact(BC, A) → null,
 *                       B's lead never returned/read/mutated for company A; symmetric
 *   s8      TC-ELO-I07/I08  regression: getLeadByPhone byte-identical before/after a phoneless
 *                       lead is added for a different contact; phone-origin createLead unchanged
 *   s6      TC-ELO-I09  email-origin lead lists on the Leads page + on the contact (round-trip)
 *   explain TC-ELO-I11  EXPLAIN getLeadByContact uses idx_leads_contact_id (no Seq Scan at scale)
 *   sab     TC-ELO-ISAB sabotage negative control — a deliberately-wrong expectation MUST trip
 *                       a FAIL (phone == fabricated +1…, or cross-tenant lead returned), then restore
 *
 * Company A = seed 00000000-0000-0000-0000-000000000001 (real dev rows coexist →
 * assertions are row-targeted by the tagged contact/lead id or delta, never
 * absolute whole-company counts). Company B = tagged
 * c0000000-0000-4000-8000-0000000000f1, CREATED + deleted here (cross-tenant).
 *
 * Usage:
 *   node scripts/verify-email-lead-origin-001.js [--section=s2|s4|s6|s7|s8|explain|sab|all]
 *   DATABASE_URL defaults to postgresql://localhost/twilio_calls (house default).
 * Never point this at prod. Exit code 0 only when no case FAILs.
 */
'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/twilio_calls';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const db = require(path.join(ROOT, 'backend/src/db/connection'));
const leadsService = require(path.join(ROOT, 'backend/src/services/leadsService'));

const COMPANY_A = '00000000-0000-0000-0000-000000000001'; // seed company (real dev data coexists)
const COMPANY_B = 'c0000000-0000-4000-8000-0000000000f1'; // tagged, created+deleted here

// ─── tiny assert/report kit (mirrors verify-tasks-count-001.js / verify-contact-email-merge-001.js) ──

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

// ─── seeding helpers (all tagged ELO1) ──────────────────────────────────────

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

// A tagged contact (full_name prefixed 'ELO1 ' for cleanup). A phoneless
// email-origin contact gets phone_e164 NULL; a phone contact gets one.
async function mkContact(companyId, { name = 'Contact', phone = null, email = null } = {}) {
    const r = await db.query(
        `INSERT INTO contacts (full_name, phone_e164, email, company_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [`ELO1 ${name}`, phone, email, companyId]
    );
    return r.rows[0].id;
}

// A lead seeded via a DIRECT INSERT so we control status (incl. Lost/Converted)
// and phone/email/contact_id exactly. uuid is varchar(20) NOT NULL UNIQUE — keep
// the tagged value short ('elo1…') + unique. phone omitted → NULL (phoneless).
let leadSeq = 0;
async function mkLead(companyId, { contactId = null, status = 'Submitted', phone = null, email = null } = {}) {
    leadSeq += 1;
    const uuid = `elo1${leadSeq}-${Date.now()}`.slice(0, 20);
    const r = await db.query(
        `INSERT INTO leads (uuid, company_id, contact_id, status, phone, email)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [uuid, companyId, contactId, status, phone, email]
    );
    return r.rows[0].id;
}

// A job on a contact — the "contact has a job → getLeadByContact returns null" trap.
async function mkJob(companyId, { contactId = null } = {}) {
    const r = await db.query(
        `INSERT INTO jobs (company_id, contact_id) VALUES ($1, $2) RETURNING id`,
        [companyId, contactId]
    );
    return r.rows[0].id;
}

// ─── cleanup (FK order; run before every case + at start/end) ───────────────
// jobs → leads → contacts → companies. leads.contact_id is a plain REFERENCES
// (no CASCADE) so tagged/B-scoped leads must be deleted BEFORE the contacts they
// point at. Tagged ELO1 everywhere; company B is nuked wholesale.

async function cleanupAll() {
    const taggedContacts = `SELECT id FROM contacts WHERE full_name LIKE 'ELO1 %'`;

    // jobs first (they carry contact_id → block the contacts delete otherwise).
    await db.query(`DELETE FROM jobs WHERE contact_id IN (${taggedContacts})`);
    await db.query(`DELETE FROM jobs WHERE company_id = $1`, [COMPANY_B]);

    // leads: tagged uuid, or hung on a tagged contact, or company B.
    await db.query(`DELETE FROM leads WHERE uuid LIKE 'elo1%'`);
    await db.query(`DELETE FROM leads WHERE contact_id IN (${taggedContacts})`);
    await db.query(`DELETE FROM leads WHERE company_id = $1`, [COMPANY_B]);

    // contacts last among entities.
    await db.query(`DELETE FROM contacts WHERE full_name LIKE 'ELO1 %'`);

    // company B row (CASCADE mops any straggler child rows).
    await db.query(`DELETE FROM companies WHERE id = $1`, [COMPANY_B]);
}

// ─── shared probes ──────────────────────────────────────────────────────────

async function scalar(sql, params = []) {
    const r = await db.query(sql, params);
    return r.rows[0] ? Object.values(r.rows[0])[0] : null;
}

async function leadRow(id) {
    const r = await db.query(
        `SELECT id, phone, email, contact_id, company_id, status FROM leads WHERE id = $1`,
        [id]
    );
    return r.rows[0] || null;
}

// ═════════════════════════════════════════════════════════════════════════════
// Cases
// ═════════════════════════════════════════════════════════════════════════════

const CASES = [];
function CASE(id, section, title, fn) {
    CASES.push({ id, section, title, fn });
}

// ---------------------------------------------------------------------------
// s4 — TC-ELO-I01 — P0 must-pass: phoneless create stores phone NULL / email /
// contact_id, linked to the SAME contact, no fabricated phone. This is the load-
// bearing gate: mocks can prove the column was omitted from the SQL string, only
// the real INSERT proves the row landed with phone IS NULL.
// ---------------------------------------------------------------------------
CASE('TC-ELO-I01', 's4', 'S4 P0 phoneless create → row phone NULL, email set, contact_id set, linked to C (no fabricated phone)', async () => {
    // A phoneless target contact C (phone_e164 NULL, email on file); no lead yet.
    const C = await mkContact(COMPANY_A, { name: 'I01 Target', email: 'elo1@elo1.test' });
    eq(await scalar(`SELECT phone_e164 FROM contacts WHERE id = $1`, [C]), null, 'contact C starts phoneless (phone_e164 NULL)');
    eq(await leadsService.getLeadByContact(C, COMPANY_A), null, 'no lead for C before create');

    // Run the REAL phoneless create at the service boundary (no Phone key at all).
    const created = await leadsService.createLead(
        { FirstName: 'ELO1', Email: 'elo1@elo1.test', contact_id: C },
        COMPANY_A
    );
    const id = Number(created.ClientId);
    check(Number.isInteger(id) && id > 0, `createLead returned a numeric ClientId, got ${JSON.stringify(created.ClientId)}`);

    // The stored row: phone IS NULL (not '' / not a fabricated +1…), email + contact_id + company_id set.
    const row = await leadRow(id);
    check(row != null, 'the created lead row exists');
    check(row.phone === null, `stored phone MUST be NULL (no fabricated phone), got ${JSON.stringify(row.phone)}`);
    eq(row.email, 'elo1@elo1.test', 'stored email');
    eq(row.contact_id, C, 'stored contact_id = C');
    eq(row.company_id, COMPANY_A, 'stored company_id = A');

    // Linked to the SAME phoneless contact — no new/duplicate contact created; C still phoneless.
    eq(await scalar(`SELECT count(*)::int FROM contacts WHERE full_name LIKE 'ELO1 %'`), 1, 'no duplicate contact created (still exactly the one tagged contact)');
    eq(await scalar(`SELECT phone_e164 FROM contacts WHERE id = $1`, [C]), null, 'contact C is STILL phoneless (create did not backfill a phone)');

    // The lead is retrievable via the by-contact lookup (C has no job) — proves it
    // surfaces on the contact card (AC-4). getLeadByContact returns rowToLead shape.
    const found = await leadsService.getLeadByContact(C, COMPANY_A);
    check(found != null, 'the phoneless lead is retrievable via getLeadByContact');
    eq(found.ClientId, id, 'getLeadByContact returns the just-created lead');
    check(found.Phone === null, 'the retrieved lead has Phone null (no fabrication in read path either)');
    eq(found.Email, 'elo1@elo1.test', 'retrieved lead Email');
});

// ---------------------------------------------------------------------------
// s2 — TC-ELO-I02/I03/I04/I10 — P0 lookup correctness. Mirrors getLeadByPhone's
// filters exactly (status NOT IN Lost/Converted, job post-filter, newest OPEN).
// ---------------------------------------------------------------------------
CASE('TC-ELO-I02', 's2', 'S2 P0 getLeadByContact returns the OPEN lead for the contact (ClientId, Status)', async () => {
    const C = await mkContact(COMPANY_A, { name: 'I02 C', email: 'i02@elo1.test' });
    const L = await mkLead(COMPANY_A, { contactId: C, status: 'Submitted', email: 'i02@elo1.test' });

    const lead = await leadsService.getLeadByContact(C, COMPANY_A);
    check(lead != null, 'getLeadByContact returns a lead');
    eq(lead.ClientId, L, 'ClientId === L (the open lead)');
    eq(lead.ContactId, C, 'ContactId === C');
    eq(lead.Status, 'Submitted', 'Status = Submitted');
});

// ---------------------------------------------------------------------------
CASE('TC-ELO-I03', 's2', 'S2 P0 contact has a JOB → getLeadByContact returns null; remove job → lead returned again (job = discriminator)', async () => {
    const C = await mkContact(COMPANY_A, { name: 'I03 C', email: 'i03@elo1.test' });
    const L = await mkLead(COMPANY_A, { contactId: C, status: 'Submitted' });
    const job = await mkJob(COMPANY_A, { contactId: C });

    // With a job on C, the (real) open lead is suppressed — parity with getLeadByPhone.
    eq(await leadsService.getLeadByContact(C, COMPANY_A), null, 'contact with a JOB → null (stale-lead suppression)');

    // Remove the job and re-run → the SAME lead comes back, proving the job is the discriminator.
    await db.query(`DELETE FROM jobs WHERE id = $1`, [job]);
    const lead = await leadsService.getLeadByContact(C, COMPANY_A);
    check(lead != null, 'after removing the job, getLeadByContact returns the lead again');
    eq(lead.ClientId, L, 'the re-returned lead is L (job was the only discriminator)');
});

// ---------------------------------------------------------------------------
CASE('TC-ELO-I04', 's2', 'S2 P0 only lead Lost/Converted → null; newest OPEN wins when several (ORDER BY id DESC)', async () => {
    // (a) a contact whose ONLY lead is Lost → null; then Converted → null.
    const C1 = await mkContact(COMPANY_A, { name: 'I04 C1', email: 'i04a@elo1.test' });
    const lost = await mkLead(COMPANY_A, { contactId: C1, status: 'Lost' });
    eq(await leadsService.getLeadByContact(C1, COMPANY_A), null, 'only lead is Lost → null');
    // flip that lead to Converted and re-check (still closed → null).
    await db.query(`UPDATE leads SET status = 'Converted' WHERE id = $1`, [lost]);
    eq(await leadsService.getLeadByContact(C1, COMPANY_A), null, 'only lead is Converted → null');

    // (b) a contact with THREE open leads L1<L2<L3 (ascending id) + one Lost → newest OPEN L3.
    const C2 = await mkContact(COMPANY_A, { name: 'I04 C2', email: 'i04b@elo1.test' });
    const L1 = await mkLead(COMPANY_A, { contactId: C2, status: 'Submitted' });
    const L2 = await mkLead(COMPANY_A, { contactId: C2, status: 'New' });
    const L3 = await mkLead(COMPANY_A, { contactId: C2, status: 'Review' });
    await mkLead(COMPANY_A, { contactId: C2, status: 'Lost' }); // a closed one that must never win
    check(L1 < L2 && L2 < L3, `ids ascending as seeded (${L1} < ${L2} < ${L3})`);

    const lead = await leadsService.getLeadByContact(C2, COMPANY_A);
    check(lead != null, 'a lead is returned when several open exist');
    eq(lead.ClientId, L3, 'newest OPEN lead L3 wins (ORDER BY l.id DESC LIMIT 1) — never L1/L2/Lost');
});

// ---------------------------------------------------------------------------
CASE('TC-ELO-I10', 's2', 'no-dup: an existing open lead makes getLeadByContact truthy BEFORE any create (open-count for C = 1)', async () => {
    const C = await mkContact(COMPANY_A, { name: 'I10 C', email: 'i10@elo1.test' });
    const L1 = await mkLead(COMPANY_A, { contactId: C, status: 'Submitted' });

    // The lookup reports "already linked" so the UI shows LeadDetailPanel and does NOT offer "create".
    const lead = await leadsService.getLeadByContact(C, COMPANY_A);
    check(lead != null, 'getLeadByContact truthy BEFORE any create (would suppress the wizard → no duplicate)');
    eq(lead.ClientId, L1, 'the already-linked lead is L1');
    // exactly one open lead for C.
    eq(await scalar(`SELECT count(*)::int FROM leads WHERE contact_id = $1 AND status NOT IN ('Lost','Converted')`, [C]), 1,
        'open-lead count for C is exactly 1');
});

// ---------------------------------------------------------------------------
// s7 — TC-ELO-I05/I06 — P0 SECURITY cross-tenant. A red here = a cross-tenant
// lead leak — release blocker.
// ---------------------------------------------------------------------------
CASE('TC-ELO-I05', 's7', 'S7 P0 SECURITY cross-tenant: getLeadByContact(BC, A) → null; B lead never returned for A; B lead intact under B', async () => {
    await ensureCompany(COMPANY_B, 'elo1-b', 'ELO1 Cross Co B');

    // Company B: contact BC with an open lead BL (contact_id=BC, company_id=B).
    const BC = await mkContact(COMPANY_B, { name: 'I05 BC', email: 'i05b@elo1.test' });
    const BL = await mkLead(COMPANY_B, { contactId: BC, status: 'Submitted' });
    // Company A has NO footprint for BC.

    // A company-A caller asking for a company-B contact's id → null (the l.company_id=$2 (=A) predicate excludes BL).
    eq(await leadsService.getLeadByContact(BC, COMPANY_A), null,
        'getLeadByContact(BC, A) → null — B lead excluded by the company predicate (NO cross-tenant leak)');

    // BL still exists under B and is returned to a company-B caller — untouched.
    const bLead = await leadsService.getLeadByContact(BC, COMPANY_B);
    check(bLead != null, 'BL is still reachable under company B (untouched)');
    eq(bLead.ClientId, BL, 'company-B caller gets BL');
    eq(await scalar(`SELECT contact_id FROM leads WHERE id = $1`, [BL]), BC, 'BL still owned by BC');
    eq(await scalar(`SELECT company_id FROM leads WHERE id = $1`, [BL]), COMPANY_B, 'BL still company B');
});

// ---------------------------------------------------------------------------
CASE('TC-ELO-I06', 's7', 'S7 symmetric: a create scoped to A referencing an A-side contact never reads/mutates/links a B row', async () => {
    await ensureCompany(COMPANY_B, 'elo1-b', 'ELO1 Cross Co B');

    // B has contact BC + open lead BL.
    const BC = await mkContact(COMPANY_B, { name: 'I06 BC', email: 'i06b@elo1.test' });
    const BL = await mkLead(COMPANY_B, { contactId: BC, status: 'Submitted' });

    // A create issued with company_id=A referencing an A-side contact C_A only.
    const C_A = await mkContact(COMPANY_A, { name: 'I06 CA', email: 'i06a@elo1.test' });
    const created = await leadsService.createLead(
        { FirstName: 'ELO1', Email: 'i06a@elo1.test', contact_id: C_A },
        COMPANY_A
    );
    const newRow = await leadRow(Number(created.ClientId));
    eq(newRow.company_id, COMPANY_A, 'created lead is company A');
    eq(newRow.contact_id, C_A, 'created lead linked to the A-side contact C_A');

    // No B row read/mutated/linked: BL still owned by BC under B; getLeadByContact(BC,A) still null.
    eq(await scalar(`SELECT contact_id FROM leads WHERE id = $1`, [BL]), BC, 'B lead BL still owned by BC (not re-pointed)');
    eq(await scalar(`SELECT company_id FROM leads WHERE id = $1`, [BL]), COMPANY_B, 'B lead BL still company B');
    eq(await leadsService.getLeadByContact(BC, COMPANY_A), null, 'getLeadByContact(BC, A) still null after the A-side create');
});

// ---------------------------------------------------------------------------
// s8 — TC-ELO-I07/I08 — regression: the phone path stays byte-for-byte.
// ---------------------------------------------------------------------------
CASE('TC-ELO-I07', 's8', 'S8 regression: getLeadByPhone byte-identical before/after a phoneless lead is added for a DIFFERENT contact', async () => {
    // A phone contact P with an open phone-origin lead PL.
    const P = await mkContact(COMPANY_A, { name: 'I07 P', phone: '+16175550001' });
    const PL = await mkLead(COMPANY_A, { contactId: P, status: 'Submitted', phone: '+16175550001', email: 'i07p@elo1.test' });

    // Serialize the phone lookup BEFORE the phoneless lead is added.
    const beforeLead = await leadsService.getLeadByPhone('+16175550001', COMPANY_A);
    check(beforeLead != null, 'getLeadByPhone finds PL before');
    eq(beforeLead.ClientId, PL, 'before lookup resolves to PL'); // ClientId is a string (bigint) — eq() coerces
    const before = JSON.stringify(beforeLead);

    // Add an UNRELATED phoneless email-origin lead for a DIFFERENT contact C.
    const C = await mkContact(COMPANY_A, { name: 'I07 C', email: 'i07c@elo1.test' });
    await mkLead(COMPANY_A, { contactId: C, status: 'Submitted', email: 'i07c@elo1.test' }); // phone NULL

    // Serialize again — must be byte-identical (phoneless lead invisible to the phone-digit predicate).
    const after = JSON.stringify(await leadsService.getLeadByPhone('+16175550001', COMPANY_A));
    eq(after, before, 'getLeadByPhone byte-identical after a phoneless lead was added for a different contact');

    // And getLeadByPhone still applies its OWN job/Lost/Converted filters unchanged:
    // flip PL to Lost → null; add a job on P → null.
    await db.query(`UPDATE leads SET status = 'Lost' WHERE id = $1`, [PL]);
    eq(await leadsService.getLeadByPhone('+16175550001', COMPANY_A), null, 'phone lookup still filters Lost');
    await db.query(`UPDATE leads SET status = 'Submitted' WHERE id = $1`, [PL]);
    await mkJob(COMPANY_A, { contactId: P });
    eq(await leadsService.getLeadByPhone('+16175550001', COMPANY_A), null, 'phone lookup still applies its job post-filter');
});

// ---------------------------------------------------------------------------
CASE('TC-ELO-I08', 's8', 'S8 regression: phone-origin createLead unchanged — normalizes E.164, email + contact_id set', async () => {
    const C = await mkContact(COMPANY_A, { name: 'I08 C', email: 'p@elo1.test' });
    const created = await leadsService.createLead(
        { FirstName: 'ELO1', Phone: '617 555 0002', Email: 'p@elo1.test', contact_id: C },
        COMPANY_A
    );
    const row = await leadRow(Number(created.ClientId));
    eq(row.phone, '+16175550002', 'phone normalized to E.164 (the phone leg is untouched by the relaxation)');
    eq(row.email, 'p@elo1.test', 'email set');
    eq(row.contact_id, C, 'contact_id set');
});

// ---------------------------------------------------------------------------
// s6 — TC-ELO-I09 — email-origin lead lists on the Leads page (phone-independent)
// and on the contact (round-trip S6 → S2).
// ---------------------------------------------------------------------------
CASE('TC-ELO-I09', 's6', 'S6 email-origin lead lists on the Leads page (phone-independent) AND resolves on the contact', async () => {
    // Create a phoneless email-origin lead (as in I01).
    const C = await mkContact(COMPANY_A, { name: 'I09 C', email: 'i09@elo1.test' });
    const created = await leadsService.createLead(
        { FirstName: 'ELO1', Email: 'i09@elo1.test', contact_id: C },
        COMPANY_A
    );
    const id = Number(created.ClientId);
    eq((await leadRow(id)).phone, null, 'the lead is phoneless (phone NULL)');

    // (1) It appears in the Leads-page query (which does NOT filter by phone).
    const { results } = await leadsService.listLeads({ companyId: COMPANY_A, records: 100, only_open: true });
    const mine = results.filter(r => Number(r.ClientId) === id);
    eq(mine.length, 1, 'the phoneless lead appears on the Leads page (listLeads lists it despite phone NULL)');

    // (2) It is associated to C (getLeadByContact → the lead, since C has no job) — round-trip.
    const byContact = await leadsService.getLeadByContact(C, COMPANY_A);
    check(byContact != null, 'getLeadByContact resolves the lead on the contact');
    eq(byContact.ClientId, id, 'the same lead resolves on the contact (S6 → S2 round-trip)');
});

// ---------------------------------------------------------------------------
// explain — TC-ELO-I11 — getLeadByContact uses idx_leads_contact_id (no Seq Scan
// at scale). Local dev may have too few leads to force the index, so assert with
// SET LOCAL enable_seqscan=off inside a BEGIN…ROLLBACK, mirroring
// verify-tasks-count-001.js TC-40. The EXPLAINed SQL is a byte-for-byte copy of
// getLeadByContact's first query (leadsService.js:1170) with the company predicate
// present (the route always passes a company id).
// ---------------------------------------------------------------------------
CASE('TC-ELO-I11', 'explain', 'EXPLAIN getLeadByContact uses idx_leads_contact_id (no Seq Scan at scale) — Decision F, no new index', async () => {
    // Seed a tagged contact + open lead so the plan has a concrete $1 to bind.
    const C = await mkContact(COMPANY_A, { name: 'I11 C', email: 'i11@elo1.test' });
    await mkLead(COMPANY_A, { contactId: C, status: 'Submitted' });

    // EXACT copy of getLeadByContact's first-query SQL (contact_id + status filter +
    // company predicate + team agg + ORDER BY l.id DESC LIMIT 1). If the service SQL
    // changes shape, update this mirror.
    const sql = `
        SELECT l.*,
            COALESCE(
                json_agg(json_build_object('id', lta.id, 'name', lta.user_name))
                FILTER (WHERE lta.id IS NOT NULL), '[]'
            ) AS team
        FROM leads l
        LEFT JOIN lead_team_assignments lta ON lta.lead_id = l.id
        WHERE l.contact_id = $1 AND l.status NOT IN ('Lost', 'Converted') AND l.company_id = $2
        GROUP BY l.id
        ORDER BY l.id DESC
        LIMIT 1
    `;
    const params = [C, COMPANY_A];

    // Default plan (documented; a Seq Scan here is acceptable on a small dev table).
    const defaultPlan = (await db.query(`EXPLAIN (FORMAT TEXT) ${sql}`, params)).rows.map(r => r['QUERY PLAN']).join('\n');

    // With seqscan disabled the planner must serve the leads access via
    // idx_leads_contact_id (proving the mig-023 partial index covers this lookup —
    // Decision F "no new migration/index"). A regression to Seq Scan / a different
    // index appearing = FAIL.
    const client = await db.pool.connect();
    let scaledPlan;
    try {
        await client.query('BEGIN');
        await client.query('SET LOCAL enable_seqscan = off'); // scoped to this txn; reverted by ROLLBACK
        scaledPlan = (await client.query(`EXPLAIN (FORMAT TEXT) ${sql}`, params)).rows.map(r => r['QUERY PLAN']).join('\n');
        await client.query('ROLLBACK');
    } finally {
        client.release();
    }

    const usesContactIdx = /Index (Only )?Scan[^\n]*idx_leads_contact_id|Bitmap Index Scan on idx_leads_contact_id/.test(scaledPlan);
    check(usesContactIdx,
        `getLeadByContact must be served by idx_leads_contact_id at scale (Decision F: no new index).\nDefault plan:\n${defaultPlan}\n\nseqscan-off plan:\n${scaledPlan}`);
    // No NEW leads index snuck in — the access is the mig-023 partial index, not a fresh one.
    check(!/Seq Scan on leads\b/.test(scaledPlan),
        `no Seq Scan on leads at scale.\nPlan:\n${scaledPlan}`);

    record('TC-ELO-I11', 'PASS', `served by idx_leads_contact_id (${scaledPlan.split('\n').find(l => /idx_leads_contact_id/.test(l))?.trim()})`);
});

// ---------------------------------------------------------------------------
// sab — TC-ELO-ISAB — sabotage negative control. Run the SAME assert kit against
// KNOWN-WRONG expectations; assert they throw a CheckError; then restore green.
// If the sabotage does NOT trip a FAIL, the detector is broken and every PASS
// above is suspect.
// ---------------------------------------------------------------------------
CASE('TC-ELO-ISAB', 'sab', 'sabotage negative control: deliberately-wrong expectations MUST trip a FAIL, then restore green', async () => {
    // Seed + run the S4 phoneless create so we have a real phone-NULL row + a real
    // cross-tenant null to assert against.
    const C = await mkContact(COMPANY_A, { name: 'SAB Target', email: 'sab@elo1.test' });
    const created = await leadsService.createLead(
        { FirstName: 'ELO1', Email: 'sab@elo1.test', contact_id: C },
        COMPANY_A
    );
    const row = await leadRow(Number(created.ClientId));

    await ensureCompany(COMPANY_B, 'elo1-b', 'ELO1 Cross Co B');
    const BC = await mkContact(COMPANY_B, { name: 'SAB BC', email: 'sabb@elo1.test' });
    await mkLead(COMPANY_B, { contactId: BC, status: 'Submitted' });

    // (1) deliberately-wrong: assert the stored phone EQUALS a fabricated '+1…' (it is NULL) → must throw.
    let threw1 = false;
    try {
        eq(row.phone, '+15551234567', 'SABOTAGE: stored phone should be NULL but we assert a fabricated +1…');
    } catch (e) {
        threw1 = e instanceof CheckError;
    }
    check(threw1, 'SABOTAGE FAILED TO TRIP (phoneless): the detector did not throw when phone NULL was asserted == a fabricated +1…');

    // (2) deliberately-wrong: assert the cross-tenant lookup returns B's lead (it must be null) → must throw.
    let threw2 = false;
    try {
        const crossed = await leadsService.getLeadByContact(BC, COMPANY_A); // truly null
        check(crossed != null, 'SABOTAGE: getLeadByContact(BC, A) should be null but we assert it returned B\'s lead');
    } catch (e) {
        threw2 = e instanceof CheckError;
    }
    check(threw2, 'SABOTAGE FAILED TO TRIP (cross-tenant): the detector did not throw when a null cross-tenant result was asserted non-null');

    // (3) restore the TRUE expectations → green.
    check(row.phone === null, 'restored: stored phone is truly NULL');
    eq(await leadsService.getLeadByContact(BC, COMPANY_A), null, 'restored: cross-tenant lookup is truly null');
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

    console.log(`EMAIL-LEAD-ORIGIN-001 verify — DATABASE_URL=${process.env.DATABASE_URL}`);
    console.log(`Company A=${COMPANY_A} (seed, delta/tagged asserts) · Company B=${COMPANY_B} (tagged, temp)`);
    console.log(`Cases: ${sel} → ${selected.length}\n`);

    await cleanupAll();

    for (const c of selected) {
        await cleanupAll();
        try {
            await c.fn();
            // A case that already recorded its own PASS (explain) is not double-recorded.
            if (!results.find(r => r.id === c.id)) record(c.id, 'PASS', c.title);
        } catch (e) {
            const note = `${c.title} — ${e instanceof CheckError ? e.message : (e.stack || e.message)}`;
            if (!results.find(r => r.id === c.id)) record(c.id, 'FAIL', note);
            else { // overwrite a self-recorded PASS if the body later threw
                const r = results.find(r => r.id === c.id);
                r.status = 'FAIL'; r.note = note;
            }
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
