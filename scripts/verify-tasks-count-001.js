#!/usr/bin/env node
/**
 * TASKS-COUNT-BADGE-001 — T4 integration verify script.
 *
 * Proves THE load-bearing invariant (AC-1..AC-3 / S9) on a REAL local Postgres,
 * no mocks anywhere (mocked jest only checks the SQL string — LIST-PAGINATION-001
 * lesson): for every seed state and BOTH a manager scope (no scopeOwnerId) and a
 * non-manager scope (scopeOwnerId = a seeded crm_user id),
 *
 *     tasksQueries.countTasks(companyId, filters)  ===
 *     tasksQueries.listTasks(companyId, { ...filters, limit }).length
 *
 * exercised after every mutation of a create → complete → reopen → reassign delta
 * chain. Also covers cross-tenant isolation (P0 release-blocker), the
 * HAS_ENTITY_PARENT exclusion (system-provenance timeline task counted by neither;
 * agent-provenance timeline task counted by both — MAIL-AGENT-001), the per-parent
 * matrix, boundary counts, and an EXPLAIN cheapness probe.
 *
 * The real functions exercised (query layer directly — route scope semantics are
 * mirrored by passing the same `filters` the `GET /` handler builds: manager →
 * no scopeOwnerId; non-manager → scopeOwnerId = actorId = crm_users.id):
 *   • tasksQueries.countTasks / listTasks / buildTaskListFilters   (T1)
 *   • tasksQueries.createTask / updateTask / deleteTask            (deltas)
 *   • timelinesQueries.createTask                                  (T2 provenance)
 *
 * Fixtures are self-seeded with the unique tag TCB1 and cleaned BEFORE each case
 * and at process start/end, so re-runs are clean (FK order: tasks → timelines →
 * contacts → crm_users → companies):
 *   companies   id IN {A2-tagged, B-tagged}      crm_users  keycloak_sub LIKE 'tcb1-%'
 *   contacts    full_name LIKE 'TCB1 %'          timelines  by company / tagged contact
 *   tasks       title LIKE 'TCB1 %'
 * Company A = the seed company 00000000-0000-0000-0000-000000000001 (real dev rows
 * coexist → A assertions are owner-scoped to freshly-seeded tagged users, or
 * deltas around a pre-measured baseline, NEVER absolute whole-company counts).
 * Company B (cross-tenant) is CREATED tagged and deleted by cleanup.
 *
 * Usage:
 *   node scripts/verify-tasks-count-001.js [--section=<id>|all]
 *   DATABASE_URL defaults to postgresql://localhost/twilio_calls (house default).
 * Never point this at prod. Exit code 0 only when no case FAILs.
 */
'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/twilio_calls';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const db = require(path.join(ROOT, 'backend/src/db/connection'));
const tasksQueries = require(path.join(ROOT, 'backend/src/db/tasksQueries'));
const timelinesQueries = require(path.join(ROOT, 'backend/src/db/timelinesQueries'));

const COMPANY_A = '00000000-0000-0000-0000-000000000001'; // seed company (real dev data coexists)
const COMPANY_B = 'c0000000-0000-4000-8000-0000000000b1'; // tagged, created+deleted here
const LIST_LIMIT = 500; // never let the list cap below the true count when comparing to count()

// ─── tiny assert/report kit (mirrors verify-email-outbound-001.js) ──────────

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
    const pad = ' '.repeat(Math.max(1, 10 - id.length));
    console.log(`${status} ${id}${pad}${note || ''}`);
}

// ─── seeding helpers (all tagged TCB1) ──────────────────────────────────────

let userSeq = 0;
async function mkUser(companyId) {
    userSeq += 1;
    const r = await db.query(
        `INSERT INTO crm_users (keycloak_sub, email, full_name, company_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [`tcb1-sub-${userSeq}-${Date.now()}`, `tcb1-user-${userSeq}@tcb1.test`, `TCB1 User ${userSeq}`, companyId]
    );
    return r.rows[0].id;
}

async function ensureCompany(id, slug, name) {
    await db.query(
        `INSERT INTO companies (id, name, slug, status) VALUES ($1, $2, $3, 'active')
         ON CONFLICT (id) DO NOTHING`,
        [id, name, slug]
    );
}

async function mkContact(companyId, name = 'Parent') {
    const r = await db.query(
        `INSERT INTO contacts (full_name, company_id) VALUES ($1, $2) RETURNING id`,
        [`TCB1 ${name}`, companyId]
    );
    return r.rows[0].id;
}

let phoneSeq = 100;
function nextPhone() {
    phoneSeq += 1;
    return `+1999444${String(phoneSeq).padStart(4, '0')}`;
}

// A timeline needs contact_id OR phone_e164 (chk_timelines_identity).
async function mkTimeline(companyId, { contactId = null } = {}) {
    const r = await db.query(
        `INSERT INTO timelines (contact_id, phone_e164, company_id) VALUES ($1, $2, $3) RETURNING id`,
        [contactId, contactId ? null : nextPhone(), companyId]
    );
    return r.rows[0].id;
}

async function mkJob(companyId) {
    return (await db.query(`INSERT INTO jobs (company_id) VALUES ($1) RETURNING id`, [companyId])).rows[0].id;
}
let leadSeq = 0;
async function mkLead(companyId) {
    // leads.uuid is varchar(20); keep the tagged value short but unique.
    leadSeq += 1;
    const uuid = `tcb1${String(leadSeq).padStart(3, '0')}${Date.now().toString(36)}`.slice(0, 20);
    return (await db.query(
        `INSERT INTO leads (uuid, company_id, first_name) VALUES ($1, $2, 'TCB1') RETURNING id`,
        [uuid, companyId]
    )).rows[0].id;
}
let docSeq = 0;
async function mkEstimate(companyId) {
    docSeq += 1;
    return (await db.query(
        `INSERT INTO estimates (company_id, estimate_number) VALUES ($1, $2) RETURNING id`,
        [companyId, `TCB1-EST-${docSeq}-${Date.now()}`]
    )).rows[0].id;
}
async function mkInvoice(companyId) {
    docSeq += 1;
    return (await db.query(
        `INSERT INTO invoices (company_id, invoice_number) VALUES ($1, $2) RETURNING id`,
        [companyId, `TCB1-INV-${docSeq}-${Date.now()}`]
    )).rows[0].id;
}

/**
 * Seed one tagged task directly (so we control created_by / owner / status /
 * parent precisely, including HAS_ENTITY_PARENT-excluded shapes the app writers
 * would never emit). Title is tagged 'TCB1 …' for cleanup. Returns the id.
 */
async function seedTask(companyId, {
    owner = null, status = 'open', createdBy = 'user', title = 'task',
    jobId = null, leadId = null, estimateId = null, invoiceId = null, contactId = null, threadId = null,
    dueAt = null,
}) {
    const r = await db.query(
        `INSERT INTO tasks (company_id, title, description, status, created_by, owner_user_id, due_at,
                            job_id, lead_id, estimate_id, invoice_id, contact_id, thread_id)
         VALUES ($1, $2, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [companyId, `TCB1 ${title}`, status, createdBy, owner, dueAt,
            jobId, leadId, estimateId, invoiceId, contactId, threadId]
    );
    return r.rows[0].id;
}

/** Seed an entity-parented (contact) open task owned by `owner`. Cheapest HEP parent. */
async function seedContactTask(companyId, owner, title = 'contact task', status = 'open') {
    const contactId = await mkContact(companyId, 'ct');
    return seedTask(companyId, { owner, status, createdBy: 'user', title, contactId });
}

// ─── cleanup (FK order; run before every case + at start/end) ───────────────

async function cleanupAll() {
    // tasks first (FK → companies/parents CASCADE, but we target by tag so we can
    // also clean company A where the company row must survive).
    await db.query(`DELETE FROM tasks WHERE title LIKE 'TCB1 %'`);
    await db.query(`DELETE FROM tasks WHERE company_id = $1`, [COMPANY_B]);
    // timelines: tagged company B, plus any hung on a tagged contact or tagged phone.
    await db.query(`DELETE FROM timelines WHERE company_id = $1`, [COMPANY_B]);
    await db.query(`DELETE FROM timelines WHERE contact_id IN (SELECT id FROM contacts WHERE full_name LIKE 'TCB1 %')`);
    await db.query(`DELETE FROM timelines WHERE contact_id IS NULL AND phone_e164 LIKE '+1999444%'`);
    // entity parents in company A (tagged) — tasks already gone, so no CASCADE surprises.
    await db.query(`DELETE FROM jobs WHERE company_id = $1 AND id NOT IN (SELECT job_id FROM tasks WHERE job_id IS NOT NULL)`, [COMPANY_B]);
    await db.query(`DELETE FROM estimates WHERE estimate_number LIKE 'TCB1-EST-%'`);
    await db.query(`DELETE FROM invoices WHERE invoice_number LIKE 'TCB1-INV-%'`);
    await db.query(`DELETE FROM leads WHERE uuid LIKE 'tcb1%'`);
    await db.query(`DELETE FROM contacts WHERE full_name LIKE 'TCB1 %'`);
    // crm_users tagged (owner FKs are ON DELETE SET NULL, but tasks are already gone).
    await db.query(`DELETE FROM crm_users WHERE keycloak_sub LIKE 'tcb1-%'`);
    // company B last (CASCADE mops any straggler child rows).
    await db.query(`DELETE FROM companies WHERE id = $1`, [COMPANY_B]);
}

// ─── invariant helper ───────────────────────────────────────────────────────

/**
 * THE invariant, asserted for a given filter object: countTasks === listTasks.length.
 * `label` names the state; `expectExact` (optional) additionally pins the value.
 */
async function assertInvariant(companyId, filters, label, expectExact = null) {
    const count = await tasksQueries.countTasks(companyId, filters);
    const list = await tasksQueries.listTasks(companyId, { ...filters, limit: LIST_LIMIT });
    check(count === list.length,
        `${label}: countTasks (${count}) !== listTasks().length (${list.length}) for filters ${JSON.stringify(filters)}`);
    if (expectExact !== null) {
        eq(count, expectExact, `${label}: count value`);
    }
    return count;
}

// ═════════════════════════════════════════════════════════════════════════════
// Cases
// ═════════════════════════════════════════════════════════════════════════════

const CASES = [];
function CASE(id, title, fn) {
    CASES.push({ id, title, fn });
}

// ---------------------------------------------------------------------------
CASE('TC-1', 'S9 INVARIANT (load-bearing): count==list across ≥4 states, manager + scoped', async () => {
    const ME = await mkUser(COMPANY_A);
    const OTHER = await mkUser(COMPANY_A);

    // (a) EMPTY (for ME's scope — no tasks owned by this brand-new user id).
    await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: ME }, 'state-a empty scoped', 0);
    // Manager invariant holds too (dev rows counted equally by both sides).
    await assertInvariant(COMPANY_A, { status: 'open' }, 'state-a manager');

    // (b) MANAGER all-open: seed a spread of open tasks owned by several users.
    const seeded = [];
    seeded.push(await seedContactTask(COMPANY_A, ME, 'a-me-1'));
    seeded.push(await seedContactTask(COMPANY_A, ME, 'a-me-2'));
    seeded.push(await seedContactTask(COMPANY_A, OTHER, 'a-other-1'));
    await assertInvariant(COMPANY_A, { status: 'open' }, 'state-b manager all-open');
    await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: ME }, 'state-b scoped ME', 2);
    await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: OTHER }, 'state-b scoped OTHER', 1);

    // (c) PROVIDER own-open only (already covered by ME scope == 2 above; re-assert
    //     after adding a done task for ME so open scoped excludes it).
    await seedContactTask(COMPANY_A, ME, 'a-me-done', 'done');
    await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: ME }, 'state-c provider own-open', 2);

    // (d) MIXED open+done+cross-parent: one open task of every parent type for ME,
    //     plus a done and a system-timeline (excluded) task, then re-assert.
    const jobId = await mkJob(COMPANY_A);
    const leadId = await mkLead(COMPANY_A);
    const estId = await mkEstimate(COMPANY_A);
    const invId = await mkInvoice(COMPANY_A);
    await seedTask(COMPANY_A, { owner: ME, title: 'd-job', jobId });
    await seedTask(COMPANY_A, { owner: ME, title: 'd-lead', leadId });
    await seedTask(COMPANY_A, { owner: ME, title: 'd-est', estimateId: estId });
    await seedTask(COMPANY_A, { owner: ME, title: 'd-inv', invoiceId: invId });
    // system timeline task (excluded by HAS_ENTITY_PARENT) — must not shift either side.
    const sysThread = await mkTimeline(COMPANY_A);
    await seedTask(COMPANY_A, { owner: ME, title: 'd-sys-excluded', createdBy: 'system', threadId: sysThread });
    await assertInvariant(COMPANY_A, { status: 'open' }, 'state-d manager mixed');
    // ME now owns: 2 (contact) + 4 (one per entity parent) = 6 open counted; system excluded.
    await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: ME }, 'state-d scoped ME', 6);
    // 'all' status invariant (no status filter) also holds for both scopes.
    await assertInvariant(COMPANY_A, {}, 'state-d manager no-status');
    await assertInvariant(COMPANY_A, { scopeOwnerId: ME }, 'state-d scoped ME no-status');
});

// ---------------------------------------------------------------------------
CASE('TC-9', 'S2: provider counts only own (3 ME + 2 OTHER → scoped ME = 3)', async () => {
    const ME = await mkUser(COMPANY_A);
    const OTHER = await mkUser(COMPANY_A);
    for (let i = 0; i < 3; i++) await seedContactTask(COMPANY_A, ME, `s2-me-${i}`);
    for (let i = 0; i < 2; i++) await seedContactTask(COMPANY_A, OTHER, `s2-other-${i}`);

    await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: ME }, 'provider scoped ME', 3);
    await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: OTHER }, 'provider scoped OTHER', 2);
});

// ---------------------------------------------------------------------------
CASE('TC-10', 'S10/AC-6 SECURITY (P0): cross-tenant isolation — B never leaks into A', async () => {
    await ensureCompany(COMPANY_B, 'tcb1-b', 'TCB1 Cross Co B');
    // A company-A user id, reused as an OWNER VALUE on company-B tasks, must still
    // never surface in A's count (the company_id gate, not owner, is what isolates).
    const AUSER = await mkUser(COMPANY_A);
    const BUSER = await mkUser(COMPANY_B);

    // Company B: N open entity-parented tasks (some owned by AUSER's id, cross-company).
    const bContact1 = await mkContact(COMPANY_B, 'b1');
    const bContact2 = await mkContact(COMPANY_B, 'b2');
    const bJob = await mkJob(COMPANY_B);
    await seedTask(COMPANY_B, { owner: BUSER, title: 'b-1', contactId: bContact1 });
    await seedTask(COMPANY_B, { owner: AUSER, title: 'b-2-ownedByAuserValue', contactId: bContact2 });
    await seedTask(COMPANY_B, { owner: AUSER, title: 'b-3-ownedByAuserValue', jobId: bJob });

    // B's own count is non-zero and consistent.
    const bCount = await assertInvariant(COMPANY_B, { status: 'open' }, 'B manager own');
    check(bCount === 3, `B has exactly its 3 seeded open tasks, got ${bCount}`);

    // A manager count: seed exactly one tagged open task in A owned by AUSER, then
    // assert A's AUSER-scoped count is EXACTLY 1 — B's two AUSER-valued rows excluded.
    await seedContactTask(COMPANY_A, AUSER, 'a-only-1');
    await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: AUSER }, 'A scoped AUSER excludes B rows', 1);

    // Manager-scope A count must ALSO exclude B: measure A's manager total, confirm
    // it equals its own list (invariant) and that adding B's rows never moved it.
    const aManager = await tasksQueries.countTasks(COMPANY_A, { status: 'open' });
    const aList = await tasksQueries.listTasks(COMPANY_A, { status: 'open', limit: LIST_LIMIT });
    check(aManager === aList.length, `A manager count==list (${aManager} vs ${aList.length})`);
    check(aList.every(r => r.company_id === COMPANY_A), 'every A list row is company A (no B row present)');

    // Symmetric: B count never includes A's tagged row.
    const bList = await tasksQueries.listTasks(COMPANY_B, { status: 'open', limit: LIST_LIMIT });
    check(bList.every(r => r.company_id === COMPANY_B), 'every B list row is company B (no A row present)');
    eq(await tasksQueries.countTasks(COMPANY_B, { status: 'open' }), 3, 'B count still exactly 3 (A row not leaked in)');
});

// ---------------------------------------------------------------------------
CASE('TC-11', 'S8: system-provenance timeline-only task counted by NEITHER; agent counted by BOTH', async () => {
    const ME = await mkUser(COMPANY_A);
    // system timeline task: created_by='system', thread_id set, NO entity parent.
    const sysThread = await mkTimeline(COMPANY_A);
    const sysTask = await seedTask(COMPANY_A, { owner: ME, title: 's8-system', createdBy: 'system', threadId: sysThread });
    // agent timeline task (distinct thread; one-open-per-thread) — INCLUDED (MAIL-AGENT-001).
    const agentThread = await mkTimeline(COMPANY_A);
    const agentTask = await seedTask(COMPANY_A, { owner: ME, title: 's8-agent', createdBy: 'agent', threadId: agentThread });

    const list = await tasksQueries.listTasks(COMPANY_A, { status: 'open', scopeOwnerId: ME, limit: LIST_LIMIT });
    const ids = list.map(r => Number(r.id));
    check(!ids.includes(Number(sysTask)), 'system timeline task absent from listTasks');
    check(ids.includes(Number(agentTask)), 'agent timeline task PRESENT in listTasks (MAIL-AGENT-001)');
    // count==list for ME, and equals exactly 1 (only the agent task is visible).
    await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: ME }, 's8 scoped ME', 1);
});

// ---------------------------------------------------------------------------
CASE('TC-13', 'S1: manager counts all — every parent type + multiple owners; count==list', async () => {
    const U1 = await mkUser(COMPANY_A);
    const U2 = await mkUser(COMPANY_A);
    const jobId = await mkJob(COMPANY_A);
    const leadId = await mkLead(COMPANY_A);
    const estId = await mkEstimate(COMPANY_A);
    const invId = await mkInvoice(COMPANY_A);
    const contactId = await mkContact(COMPANY_A, 's1-c');
    await seedTask(COMPANY_A, { owner: U1, title: 's1-job', jobId });
    await seedTask(COMPANY_A, { owner: U2, title: 's1-lead', leadId });
    await seedTask(COMPANY_A, { owner: U1, title: 's1-est', estimateId: estId });
    await seedTask(COMPANY_A, { owner: U2, title: 's1-inv', invoiceId: invId });
    await seedTask(COMPANY_A, { owner: U1, title: 's1-contact', contactId });

    // Manager total == list length (the load-bearing equality), regardless of dev rows.
    await assertInvariant(COMPANY_A, { status: 'open' }, 's1 manager all');
    // The 5 seeded rows are split 3/2 across the two owners; the union is manager-visible.
    await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: U1 }, 's1 scoped U1', 3);
    await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: U2 }, 's1 scoped U2', 2);
});

// ---------------------------------------------------------------------------
CASE('TC-14', 'S3: create → +1 (scoped + manager delta)', async () => {
    const U = await mkUser(COMPANY_A);
    const before = await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: U }, 's3 before', 0);
    const mgrBefore = await tasksQueries.countTasks(COMPANY_A, { status: 'open' });

    const contactId = await mkContact(COMPANY_A, 's3');
    await tasksQueries.createTask(COMPANY_A, { parentType: 'contact', parentId: contactId, description: 'TCB1 s3-created', owner_user_id: U });

    await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: U }, 's3 after', before + 1);
    eq(await tasksQueries.countTasks(COMPANY_A, { status: 'open' }), mgrBefore + 1, 's3 manager +1');
});

// ---------------------------------------------------------------------------
CASE('TC-15', 'S4: complete → −1', async () => {
    const U = await mkUser(COMPANY_A);
    const contactId = await mkContact(COMPANY_A, 's4');
    const t = await seedTask(COMPANY_A, { owner: U, title: 's4', contactId });
    const before = await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: U }, 's4 before', 1);

    await tasksQueries.updateTask(COMPANY_A, t, { status: 'done' });
    await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: U }, 's4 after', before - 1);
    // done task IS visible under status:'done'; count==list holds there too.
    await assertInvariant(COMPANY_A, { status: 'done', scopeOwnerId: U }, 's4 done side', 1);
});

// ---------------------------------------------------------------------------
CASE('TC-16', 'S5: reopen → +1 (completed_at cleared)', async () => {
    const U = await mkUser(COMPANY_A);
    const contactId = await mkContact(COMPANY_A, 's5');
    const t = await seedTask(COMPANY_A, { owner: U, title: 's5', status: 'done', contactId });
    // Give it a completed_at so we can prove reopen clears it.
    await db.query(`UPDATE tasks SET completed_at = now() WHERE id = $1`, [t]);
    const before = await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: U }, 's5 before', 0);

    await tasksQueries.updateTask(COMPANY_A, t, { status: 'open' });
    await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: U }, 's5 after', before + 1);
    const row = (await db.query(`SELECT completed_at FROM tasks WHERE id = $1`, [t])).rows[0];
    check(row.completed_at === null, 's5 completed_at cleared on reopen');
});

// ---------------------------------------------------------------------------
CASE('TC-17', 'S6: reassign A→B moves per-user counts; manager total unchanged', async () => {
    const A = await mkUser(COMPANY_A);
    const B = await mkUser(COMPANY_A);
    const contactId = await mkContact(COMPANY_A, 's6');
    const t = await seedTask(COMPANY_A, { owner: A, title: 's6', contactId });

    const aBefore = await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: A }, 's6 A before', 1);
    const bBefore = await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: B }, 's6 B before', 0);
    const mgrBefore = await tasksQueries.countTasks(COMPANY_A, { status: 'open' });

    await tasksQueries.updateTask(COMPANY_A, t, { owner_user_id: B });

    await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: A }, 's6 A after', aBefore - 1);
    await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: B }, 's6 B after', bBefore + 1);
    eq(await tasksQueries.countTasks(COMPANY_A, { status: 'open' }), mgrBefore, 's6 manager total UNCHANGED');
});

// ---------------------------------------------------------------------------
CASE('TC-18', 'S7: due-only edit → count unchanged (every audience)', async () => {
    const U = await mkUser(COMPANY_A);
    const contactId = await mkContact(COMPANY_A, 's7');
    const t = await seedTask(COMPANY_A, { owner: U, title: 's7', contactId });
    const scopedBefore = await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: U }, 's7 before', 1);
    const mgrBefore = await tasksQueries.countTasks(COMPANY_A, { status: 'open' });

    await tasksQueries.updateTask(COMPANY_A, t, { due_at: new Date(Date.UTC(2027, 0, 1)).toISOString() });

    await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: U }, 's7 after scoped', scopedBefore);
    eq(await tasksQueries.countTasks(COMPANY_A, { status: 'open' }), mgrBefore, 's7 manager unchanged');
});

// ---------------------------------------------------------------------------
CASE('TC-32', 'S9 delta chain end-to-end: create→complete→reopen→reassign, invariant after EACH', async () => {
    const A = await mkUser(COMPANY_A);
    const B = await mkUser(COMPANY_A);
    const scoped = (u) => ({ status: 'open', scopeOwnerId: u });

    const a0 = await assertInvariant(COMPANY_A, scoped(A), 'chain A t0', 0);
    const b0 = await assertInvariant(COMPANY_A, scoped(B), 'chain B t0', 0);
    const mgr0 = await tasksQueries.countTasks(COMPANY_A, { status: 'open' });

    // create (owner A)
    const contactId = await mkContact(COMPANY_A, 'chain');
    const created = await tasksQueries.createTask(COMPANY_A, { parentType: 'contact', parentId: contactId, description: 'TCB1 chain', owner_user_id: A });
    await assertInvariant(COMPANY_A, scoped(A), 'chain after create A', a0 + 1);
    eq(await tasksQueries.countTasks(COMPANY_A, { status: 'open' }), mgr0 + 1, 'chain manager after create');

    // complete
    await tasksQueries.updateTask(COMPANY_A, created.id, { status: 'done' });
    await assertInvariant(COMPANY_A, scoped(A), 'chain after complete A', a0);
    eq(await tasksQueries.countTasks(COMPANY_A, { status: 'open' }), mgr0, 'chain manager after complete');

    // reopen
    await tasksQueries.updateTask(COMPANY_A, created.id, { status: 'open' });
    await assertInvariant(COMPANY_A, scoped(A), 'chain after reopen A', a0 + 1);
    eq(await tasksQueries.countTasks(COMPANY_A, { status: 'open' }), mgr0 + 1, 'chain manager after reopen');

    // reassign A→B
    await tasksQueries.updateTask(COMPANY_A, created.id, { owner_user_id: B });
    await assertInvariant(COMPANY_A, scoped(A), 'chain after reassign A', a0);
    await assertInvariant(COMPANY_A, scoped(B), 'chain after reassign B', b0 + 1);
    eq(await tasksQueries.countTasks(COMPANY_A, { status: 'open' }), mgr0 + 1, 'chain manager after reassign UNCHANGED from reopen');
});

// ---------------------------------------------------------------------------
CASE('TC-33', 'boundary 9 vs 10: API returns the true int (9+ is render-only)', async () => {
    const U = await mkUser(COMPANY_A);
    for (let i = 0; i < 9; i++) await seedContactTask(COMPANY_A, U, `b9-${i}`);
    await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: U }, 'boundary 9', 9);
    await seedContactTask(COMPANY_A, U, 'b10');
    await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: U }, 'boundary 10', 10);
});

// ---------------------------------------------------------------------------
CASE('TC-34', 'zero: only done / only OTHER → count 0 == list 0', async () => {
    const U = await mkUser(COMPANY_A);
    const OTHER = await mkUser(COMPANY_A);
    await seedContactTask(COMPANY_A, U, 'z-done', 'done');       // done for U
    await seedContactTask(COMPANY_A, OTHER, 'z-other');          // open, but OTHER's
    await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: U }, 'zero scoped U', 0);
});

// ---------------------------------------------------------------------------
CASE('TC-35', 'all parent types counted; user+agent timeline counted; system excluded', async () => {
    const U = await mkUser(COMPANY_A);
    const jobId = await mkJob(COMPANY_A);
    const leadId = await mkLead(COMPANY_A);
    const estId = await mkEstimate(COMPANY_A);
    const invId = await mkInvoice(COMPANY_A);
    const contactId = await mkContact(COMPANY_A, 'p-c');
    await seedTask(COMPANY_A, { owner: U, title: 'p-job', jobId });
    await seedTask(COMPANY_A, { owner: U, title: 'p-lead', leadId });
    await seedTask(COMPANY_A, { owner: U, title: 'p-est', estimateId: estId });
    await seedTask(COMPANY_A, { owner: U, title: 'p-inv', invoiceId: invId });
    await seedTask(COMPANY_A, { owner: U, title: 'p-contact', contactId });
    // user timeline task (INCLUDED) + agent timeline task (INCLUDED) + system (EXCLUDED)
    await seedTask(COMPANY_A, { owner: U, title: 'p-userTl', createdBy: 'user', threadId: await mkTimeline(COMPANY_A) });
    await seedTask(COMPANY_A, { owner: U, title: 'p-agentTl', createdBy: 'agent', threadId: await mkTimeline(COMPANY_A) });
    await seedTask(COMPANY_A, { owner: U, title: 'p-sysTl-excluded', createdBy: 'system', threadId: await mkTimeline(COMPANY_A) });

    // 5 entity parents + user-timeline + agent-timeline = 7 counted; system excluded.
    await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: U }, 'all parents scoped U', 7);
});

// ---------------------------------------------------------------------------
CASE('TC-39', 'S6 corner: reassign U→manager-owned; manager company count already-counted (Δ0), U −1', async () => {
    // "Manager who already counts it company-wide" — the manager total counts every
    // open company task regardless of owner, so moving ownership to any user leaves
    // the manager total unchanged; only the source owner's scoped count drops.
    const U = await mkUser(COMPANY_A);
    const M = await mkUser(COMPANY_A); // stand-in "manager owner" target
    const contactId = await mkContact(COMPANY_A, 's6corner');
    const t = await seedTask(COMPANY_A, { owner: U, title: 's6corner', contactId });

    const mgrBefore = await tasksQueries.countTasks(COMPANY_A, { status: 'open' });
    const uBefore = await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: U }, 's6corner U before', 1);

    await tasksQueries.updateTask(COMPANY_A, t, { owner_user_id: M });

    eq(await tasksQueries.countTasks(COMPANY_A, { status: 'open' }), mgrBefore, 's6corner manager total unchanged (already counted)');
    await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: U }, 's6corner U after', uBefore - 1);
    await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: M }, 's6corner M after', 1);
});

// ---------------------------------------------------------------------------
CASE('TC-40', 'cheapness: countTasks plan is a single join-free tasks scan; supporting index usable at scale', async () => {
    const U = await mkUser(COMPANY_A);
    for (let i = 0; i < 5; i++) await seedContactTask(COMPANY_A, U, `plan-${i}`);

    // Reproduce countTasks' exact SQL via the shared builder, then EXPLAIN it.
    const { conditions, params } = tasksQueries.buildTaskListFilters(COMPANY_A, { status: 'open', scopeOwnerId: U });
    const sql = `SELECT COUNT(*)::int AS count FROM tasks t WHERE ${conditions.join(' AND ')}`;
    const defaultPlan = (await db.query(`EXPLAIN (FORMAT TEXT) ${sql}`, params)).rows.map(r => r['QUERY PLAN']).join('\n');

    // (1) The count touches ONLY `tasks` — the spec's "no per-row scan" contract. A
    //     Nested Loop / other-table scan / correlated SubPlan would be the regression
    //     (it would mean the count re-hydrates labels like the list's LEFT JOINs).
    //     A plain Seq Scan is fine here: this dev `tasks` table is ~12 rows, so the
    //     planner correctly prefers it over an index (cost < 1.1). The feature is
    //     declared migration-free; it must NOT add a per-row join.
    check(!/Nested Loop|Hash Join|Merge Join|SubPlan/.test(defaultPlan),
        `count plan must be join-free (no per-row label hydration).\nPlan:\n${defaultPlan}`);
    const otherTable = defaultPlan.match(/Scan on (\w+)/g)?.filter(s => !/ on tasks\b/.test(s)) || [];
    check(otherTable.length === 0, `count plan must scan ONLY tasks, saw: ${otherTable.join(', ')}\nPlan:\n${defaultPlan}`);

    // (2) The supporting index EXISTS and would be used at scale: with seqscan
    //     disabled the planner picks an idx_tasks_company_* index on `tasks` — proving
    //     access is served by existing company_id/status/owner_user_id indexes (spec:
    //     "no new index"). On a large tenant this is the plan that runs.
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
    const usesTasksIndex = /Index (Only )?Scan[^\n]*on tasks|Bitmap Index Scan on idx_tasks/.test(scaledPlan);
    check(usesTasksIndex,
        `with seqscan off, the count must use a tasks index (proves the supporting index exists).\nPlan:\n${scaledPlan}`);

    record('TC-40', 'PASS', `join-free single-tasks scan; index-usable at scale (${scaledPlan.split('\n').find(l => /Scan/.test(l))?.trim()})`);
});

// ---------------------------------------------------------------------------
// Negative control (sabotage) — proves the harness actually reports FAIL when the
// invariant is violated. Mirrors the email-script's deliberate-wrong approach: we
// run the SAME assertInvariant machinery against a KNOWN-WRONG expected value and
// assert that it throws a CheckError. If assertInvariant ever stopped detecting a
// mismatch, THIS case fails — so a green run also certifies the detector works.
CASE('TC-SABOTAGE', 'negative control: assertInvariant throws on a deliberately-wrong expectation', async () => {
    const U = await mkUser(COMPANY_A);
    await seedContactTask(COMPANY_A, U, 'sabotage'); // scoped count is truly 1
    let threw = false;
    try {
        // Deliberately assert the wrong exact value (999) — the detector MUST throw.
        await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: U }, 'sabotage wrong-expect', 999);
    } catch (e) {
        threw = e instanceof CheckError;
    }
    check(threw, 'SABOTAGE FAILED TO TRIP: assertInvariant did not throw on a wrong expectation — the detector is broken');
    // And the true invariant still holds for this state (count==list, value 1).
    await assertInvariant(COMPANY_A, { status: 'open', scopeOwnerId: U }, 'sabotage true state', 1);
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
    const selected = CASES.filter(c => sel === 'all' || c.id === sel);
    if (selected.length === 0) {
        console.error(`No cases match --section=${sel}. Cases: ${CASES.map(c => c.id).join(', ')}`);
        process.exit(2);
    }

    console.log(`TASKS-COUNT-BADGE-001 verify — DATABASE_URL=${process.env.DATABASE_URL}`);
    console.log(`Company A=${COMPANY_A} (seed, delta/scoped asserts) · Company B=${COMPANY_B} (tagged, temp)`);
    console.log(`Cases: ${sel} → ${selected.length}\n`);

    await cleanupAll();

    for (const c of selected) {
        await cleanupAll();
        try {
            await c.fn();
            // TC-40 records itself (custom note); avoid a duplicate PASS line.
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
