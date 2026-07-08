#!/usr/bin/env node
/**
 * OUTBOUND-PARTS-CALL-001 — OPC1-T17 real-DB verification harness (the late-stage P0 GATE).
 *
 * Proves the OUTBOUND-PARTS-CALL-001 behavior on a REAL local Postgres, calling the
 * REAL services / routes / worker / skill / FSM UNMOCKED — only VAPI (`outboundCallService.placeCall`),
 * Zenbooker (`zenbookerClient`, Module._load stub) and, at the module boundary,
 * slot-engine (`recommendSlots.run`) are stubbed. A mocked jest only validates
 * dispatch / SQL shape / call-order (LIST-PAGINATION-001 lesson); it can NOT prove
 * a task was re-homed, a partial-unique index actually blocked a 2nd active attempt,
 * a status transition survived a thrown fire-and-forget hook, a ZB 409 left NO false
 * success, or a tenant stayed isolated — each of those needs a real row + a sabotage
 * control so a green run is trustworthy.
 *
 * Mirrors scripts/verify-agent-skills-002.js / verify-contact-merge-001.js exactly
 * (Module._load ZB stub armed BEFORE any service loads, self-seeded uniquely-tagged
 * fixtures with tag OPC1, FK-ordered cleanup at start/per-case/end, sabotage kit,
 * --section, non-zero exit on any FAIL). Fixtures are tagged so real dev rows coexist
 * and EVERY assertion is ROW-TARGETED by a tagged id.
 *
 * Sections (--section=all|fsm|s1|s2|s3|s4|s5|s6|s8|s9|s10|s14|sab):
 *   fsm  (I01) — mig 156 published SCXML has Part_arrived; resolveTransition accepts
 *                Waiting for parts→Part arrived + Part arrived→{Rescheduled,Canceled,
 *                Follow Up}, rejects an invalid target.
 *   s1   (I02/I03) — real updateBlancStatus('Part arrived') → exactly ONE open
 *                part_arrived_call task w/ [robot_call,manual_call]; re-entry / dup
 *                onPartArrived → no 2nd task (SELECT-guard); Done task no longer blocks.
 *   s2   (I05/I17/I18) — robot_call → 1 pending attempt → worker tick (placeCall stub)
 *                → dialing+vapi_call_id → confirmPartsVisit → rescheduleItem(+ZB) +
 *                flip Rescheduled + AI-Phone note + task done + attempt booked; settings
 *                resolve defaults/override; rescheduleItem ZB write-through.
 *   s3   (I09) — decline → live recommendSlots alternatives → confirmPartsVisit books
 *                identically to s2.
 *   s4   (I10/I16) — no-answer webhook → note + retry (+2h) then next-morning; worker
 *                skips a Canceled job → attempt canceled.
 *   s5   (I11) — exhaustion after ×3 → attempt exhausted, task open, job stays Part arrived.
 *   s6   (I07) — no-slots / engine-throw BEFORE call → NO attempt, NO placeCall, task
 *                reason + robot_call state failed, job unchanged.
 *   s8   (I08) — confirmPartsVisit ZB 409 → conflict shape, job NOT Rescheduled, task
 *                NOT done, attempt NOT booked, no false success.
 *   s9   (I09-webhook/I12) — webhook classify: no_answer/voicemail/declined/booked; dup
 *                webhook on a terminal row → no-op; unknown call.id → 200 no-op.
 *   s10  (I13/I14/I15) — cross-tenant: foreign task → 404 (not 403), no attempt in A;
 *                confirmPartsVisit foreign job → safe refusal; webhook company FROM the
 *                attempt row (spoofed body company ignored); secret-auth reject.
 *   s14  (I06) — double robot_call on one job → ONE active attempt (23505 caught),
 *                2nd → in_flight_existing.
 *   sab  (ISAB) — (a) wrong-expectation: deliberately-wrong P0 asserts MUST trip;
 *                (b) амендмент #5 feature-neutralization (byte-level, NO git): neutralize
 *                the onPartArrived createTask call AND the startRobotCall partial-unique
 *                catch in place → s1/s14 children MUST FAIL → restore bytes (sha256-verified)
 *                → green re-run.
 *
 * Usage:
 *   node scripts/verify-outbound-parts-call-001.js [--section=<id>|all]
 *   DATABASE_URL defaults to postgresql://localhost/twilio_calls (house default).
 * Never point this at prod. Exit code 0 only when no case FAILs.
 */
'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/twilio_calls';
// The outbound VAPI request contract needs these present so placeCall's config
// pre-check passes when we exercise the REAL placeCall (it is stubbed everywhere it
// would dial, but env presence keeps any un-stubbed path honest).
process.env.VAPI_API_KEY = process.env.VAPI_API_KEY || 'test-vapi-key';
process.env.VAPI_OUTBOUND_ASSISTANT_ID = process.env.VAPI_OUTBOUND_ASSISTANT_ID || 'test-assistant';
process.env.VAPI_OUTBOUND_PHONE_NUMBER_ID = process.env.VAPI_OUTBOUND_PHONE_NUMBER_ID || 'test-phone-number';
// The webhook secret-auth (VAPI_WEBHOOK_SECRET / fallback VAPI_TOOLS_SECRET).
process.env.VAPI_WEBHOOK_SECRET = process.env.VAPI_WEBHOOK_SECRET || 'test-webhook-secret';
process.env.GOOGLE_GEOCODING_KEY = process.env.GOOGLE_GEOCODING_KEY || 'test-geocoding-key';

const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const WEBHOOK_SECRET = process.env.VAPI_WEBHOOK_SECRET;

// ─── Zenbooker stub (Module._load) — armed BEFORE any service importing
//     zenbookerClient loads (mirror verify-agent-skills-002.js). This is the seam
//     scheduleService.rescheduleItem / jobsService.addNote reach for. ────────────
const zbStub = {
    calls: [],
    _throwReschedule: null,
    _getJobResult: null,
    reset() { this.calls = []; this._throwReschedule = null; this._getJobResult = null; },
    _record(name, args) { this.calls.push({ name, args }); },
    countOf(name) { return this.calls.filter((c) => c.name === name).length; },
    lastOf(name) { return [...this.calls].reverse().find((c) => c.name === name) || null; },
    async rescheduleJob(zbJobId, payload) { this._record('rescheduleJob', [zbJobId, payload]); if (this._throwReschedule) throw this._throwReschedule; return { id: zbJobId, ...payload }; },
    async cancelJob(zbJobId) { this._record('cancelJob', [zbJobId]); return { id: zbJobId, status: 'cancelled' }; },
    async getJob(zbJobId) { this._record('getJob', [zbJobId]); return this._getJobResult; },
    async addJobNote(zbJobId, body) { this._record('addJobNote', [zbJobId, body]); return { id: `zbnote-${this.countOf('addJobNote')}` }; },
    async markJobComplete(id) { this._record('markJobComplete', [id]); return {}; },
    async markJobEnroute(id) { this._record('markJobEnroute', [id]); return {}; },
    async markJobInProgress(id) { this._record('markJobInProgress', [id]); return {}; },
    async findTerritoryByPostalCode() { return null; },
    async createJob() { return { id: 'zb-created' }; },
    async assignProviders() { return {}; },
    getClient() { return this; },
    getClientForCompany() { return this; },
};

const servicesRequire = Module.createRequire(path.join(ROOT, 'backend/src/services/noop.js'));
const ZB_CLIENT_FILE = servicesRequire.resolve('./zenbookerClient');
const origLoad = Module._load;
Module._load = function stubbedLoad(request, parent, isMain) {
    try {
        const resolved = Module._resolveFilename(request, parent, isMain);
        if (resolved === ZB_CLIENT_FILE) return zbStub;
    } catch (_e) { /* fall through */ }
    return origLoad.call(this, request, parent, isMain);
};

// ─── Real modules (loaded AFTER the ZB stub is armed) ───────────────────────────
const db = require(path.join(ROOT, 'backend/src/db/connection'));
const jobsService = require(path.join(ROOT, 'backend/src/services/jobsService'));
const partsCallService = require(path.join(ROOT, 'backend/src/services/partsCallService'));
const outboundCallService = require(path.join(ROOT, 'backend/src/services/outboundCallService'));
const outboundCallWorker = require(path.join(ROOT, 'backend/src/services/outboundCallWorker'));
const outboundCallSettingsService = require(path.join(ROOT, 'backend/src/services/outboundCallSettingsService'));
const agentSkills = require(path.join(ROOT, 'backend/src/services/agentSkills'));
const scheduleService = require(path.join(ROOT, 'backend/src/services/scheduleService'));
const fsmService = require(path.join(ROOT, 'backend/src/services/fsmService'));
const tasksQueries = require(path.join(ROOT, 'backend/src/db/tasksQueries'));
const recommendSlots = require(path.join(ROOT, 'backend/src/services/agentSkills/skills/recommendSlots'));

const COMPANY_A = '00000000-0000-0000-0000-000000000001'; // = DEFAULT_COMPANY_ID (v1 dial gate; real dev rows coexist → row-targeted asserts)
const COMPANY_B = 'c0000000-0000-4000-8000-0000000000f1'; // tagged, CREATED + deleted here (cross-tenant, S10)
const TZ = 'America/New_York';
const TAG = 'OPC1';

// A confirmed slot the whole harness reuses (ET → UTC in July = -04:00).
const SLOT = { key: 'opc1-slot', date: '2026-07-16', start: '10:00', end: '12:00', label: 'Thursday between 10 AM and 12 PM' };
const SLOT_START_ISO = '2026-07-16T14:00:00.000Z'; // 10:00 ET
const SLOT_END_ISO = '2026-07-16T16:00:00.000Z';   // 12:00 ET
const ALT_SLOT = { key: 'opc1-alt', date: '2026-07-17', start: '13:00', end: '15:00', label: 'Friday between 1 PM and 3 PM' };
const ALT_START_ISO = '2026-07-17T17:00:00.000Z';

// ─── tiny assert/report kit (mirrors verify-agent-skills-002.js) ────────────────
class CheckError extends Error {}
function check(cond, msg) { if (!cond) throw new CheckError(msg); }
function eq(actual, expected, label) { check(String(actual) === String(expected), `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
function assertNoSubstring(haystack, needles, label) {
    const hay = typeof haystack === 'string' ? haystack : JSON.stringify(haystack);
    for (const n of needles) check(!hay.includes(n), `${label}: leaked forbidden substring ${JSON.stringify(n)} — ${hay.slice(0, 200)}`);
}
const results = [];
function record(id, status, note) {
    results.push({ id, status, note: note || '' });
    const pad = ' '.repeat(Math.max(1, 14 - id.length));
    console.log(`${status} ${id}${pad}${note || ''}`);
}
/** Non-vacuous sabotage helper: true only if a CheckError actually tripped. */
async function sabotageTrips(body) {
    try { await body(); return false; } catch (e) { return e instanceof CheckError; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(300); // let a fire-and-forget hook settle

// ─── slot-engine boundary stub (per-case) ───────────────────────────────────────
// recommendSlots is required by partsCallService at top-level; monkeypatching .run
// on the shared module object rewires BOTH the harness's copy and the service's.
const realRecommendRun = recommendSlots.run;
function stubRecommend(mode, slots = [SLOT]) {
    recommendSlots.run = async () => {
        if (mode === 'throw') throw new Error('OPC1 stub: engine fault');
        if (mode === 'fallback') return { available: false, slots: [], fallback: true };
        return { available: true, slots };
    };
}
function restoreRecommend() { recommendSlots.run = realRecommendRun; }

// ─── business-hours stub (per-case) — the worker clamps dials to the company's
//     open hours via groupRouting.isBusinessHours. The happy-path cases (s2/s3)
//     declare "in business hours" as a PRECONDITION, so we force it open for the
//     worker tick rather than depend on the wall-clock or mutate shared dev group
//     rows. The clamp itself (outside hours → no dial) is exercised in s4. ───────
const groupRouting = require(path.join(ROOT, 'backend/src/services/groupRouting'));
const realIsBusinessHours = groupRouting.isBusinessHours;
function forceBusinessHours(open) { groupRouting.isBusinessHours = async () => open; }
function restoreBusinessHours() { groupRouting.isBusinessHours = realIsBusinessHours; }

// ─── VAPI placeCall stub (per-case) — records requests, never dials ─────────────
const realPlaceCall = outboundCallService.placeCall;
const placeCallLog = [];
function stubPlaceCall(id = 'vapi_call_test') {
    placeCallLog.length = 0;
    outboundCallService.placeCall = async (args) => { placeCallLog.push(args); return { ok: true, vapiCallId: id }; };
}
function restorePlaceCall() { outboundCallService.placeCall = realPlaceCall; }

// ─── the REAL tasks-action route, mounted with stub auth ────────────────────────
const request = require('supertest');
const appCache = {};
function appFor(companyId, { permissions = ['tasks.manage', 'tasks.view'], noUser = false } = {}) {
    const key = `${companyId}|${permissions.join(',')}|${noUser}`;
    if (appCache[key]) return appCache[key];
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        if (noUser) { return res.status(401).json({ ok: false, error: 'Unauthorized' }); }
        req.user = { sub: 'opc1-verify', name: 'OPC1 Verify', email: 'opc1@opc1.test', crmUser: { id: null } };
        req.authz = { permissions, company: { id: companyId, timezone: TZ }, scopes: {} };
        req.companyFilter = { company_id: companyId };
        next();
    });
    app.use('/api/tasks', require(path.join(ROOT, 'backend/src/routes/tasks')));
    app.use('/api/vapi/call-status', require(path.join(ROOT, 'backend/src/routes/vapiCallStatus')));
    appCache[key] = app;
    return app;
}
async function robotCallAction(taskId, companyId = COMPANY_A, opts = {}) {
    return request(appFor(companyId, opts)).post(`/api/tasks/${taskId}/actions/robot_call`).send({});
}
async function taskAction(taskId, type, companyId = COMPANY_A, opts = {}) {
    return request(appFor(companyId, opts)).post(`/api/tasks/${taskId}/actions/${type}`).send({});
}
async function postWebhook(body, { secret = WEBHOOK_SECRET, companyId = COMPANY_A } = {}) {
    const req = request(appFor(companyId)).post('/api/vapi/call-status');
    if (secret !== null) req.set('x-vapi-secret', secret);
    return req.send(body);
}

// ─── seeding helpers (all tagged OPC1) ──────────────────────────────────────────
let seq = 0;
function nextPhone() { seq += 1; return `+1617${String(5550000 + seq).padStart(7, '0')}`; }

async function ensureCompanyB() {
    await db.query(
        `INSERT INTO companies (id, name, slug, status, settings) VALUES ($1,$2,$3,'active','{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
        [COMPANY_B, `${TAG}-CompanyB`, `${TAG}-company-b`],
    );
}

async function seedContact(companyId, { fullName = `${TAG} Jane` } = {}) {
    const r = await db.query(
        `INSERT INTO contacts (company_id, full_name, notes) VALUES ($1,$2,$3) RETURNING id`,
        [companyId, fullName, `${TAG}-contact`],
    );
    return Number(r.rows[0].id);
}

/** Insert a tagged job. `customer_name` carries the tag for cleanup. */
async function seedJob(companyId, {
    contactId = null, blancStatus = 'Part arrived', zenbookerJobId = null,
    customerName = `${TAG} Jane`, customerPhone = null, address = '12 Walpole St, Boston, MA 02101',
    startIso = SLOT_START_ISO, endIso = SLOT_END_ISO,
} = {}) {
    const r = await db.query(
        `INSERT INTO jobs (company_id, contact_id, blanc_status, zenbooker_job_id, customer_name, customer_phone,
                           address, start_date, end_date, service_name, notes, zb_rescheduled, zb_canceled,
                           assigned_provider_user_ids, geocoding_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'[]'::jsonb, false, false, '[]'::jsonb, 'none') RETURNING id`,
        [companyId, contactId, blancStatus, zenbookerJobId, customerName, customerPhone || nextPhone(),
            address, startIso, endIso, `${TAG} Refrigerator Repair`],
    );
    return Number(r.rows[0].id);
}

/** Insert a tagged open part_arrived_call task with the two typed actions. */
async function seedPartArrivedTask(companyId, { jobId, status = 'open' } = {}) {
    const actions = [
        { type: 'robot_call', label: '🤖 Let the robot call' },
        { type: 'manual_call', label: "📞 I'll call myself" },
    ];
    const r = await db.query(
        `INSERT INTO tasks (company_id, job_id, subject_type, subject_id, title, status, priority,
                            created_by, show_on_schedule, kind, actions)
         VALUES ($1,$2,'job',$2,$3,$4,'p2','user',false,'part_arrived_call',$5::jsonb) RETURNING id`,
        [companyId, jobId, `${TAG} Part arrived — schedule completion visit`, status, JSON.stringify(actions)],
    );
    return Number(r.rows[0].id);
}

/** Insert a tagged outbound_call_attempts row directly (for webhook/worker cases). */
async function seedAttempt(companyId, { jobId, taskId, contactId = null, phone = null, status = 'dialing', attemptNo = 1, vapiCallId = null, scheduledAt = null, slotJson = SLOT } = {}) {
    const r = await db.query(
        `INSERT INTO outbound_call_attempts
            (company_id, job_id, task_id, contact_id, phone, attempt_no, status, vapi_call_id, scheduled_at, slot_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9::timestamptz, now()), $10::jsonb) RETURNING id`,
        [companyId, jobId, taskId, contactId, phone || nextPhone(), attemptNo, status, vapiCallId, scheduledAt, JSON.stringify(slotJson)],
    );
    return Number(r.rows[0].id);
}

async function ensureSettings(companyId, { maxAttempts = 3, backoff = ['immediate', '+2h', 'next_business_morning'], nextMorningHour = 9, enabled = true } = {}) {
    await db.query(
        `INSERT INTO outbound_call_settings (company_id, max_attempts, backoff_schedule, next_morning_hour, enabled)
         VALUES ($1,$2,$3::jsonb,$4,$5)
         ON CONFLICT (company_id) DO UPDATE SET max_attempts=$2, backoff_schedule=$3::jsonb, next_morning_hour=$4, enabled=$5`,
        [companyId, maxAttempts, JSON.stringify(backoff), nextMorningHour, enabled],
    );
}

// ─── cleanup (FK order; run at start, before each case, and at end) ─────────────
async function cleanupAll() {
    // Tagged job / task / contact id sets.
    const { rows: jobRows } = await db.query(
        `SELECT id FROM jobs WHERE customer_name LIKE $1 OR service_name LIKE $1 OR company_id = $2`,
        [`${TAG}%`, COMPANY_B],
    );
    const jobIds = jobRows.map((r) => String(r.id));

    // domain_events on tagged jobs (logEvent writes 'job' aggregates).
    if (jobIds.length) {
        await db.query(`DELETE FROM domain_events WHERE aggregate_type = 'job' AND aggregate_id = ANY($1::text[])`, [jobIds]);
    }
    await db.query(`DELETE FROM domain_events WHERE company_id = $1`, [COMPANY_B]);

    // outbound_call_attempts first (FK job_id/task_id/contact_id).
    if (jobIds.length) {
        await db.query(`DELETE FROM outbound_call_attempts WHERE job_id = ANY($1::bigint[])`, [jobIds]);
    }
    await db.query(`DELETE FROM outbound_call_attempts WHERE company_id = $1`, [COMPANY_B]);

    // tasks (part_arrived_call on tagged jobs + tagged titles + company B).
    if (jobIds.length) {
        await db.query(`DELETE FROM tasks WHERE job_id = ANY($1::bigint[])`, [jobIds]);
    }
    await db.query(`DELETE FROM tasks WHERE title LIKE $1 OR company_id = $2`, [`${TAG}%`, COMPANY_B]);

    // jobs → contacts (plain FKs; jobs before contacts).
    await db.query(`DELETE FROM jobs WHERE customer_name LIKE $1 OR service_name LIKE $1 OR company_id = $2`, [`${TAG}%`, COMPANY_B]);
    await db.query(`DELETE FROM contacts WHERE notes = $1 OR company_id = $2`, [`${TAG}-contact`, COMPANY_B]);

    // outbound_call_settings for company B (leave company A's row alone if any).
    await db.query(`DELETE FROM outbound_call_settings WHERE company_id = $1`, [COMPANY_B]);
    await db.query(`DELETE FROM companies WHERE id = $1`, [COMPANY_B]);

    zbStub.reset();
    restoreRecommend();
    restorePlaceCall();
    restoreBusinessHours();
}

// ─── small DB read helpers (row-targeted) ───────────────────────────────────────
async function jobRow(jobId) {
    const { rows } = await db.query(`SELECT id, blanc_status, start_date, end_date, contact_id, notes FROM jobs WHERE id = $1`, [jobId]);
    return rows[0] || null;
}
async function taskRow(companyId, taskId) {
    const { rows } = await db.query(`SELECT id, status, kind, actions, job_id FROM tasks WHERE company_id = $1 AND id = $2`, [companyId, taskId]);
    return rows[0] || null;
}
async function openPartTasks(companyId, jobId) {
    const { rows } = await db.query(
        `SELECT id, actions FROM tasks WHERE company_id = $1 AND job_id = $2 AND kind = 'part_arrived_call' AND status = 'open'`,
        [companyId, jobId],
    );
    return rows;
}
async function attemptRows(jobId) {
    const { rows } = await db.query(`SELECT id, status, attempt_no, vapi_call_id, scheduled_at FROM outbound_call_attempts WHERE job_id = $1 ORDER BY id`, [jobId]);
    return rows;
}
async function activeAttemptCount(jobId) {
    const { rows } = await db.query(
        `SELECT COUNT(*)::int AS n FROM outbound_call_attempts WHERE job_id = $1 AND status IN ('pending','dialing')`,
        [jobId],
    );
    return rows[0].n;
}
function jobNotesText(job) {
    const notes = Array.isArray(job.notes) ? job.notes : [];
    return notes.map((n) => n && n.text ? n.text : '').join(' | ');
}

// ═════════════════════════════════════════════════════════════════════════════
// Cases
// ═════════════════════════════════════════════════════════════════════════════
const CASES = [];
function CASE(id, section, title, fn) { CASES.push({ id, section, title, fn }); }

// ── fsm (TC-OPC-I01) — FSM-MIG-156 gate ──────────────────────────────────────
CASE('OPC1-FSM', 'fsm', 'mig156: Part arrived is a valid published state; Waiting→Part arrived + Part arrived→{Rescheduled,Canceled,Follow Up} allowed; invalid rejected', async () => {
    // 1) The published SCXML for company A's job machine has the Part_arrived state
    //    (and a TO_PART_ARRIVED action transition on Waiting_for_parts).
    const { rows } = await db.query(
        `SELECT v.scxml_source AS src FROM fsm_machines m
         JOIN fsm_versions v ON v.id = m.active_version_id
         WHERE m.company_id = $1 AND m.machine_key = 'job'`,
        [COMPANY_A],
    );
    check(rows[0], 'published job machine exists for company A (mig 156 applied)');
    const src = rows[0].src;
    check(/id="Part_arrived"/.test(src), 'published SCXML contains <state id="Part_arrived">');
    check(/TO_PART_ARRIVED/.test(src), 'published SCXML contains the TO_PART_ARRIVED action transition');

    // 2) resolveTransition accepts the four new edges.
    const accept = [
        ['Waiting for parts', 'Part arrived'],
        ['Part arrived', 'Rescheduled'],
        ['Part arrived', 'Canceled'],
        ['Part arrived', 'Follow Up with Client'],
    ];
    for (const [from, to] of accept) {
        const r = await fsmService.resolveTransition(COMPANY_A, 'job', from, to);
        check(r.valid === true, `resolveTransition ${from} → ${to} must be valid (got ${JSON.stringify(r)})`);
    }
    // 3) An invalid target from Part arrived is rejected.
    const bad = await fsmService.resolveTransition(COMPANY_A, 'job', 'Part arrived', 'Job is Done');
    check(bad.valid === false, `resolveTransition Part arrived → Job is Done must be rejected (got ${JSON.stringify(bad)})`);

    // 4) The hardcoded fallback map carries the same edges.
    check((jobsService.ALLOWED_TRANSITIONS['Part arrived'] || []).includes('Rescheduled'), 'hardcoded fallback: Part arrived → Rescheduled present');
    check((jobsService.ALLOWED_TRANSITIONS['Waiting for parts'] || []).includes('Part arrived'), 'hardcoded fallback: Waiting for parts → Part arrived present');

    record('OPC1-FSM', 'PASS', 'Part_arrived published + 4 edges valid, invalid rejected, fallback map carries edges');
});

// ── s1 (TC-OPC-I02 / I03) — auto-task idempotence ─────────────────────────────
CASE('OPC1-S1', 's1', 'updateBlancStatus(Part arrived) fires hook → exactly ONE open part_arrived_call task w/ 2 actions; re-entry + dup onPartArrived → no 2nd task; Done no longer blocks', async () => {
    const contactId = await seedContact(COMPANY_A);
    const jobId = await seedJob(COMPANY_A, { contactId, blancStatus: 'Waiting for parts', customerName: `${TAG} Alice` });

    // Real transition through the FSM-validated updateBlancStatus.
    const out = await jobsService.updateBlancStatus(jobId, 'Part arrived', COMPANY_A);
    eq(out.blanc_status, 'Part arrived', 'transition committed');
    eq(out._prev_status, 'Waiting for parts', '_prev_status carried');
    await settle(); // fire-and-forget hook

    const j = await jobRow(jobId);
    eq(j.blanc_status, 'Part arrived', 'job persisted as Part arrived');

    let open = await openPartTasks(COMPANY_A, jobId);
    eq(open.length, 1, 'exactly ONE open part_arrived_call task');
    const actions = Array.isArray(open[0].actions) ? open[0].actions : [];
    const types = actions.map((a) => a.type).sort();
    eq(JSON.stringify(types), JSON.stringify(['manual_call', 'robot_call']), 'actions = [robot_call, manual_call]');

    // Re-entry via updateBlancStatus (no-op transition guarded by _prev_status) +
    // a direct duplicate onPartArrived → the SELECT-guard hits → still ONE task.
    await partsCallService.onPartArrived(jobId, COMPANY_A);
    await partsCallService.onPartArrived(jobId, COMPANY_A);
    await settle();
    open = await openPartTasks(COMPANY_A, jobId);
    eq(open.length, 1, 'still exactly ONE open task after duplicate onPartArrived (SELECT-guard)');
    const taskId = open[0].id;

    // Edge-3: a Done task no longer blocks — re-entry creates a fresh open task.
    await tasksQueries.updateTask(COMPANY_A, taskId, { status: 'done' });
    await partsCallService.onPartArrived(jobId, COMPANY_A);
    await settle();
    open = await openPartTasks(COMPANY_A, jobId);
    eq(open.length, 1, 'a Done task no longer blocks → exactly one fresh open task (edge-3)');
    check(String(open[0].id) !== String(taskId), 'the fresh task is a NEW row (the Done one no longer counts)');

    record('OPC1-S1', 'PASS', `1 open task (2 actions); dup onPartArrived no 2nd; Done→fresh open (edge-3)`);
});

// ── s2 (TC-OPC-I05 / I17 / I18) — happy path end-to-end ───────────────────────
CASE('OPC1-S2', 's2', 'robot_call → 1 pending attempt → worker tick (placeCall stub) → dialing+vapi_id → confirmPartsVisit → reschedule(+ZB)+flip Rescheduled+note+task done+attempt booked; settings resolve; ZB write-through', async () => {
    const contactId = await seedContact(COMPANY_A);
    const jobId = await seedJob(COMPANY_A, { contactId, blancStatus: 'Part arrived', zenbookerJobId: 'zb-opc1-s2', customerName: `${TAG} Bob` });
    const taskId = await seedPartArrivedTask(COMPANY_A, { jobId });

    // TC-OPC-I17: settings resolver — no row → defaults; then an override drives.
    const defaults = await outboundCallSettingsService.resolve(COMPANY_A);
    eq(defaults.max_attempts, 3, 'resolve() with no row → default max_attempts 3');
    eq(JSON.stringify(defaults.backoff_schedule), JSON.stringify(['immediate', '+2h', 'next_business_morning']), 'default backoff schedule');
    await ensureSettings(COMPANY_A, { maxAttempts: 5 });
    eq((await outboundCallSettingsService.resolve(COMPANY_A)).max_attempts, 5, 'A row override drives max_attempts');
    await ensureSettings(COMPANY_A, {}); // reset to defaults for the rest

    stubRecommend('happy', [SLOT]);
    stubPlaceCall('vapi_call_s2');

    // 1) robot_call → one pending attempt with slot_json.
    const r1 = await robotCallAction(taskId);
    eq(r1.status, 200, 'robot_call route 200');
    eq(r1.body.data.state, 'queued', 'robot_call state queued');
    let attempts = await attemptRows(jobId);
    eq(attempts.length, 1, 'exactly ONE attempt inserted');
    eq(attempts[0].status, 'pending', 'attempt pending');

    // 2) worker tick (in business hours — the S2 precondition) → dialing + vapi_id.
    forceBusinessHours(true);
    const claimed = await outboundCallWorker.tick();
    restoreBusinessHours();
    check(claimed >= 1, `worker claimed the due row (claimed ${claimed})`);
    eq(placeCallLog.length, 1, 'placeCall invoked exactly once (VAPI stub — never dialed)');
    attempts = await attemptRows(jobId);
    eq(attempts[0].status, 'dialing', 'attempt flipped to dialing');
    eq(attempts[0].vapi_call_id, 'vapi_call_s2', 'vapi_call_id stored for webhook correlation');

    // 3) confirmPartsVisit via the real skill dispatch (simulating the in-call tool).
    zbStub.reset();
    const conf = await agentSkills.runSkill('confirmPartsVisit', COMPANY_A, { source: 'test' }, {
        jobId, taskId, contactId, chosenSlot: SLOT,
    });
    check(conf && conf.ok === true && conf.success === true && conf.booked === true, `confirmPartsVisit success (got ${JSON.stringify(conf)})`);

    // TC-OPC-I18: rescheduleItem AR-4 ZB write-through fired once with the derived window.
    eq(zbStub.countOf('rescheduleJob'), 1, 'ZB rescheduleJob called exactly once (AR-4 write-through)');
    const zbCall = zbStub.lastOf('rescheduleJob');
    eq(zbCall.args[0], 'zb-opc1-s2', 'ZB reschedule targeted the linked zb job id');
    eq(zbCall.args[1].arrival_window_minutes, 120, 'arrival_window_minutes = end − start (120)');

    // Same job mutated (no new job), status flipped, note + task done + attempt booked.
    const j = await jobRow(jobId);
    eq(new Date(j.start_date).toISOString(), SLOT_START_ISO, 'job start moved to the confirmed slot (same job)');
    eq(j.blanc_status, 'Rescheduled', 'blanc_status flipped to Rescheduled');
    check(/via AI Phone/.test(jobNotesText(j)), 'an "AI Phone" reschedule note was written');
    eq((await taskRow(COMPANY_A, taskId)).status, 'done', 'part_arrived_call task auto-closed (done)');

    // 4) webhook booked → attempt booked (job already Rescheduled → booked-detected).
    await postWebhook({ message: { type: 'end-of-call-report', call: { id: 'vapi_call_s2' }, endedReason: 'assistant-ended-call' } });
    attempts = await attemptRows(jobId);
    const booked = attempts.find((a) => a.vapi_call_id === 'vapi_call_s2');
    eq(booked.status, 'booked', 'attempt marked booked by the webhook (job Rescheduled → terminal success)');

    record('OPC1-S2', 'PASS', `queued→dialing→booked; reschedule same job + ZB 1× (window 120); flip Rescheduled; note; task done`);
});

// ── s3 (TC-OPC-I09) — decline → live alternatives → book identically ──────────
CASE('OPC1-S3', 's3', 'decline → live recommendSlots alternatives → confirmPartsVisit(chosen alt) books identically (reschedule+ZB+flip+note+task done)', async () => {
    const contactId = await seedContact(COMPANY_A);
    const jobId = await seedJob(COMPANY_A, { contactId, blancStatus: 'Part arrived', zenbookerJobId: 'zb-opc1-s3', customerName: `${TAG} Carol` });
    const taskId = await seedPartArrivedTask(COMPANY_A, { jobId });

    // The in-call tool re-pulls recommendSlots (live, via the same real skill) — stub
    // the boundary to return 2 alternatives; the customer picks ALT_SLOT.
    stubRecommend('happy', [ALT_SLOT, SLOT]);
    const alts = await agentSkills.runSkill('recommendSlots', COMPANY_A, { source: 'test' }, { zip: '02101', unitType: 'Refrigerator' });
    // recommendSlots is a legacy L0 tool returning the frozen {available,slots,fallback}
    // shape (NOT the resultShapes ok-envelope). Assert it surfaced ≥1 live alternative.
    check(alts && alts.available === true && Array.isArray(alts.slots) && alts.slots.length >= 1,
        `recommendSlots (live) returned ≥1 alternative (got ${JSON.stringify(alts).slice(0, 120)})`);

    zbStub.reset();
    const conf = await agentSkills.runSkill('confirmPartsVisit', COMPANY_A, { source: 'test' }, {
        jobId, taskId, contactId, chosenSlot: ALT_SLOT,
    });
    check(conf && conf.ok === true && conf.booked === true, `confirmPartsVisit(alt) success (got ${JSON.stringify(conf)})`);
    const j = await jobRow(jobId);
    eq(new Date(j.start_date).toISOString(), ALT_START_ISO, 'job moved to the chosen ALTERNATIVE slot');
    eq(j.blanc_status, 'Rescheduled', 'flipped Rescheduled');
    eq(zbStub.countOf('rescheduleJob'), 1, 'ZB pushed once (same path as s2)');
    eq((await taskRow(COMPANY_A, taskId)).status, 'done', 'task done');

    record('OPC1-S3', 'PASS', `decline→live alts→booked ALT slot; identical terminal state to s2`);
});

// ── s4 (TC-OPC-I10 / I16) — no-answer retry + worker canceled-job skip ────────
CASE('OPC1-S4', 's4', 'no-answer webhook → note + retry (+2h) → next-morning; per-attempt note; worker skips a Canceled job → attempt canceled', async () => {
    await ensureSettings(COMPANY_A, {});
    const contactId = await seedContact(COMPANY_A);
    const jobId = await seedJob(COMPANY_A, { contactId, blancStatus: 'Part arrived', customerName: `${TAG} Dave` });
    const taskId = await seedPartArrivedTask(COMPANY_A, { jobId });

    // Attempt 1 dialing with a correlation id → webhook classifies no-answer.
    await seedAttempt(COMPANY_A, { jobId, taskId, contactId, status: 'dialing', attemptNo: 1, vapiCallId: 'vc_s4_1' });
    await postWebhook({ message: { type: 'end-of-call-report', call: { id: 'vc_s4_1' }, endedReason: 'customer-did-not-answer' } });

    let attempts = await attemptRows(jobId);
    const a1 = attempts.find((a) => a.vapi_call_id === 'vc_s4_1');
    eq(a1.status, 'no_answer', 'attempt 1 classified no_answer');
    const a2 = attempts.find((a) => a.attempt_no === 2 && a.status === 'pending');
    check(a2, 'a NEW attempt 2 was scheduled');
    // attempt 2 backoff = +2h from now (immediate/+2h/next → index 1 for attempt 2).
    const dt = new Date(a2.scheduled_at).getTime() - Date.now();
    check(dt > 90 * 60 * 1000 && dt < 150 * 60 * 1000, `attempt 2 scheduled ~+2h (got ${Math.round(dt / 60000)} min)`);
    let j = await jobRow(jobId);
    check(/next attempt at/.test(jobNotesText(j)), 'a per-attempt "next attempt at" note was written');

    // Attempt 2 → no-answer → attempt 3 next business morning (09:00 local).
    await db.query(`UPDATE outbound_call_attempts SET status='dialing', vapi_call_id='vc_s4_2' WHERE id=$1`, [a2.id]);
    await postWebhook({ message: { type: 'end-of-call-report', call: { id: 'vc_s4_2' }, endedReason: 'customer-did-not-answer' } });
    attempts = await attemptRows(jobId);
    const a3 = attempts.find((a) => a.attempt_no === 3 && a.status === 'pending');
    check(a3, 'a NEW attempt 3 was scheduled (next business morning)');
    // 09:00 ET → 13:00Z; verify the local hour is 9.
    const localHour = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date(a3.scheduled_at));
    eq(Number(localHour) % 24, 9, 'attempt 3 scheduled at 09:00 company-local (next business morning)');

    // TC-OPC-I16: a worker tick on a due attempt whose job was Canceled → skip + canceled.
    const jobId2 = await seedJob(COMPANY_A, { contactId, blancStatus: 'Canceled', customerName: `${TAG} Erin` });
    const attId = await seedAttempt(COMPANY_A, { jobId: jobId2, taskId, contactId, status: 'pending', attemptNo: 1, scheduledAt: new Date(Date.now() - 1000).toISOString() });
    stubPlaceCall('vc_should_not_place');
    await outboundCallWorker.tick();
    eq(placeCallLog.length, 0, 'worker did NOT place a call for the Canceled job');
    const canceledAtt = (await db.query(`SELECT status FROM outbound_call_attempts WHERE id=$1`, [attId])).rows[0];
    eq(canceledAtt.status, 'failed', 'attempt on a Canceled job terminated (no dial)');

    record('OPC1-S4', 'PASS', `no-answer→+2h→next-morning(09:00), per-attempt notes; worker skipped Canceled job (no dial)`);
});

// ── s5 (TC-OPC-I11) — exhaustion after ×3 ─────────────────────────────────────
CASE('OPC1-S5', 's5', 'exhaustion: 3rd no-answer at max_attempts → attempt exhausted, task stays open, job stays Part arrived (no flip), final note', async () => {
    await ensureSettings(COMPANY_A, { maxAttempts: 3 });
    const contactId = await seedContact(COMPANY_A);
    const jobId = await seedJob(COMPANY_A, { contactId, blancStatus: 'Part arrived', customerName: `${TAG} Frank` });
    const taskId = await seedPartArrivedTask(COMPANY_A, { jobId });
    await seedAttempt(COMPANY_A, { jobId, taskId, contactId, status: 'dialing', attemptNo: 3, vapiCallId: 'vc_s5_3' });

    await postWebhook({ message: { type: 'end-of-call-report', call: { id: 'vc_s5_3' }, endedReason: 'customer-did-not-answer' } });

    const attempts = await attemptRows(jobId);
    check(attempts.some((a) => a.status === 'exhausted'), 'an exhausted terminal attempt exists');
    check(!attempts.some((a) => a.status === 'pending'), 'NO further pending attempt scheduled after exhaustion');
    eq((await taskRow(COMPANY_A, taskId)).status, 'open', 'task STAYS open with the dispatcher');
    const j = await jobRow(jobId);
    eq(j.blanc_status, 'Part arrived', 'job STAYS Part arrived (no flip)');
    check(/exhausted/.test(jobNotesText(j)), 'a final "attempts exhausted" note was written');

    record('OPC1-S5', 'PASS', `3rd no-answer→exhausted; task open; job Part arrived; no further attempt`);
});

// ── s6 (TC-OPC-I07) — no-slots / engine-error BEFORE call ─────────────────────
CASE('OPC1-S6', 's6', 'no-slots (fallback) AND engine-throw → NO attempt, NO placeCall, task reason + robot_call state failed, job unchanged', async () => {
    for (const mode of ['fallback', 'throw']) {
        const contactId = await seedContact(COMPANY_A);
        const jobId = await seedJob(COMPANY_A, { contactId, blancStatus: 'Part arrived', customerName: `${TAG} NoSlot-${mode}` });
        const taskId = await seedPartArrivedTask(COMPANY_A, { jobId });
        stubRecommend(mode);
        stubPlaceCall('vc_should_not_place');

        const r = await robotCallAction(taskId);
        eq(r.status, 200, `robot_call route 200 (${mode}) — the action ran, it just could not dial`);
        eq(r.body.data.state, 'failed', `robot_call state failed (${mode})`);

        eq((await attemptRows(jobId)).length, 0, `NO attempt row inserted (${mode})`);
        eq(placeCallLog.length, 0, `placeCall NEVER called (${mode})`);
        const t = await taskRow(COMPANY_A, taskId);
        eq(t.status, 'open', `task stays open (${mode})`);
        const rc = (t.actions || []).find((a) => a.type === 'robot_call');
        eq(rc.state, 'failed', `robot_call action state set to failed (${mode})`);
        check(rc.reason && rc.reason.length > 0, `a dispatcher-facing reason written on the action (${mode})`);
        eq((await jobRow(jobId)).blanc_status, 'Part arrived', `job unchanged (${mode})`);
        restoreRecommend(); restorePlaceCall();
    }
    record('OPC1-S6', 'PASS', `fallback+throw → no attempt, no placeCall, state failed+reason, job Part arrived`);
});

// ── s8 (TC-OPC-I08) — ZB 409 at booking → no false success ────────────────────
CASE('OPC1-S8', 's8', 'confirmPartsVisit ZB 409 → conflict shape, job NOT Rescheduled, task NOT done, attempt NOT booked, no false success', async () => {
    const contactId = await seedContact(COMPANY_A);
    const jobId = await seedJob(COMPANY_A, { contactId, blancStatus: 'Part arrived', zenbookerJobId: 'zb-opc1-s8', customerName: `${TAG} Grace` });
    const taskId = await seedPartArrivedTask(COMPANY_A, { jobId });
    await seedAttempt(COMPANY_A, { jobId, taskId, contactId, status: 'dialing', attemptNo: 1, vapiCallId: 'vc_s8' });

    zbStub.reset();
    zbStub._throwReschedule = { statusCode: 409 };

    const conf = await agentSkills.runSkill('confirmPartsVisit', COMPANY_A, { source: 'test' }, {
        jobId, taskId, contactId, chosenSlot: SLOT,
    });
    check(conf && conf.ok === false && conf.success === false && conf.conflict === true, `conflict shape, no false success (got ${JSON.stringify(conf)})`);

    const j = await jobRow(jobId);
    eq(j.blanc_status, 'Part arrived', 'job NOT flipped to Rescheduled on a ZB 409');
    check(!/via AI Phone/.test(jobNotesText(j)), 'no false "AI Phone" reschedule note');
    eq((await taskRow(COMPANY_A, taskId)).status, 'open', 'task NOT closed');
    const att = (await attemptRows(jobId)).find((a) => a.vapi_call_id === 'vc_s8');
    eq(att.status, 'dialing', 'attempt NOT marked booked (still dialing)');

    record('OPC1-S8', 'PASS', `ZB 409 → conflict; job Part arrived; task open; attempt not booked; no false success`);
});

// ── s9 (TC-OPC-I09-webhook / I12) — classification + idempotence ──────────────
CASE('OPC1-S9', 's9', 'webhook classify no_answer/voicemail/declined; dup webhook on terminal row → no-op; unknown call.id → 200 no-op', async () => {
    await ensureSettings(COMPANY_A, {});
    const contactId = await seedContact(COMPANY_A);

    // no_answer → transient + retry.
    let jobId = await seedJob(COMPANY_A, { contactId, blancStatus: 'Part arrived', customerName: `${TAG} W1` });
    let taskId = await seedPartArrivedTask(COMPANY_A, { jobId });
    await seedAttempt(COMPANY_A, { jobId, taskId, contactId, status: 'dialing', attemptNo: 1, vapiCallId: 'vc_w_na' });
    await postWebhook({ message: { type: 'end-of-call-report', call: { id: 'vc_w_na' }, endedReason: 'customer-busy' } });
    let atts = await attemptRows(jobId);
    eq(atts.find((a) => a.vapi_call_id === 'vc_w_na').status, 'no_answer', 'customer-busy → no_answer');
    check(atts.some((a) => a.attempt_no === 2 && a.status === 'pending'), 'no_answer schedules a retry');

    // voicemail → voicemail + retry.
    jobId = await seedJob(COMPANY_A, { contactId, blancStatus: 'Part arrived', customerName: `${TAG} W2` });
    taskId = await seedPartArrivedTask(COMPANY_A, { jobId });
    await seedAttempt(COMPANY_A, { jobId, taskId, contactId, status: 'dialing', attemptNo: 1, vapiCallId: 'vc_w_vm' });
    await postWebhook({ message: { type: 'end-of-call-report', call: { id: 'vc_w_vm' }, endedReason: 'voicemail' } });
    atts = await attemptRows(jobId);
    eq(atts.find((a) => a.vapi_call_id === 'vc_w_vm').status, 'voicemail', 'voicemail → voicemail');

    // declined → terminal, NO retry.
    jobId = await seedJob(COMPANY_A, { contactId, blancStatus: 'Part arrived', customerName: `${TAG} W3` });
    taskId = await seedPartArrivedTask(COMPANY_A, { jobId });
    await seedAttempt(COMPANY_A, { jobId, taskId, contactId, status: 'dialing', attemptNo: 1, vapiCallId: 'vc_w_dec' });
    await postWebhook({ message: { type: 'end-of-call-report', call: { id: 'vc_w_dec' }, endedReason: 'customer-declined' } });
    atts = await attemptRows(jobId);
    eq(atts.find((a) => a.vapi_call_id === 'vc_w_dec').status, 'declined', 'customer-declined → declined (terminal)');
    check(!atts.some((a) => a.status === 'pending'), 'declined does NOT schedule a retry');

    // Idempotence: a duplicate webhook on a terminal (booked) attempt is a no-op.
    jobId = await seedJob(COMPANY_A, { contactId, blancStatus: 'Rescheduled', customerName: `${TAG} W4` });
    taskId = await seedPartArrivedTask(COMPANY_A, { jobId, status: 'done' });
    await seedAttempt(COMPANY_A, { jobId, taskId, contactId, status: 'booked', attemptNo: 1, vapiCallId: 'vc_w_dup' });
    const before = JSON.stringify(await attemptRows(jobId));
    await postWebhook({ message: { type: 'end-of-call-report', call: { id: 'vc_w_dup' }, endedReason: 'assistant-ended-call' } });
    await postWebhook({ message: { type: 'end-of-call-report', call: { id: 'vc_w_dup' }, endedReason: 'assistant-ended-call' } });
    eq(JSON.stringify(await attemptRows(jobId)), before, 'duplicate webhook on a terminal attempt is a byte-identical no-op');

    // Unknown call.id → 200 no-op (no leak, no throw).
    const r = await postWebhook({ message: { type: 'end-of-call-report', call: { id: 'vc_unknown_zzz' }, endedReason: 'customer-did-not-answer' } });
    eq(r.status, 200, 'unknown call.id → 200 no-op');
    eq(r.body.ok, true, 'unknown call.id envelope ok:true');

    record('OPC1-S9', 'PASS', `busy→no_answer+retry; voicemail; declined terminal no-retry; dup terminal no-op; unknown id 200`);
});

// ── s10 (TC-OPC-I13 / I14 / I15) — cross-tenant / isolation / secret-auth ─────
CASE('OPC1-S10', 's10', 'foreign task → 404 (not 403), no attempt in A; confirmPartsVisit foreign job → safe refusal; webhook company FROM row (spoof ignored); secret-auth reject', async () => {
    await ensureCompanyB();
    const bContact = await seedContact(COMPANY_B);
    const bJobId = await seedJob(COMPANY_B, { contactId: bContact, blancStatus: 'Part arrived', zenbookerJobId: 'zb-opc1-b', customerName: `${TAG} BOwner` });
    const bTaskId = await seedPartArrivedTask(COMPANY_B, { jobId: bJobId });
    const bJobBefore = JSON.stringify(await jobRow(bJobId));

    // 1) The A-scoped route loading B's task → 404 (foreign id, NOT 403), no leak.
    const r1 = await robotCallAction(bTaskId, COMPANY_A);
    eq(r1.status, 404, 'foreign task → 404 (not 403)');
    eq((await attemptRows(bJobId)).length, 0, 'no attempt created for the foreign job');

    // 2) confirmPartsVisit for B's job scoped to A → safe refusal, no write.
    zbStub.reset();
    const conf = await agentSkills.runSkill('confirmPartsVisit', COMPANY_A, { source: 'test' }, {
        jobId: bJobId, contactId: bContact, taskId: bTaskId, chosenSlot: SLOT,
    });
    check(conf && conf.ok === false, `cross-company confirmPartsVisit → safe refusal (got ${JSON.stringify(conf)})`);
    eq(zbStub.countOf('rescheduleJob'), 0, 'no ZB push on the refused cross-company booking');
    eq(JSON.stringify(await jobRow(bJobId)), bJobBefore, "company B's job byte-unchanged");
    eq((await taskRow(COMPANY_B, bTaskId)).status, 'open', "company B's task untouched");

    // 3) Webhook company FROM the correlated row — a spoofed body company is ignored.
    const aContact = await seedContact(COMPANY_A);
    const aJobId = await seedJob(COMPANY_A, { contactId: aContact, blancStatus: 'Part arrived', customerName: `${TAG} AOwner` });
    const aTaskId = await seedPartArrivedTask(COMPANY_A, { jobId: aJobId });
    await seedAttempt(COMPANY_A, { jobId: aJobId, taskId: aTaskId, contactId: aContact, status: 'dialing', attemptNo: 1, vapiCallId: 'vc_iso' });
    const bAttBefore = (await attemptRows(bJobId)).length;
    await postWebhook({ message: { type: 'end-of-call-report', call: { id: 'vc_iso' }, endedReason: 'customer-did-not-answer', companyId: COMPANY_B, company_id: COMPANY_B } });
    // The retry lands on A's job (company from the row), not B.
    const aAtts = await attemptRows(aJobId);
    check(aAtts.some((a) => a.status === 'no_answer'), 'A attempt classified (company from the correlated row)');
    check(aAtts.some((a) => a.attempt_no === 2 && a.status === 'pending'), 'retry scheduled on company A (spoofed body company ignored)');
    eq((await attemptRows(bJobId)).length, bAttBefore, "NO company-B attempt touched by the spoofed webhook");

    // 4) Secret-auth: missing / wrong secret → rejected (not a user session).
    const noSecret = await postWebhook({ message: { call: { id: 'vc_iso' } } }, { secret: null });
    eq(noSecret.status, 401, 'missing secret → 401');
    const wrongSecret = await postWebhook({ message: { call: { id: 'vc_iso' } } }, { secret: 'nope' });
    eq(wrongSecret.status, 401, 'wrong secret → 401');

    record('OPC1-S10', 'PASS', `foreign task 404; cross-company confirm refused; webhook company-from-row; secret-auth rejects`);
});

// ── s14 (TC-OPC-I06) — double robot_call → ONE active attempt ──────────────────
CASE('OPC1-S14', 's14', 'double (and triple) robot_call on one job → partial-unique blocks a 2nd active row → exactly ONE active attempt; 2nd → in_flight_existing (graceful, no 500)', async () => {
    const contactId = await seedContact(COMPANY_A);
    const jobId = await seedJob(COMPANY_A, { contactId, blancStatus: 'Part arrived', customerName: `${TAG} Helen` });
    const taskId = await seedPartArrivedTask(COMPANY_A, { jobId });
    stubRecommend('happy', [SLOT]);

    const r1 = await robotCallAction(taskId);
    eq(r1.status, 200, 'first robot_call 200');
    eq(r1.body.data.state, 'queued', 'first → queued (fresh attempt)');

    const r2 = await robotCallAction(taskId);
    eq(r2.status, 200, 'second robot_call 200 (graceful, no 500 from the unique violation)');
    eq(r2.body.data.state, 'in_flight_existing', 'second → in_flight_existing (partial-unique caught)');

    const r3 = await robotCallAction(taskId);
    eq(r3.body.data.state, 'in_flight_existing', 'third → in_flight_existing');

    eq(await activeAttemptCount(jobId), 1, 'exactly ONE active (pending/dialing) attempt for the job (partial-unique enforced on the REAL DB)');

    record('OPC1-S14', 'PASS', `double/triple press → ONE active attempt; 2nd/3rd in_flight_existing (no 500)`);
});

// ── sab (TC-OPC-ISAB) — two-legged sabotage ───────────────────────────────────
// Leg A: wrong-expectation controls (each MUST trip a CheckError).
CASE('OPC1-SAB-1', 'sab', 'sabotage (wrong-expectation): deliberately-wrong P0 asserts MUST trip; then restore green', async () => {
    // Set up a real happy booking, a real double-press, a real ZB-409, a real foreign 404.
    // (a) S8-like ZB 409 → assert the WRONG thing (status flipped) → must trip.
    const c1 = await seedContact(COMPANY_A);
    const j1 = await seedJob(COMPANY_A, { contactId: c1, blancStatus: 'Part arrived', zenbookerJobId: 'zb-sab-409', customerName: `${TAG} Sab409` });
    const t1 = await seedPartArrivedTask(COMPANY_A, { jobId: j1 });
    zbStub.reset(); zbStub._throwReschedule = { statusCode: 409 };
    await agentSkills.runSkill('confirmPartsVisit', COMPANY_A, { source: 'test' }, { jobId: j1, taskId: t1, contactId: c1, chosenSlot: SLOT });
    const trippedA = await sabotageTrips(async () => {
        eq((await jobRow(j1)).blanc_status, 'Rescheduled', 'SABOTAGE: assert flip on a ZB 409 (intentionally wrong — it stays Part arrived)');
    });
    check(trippedA, 'SABOTAGE FAILED TO TRIP (ZB-409): the status detector did not catch a wrong expectation');
    zbStub.reset();

    // (b) S14 double-press → assert TWO active attempts (only one exists) → must trip.
    const c2 = await seedContact(COMPANY_A);
    const j2 = await seedJob(COMPANY_A, { contactId: c2, blancStatus: 'Part arrived', customerName: `${TAG} SabDup` });
    const t2 = await seedPartArrivedTask(COMPANY_A, { jobId: j2 });
    stubRecommend('happy', [SLOT]);
    await robotCallAction(t2); await robotCallAction(t2);
    const trippedB = await sabotageTrips(async () => {
        eq(await activeAttemptCount(j2), 2, 'SABOTAGE: assert 2 active attempts (intentionally wrong — the partial-unique keeps it at 1)');
    });
    check(trippedB, 'SABOTAGE FAILED TO TRIP (dup-call): the active-attempt counter did not catch a wrong count');
    restoreRecommend();

    // (c) S10 foreign task → assert 200 (it is 404) → must trip.
    await ensureCompanyB();
    const bc = await seedContact(COMPANY_B);
    const bj = await seedJob(COMPANY_B, { contactId: bc, blancStatus: 'Part arrived', customerName: `${TAG} SabB` });
    const bt = await seedPartArrivedTask(COMPANY_B, { jobId: bj });
    const foreign = await robotCallAction(bt, COMPANY_A);
    const trippedC = await sabotageTrips(async () => {
        eq(foreign.status, 200, 'SABOTAGE: assert foreign task returns 200 (intentionally wrong — it is 404)');
    });
    check(trippedC, 'SABOTAGE FAILED TO TRIP (cross-tenant): the 404 detector did not catch a wrong status');

    // Restore the TRUE expectations → green.
    eq((await jobRow(j1)).blanc_status, 'Part arrived', 'restored: ZB-409 left the job Part arrived');
    eq(await activeAttemptCount(j2), 1, 'restored: exactly one active attempt');
    eq(foreign.status, 404, 'restored: foreign task is 404');

    record('OPC1-SAB-1', 'PASS', 'wrong-expectation controls all tripped (ZB-409 / dup-call / cross-tenant); restored green');
});

// Leg B (амендмент #5): byte-level feature-neutralization (NO git). Neutralize the
// onPartArrived createTask call AND the startRobotCall partial-unique catch in place →
// s1 (idempotence) and s14 (dup-call) children MUST FAIL → restore bytes (sha256) → green.
CASE('OPC1-SAB-2', 'sab', 'sabotage (амендмент #5, feature-neutralize): byte-neutralize partsCallService → s1/s14 children MUST FAIL → restore bytes → green', async () => {
    if (process.env.OPC1_CHILD) {
        record('OPC1-SAB-2', 'SKIP', 'child process — feature-neutralize runs only in the parent');
        return;
    }
    const fs = require('fs');
    const SERVICE = path.join(ROOT, 'backend/src/services/partsCallService.js');
    const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
    const original = fs.readFileSync(SERVICE);
    const originalSha = sha256(original);
    const src = original.toString('utf8');

    // Seam 1: onPartArrived returns BEFORE createTask (auto-task never created → S1 idempotence
    //         gate's "exactly one open task" goes RED because zero tasks exist).
    const anchor1 = '    return tasksQueries.createTask(';
    // Seam 2: startRobotCall's partial-unique catch re-throws instead of returning the
    //         in-flight row → the 2nd press bubbles a 23505 → the route 500s → S14 goes RED.
    const anchor2 = "            if (err.code === '23505') {";
    check(src.includes(anchor1), 'sab-2: createTask anchor present in partsCallService source');
    check(src.includes(anchor2), 'sab-2: partial-unique catch anchor present in partsCallService source');
    const sabotaged = src
        .replace(anchor1, '    return null; // OPC1-SAB-2 TEMPORARY SABOTAGE — auto-task suppressed\n    // eslint-disable-next-line no-unreachable\n    return tasksQueries.createTask(')
        .replace(anchor2, "            if (false && err.code === '23505') { // OPC1-SAB-2 TEMPORARY SABOTAGE — unique catch neutralized");
    check(sabotaged !== src && sha256(Buffer.from(sabotaged, 'utf8')) !== originalSha, 'sab-2: sabotage actually changed the bytes');

    const runChild = (section) => spawnSync(process.execPath, [__filename, `--section=${section}`], {
        cwd: ROOT,
        env: { ...process.env, OPC1_CHILD: '1' },
        encoding: 'utf8',
        timeout: 180000,
    });

    console.log('    [sab-2] writing the byte-neutralized service (auto-task suppressed + unique-catch neutralized; no git)…');
    const sabotagedExits = {};
    try {
        fs.writeFileSync(SERVICE, sabotaged);
        for (const s of ['s1', 's14']) {
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
    for (const s of ['s1', 's14']) {
        check(sabotagedExits[s] === 1,
            `--section=${s} with the service NEUTRALIZED must exit 1 (recorded FAILs); got exit ${sabotagedExits[s]}. ` +
            'A harness that stays green against the pre-feature world makes every PASS vacuous → release blocked.');
    }
    // Restored world → the same sections must be green again.
    for (const s of ['s1', 's14']) {
        const r = runChild(s);
        console.log(`    [sab-2] restored run --section=${s} → exit ${r.status}`);
        check(r.status === 0, `--section=${s} after restore must exit 0; got ${r.status}\n${(r.stdout || '').slice(-1500)}`);
    }

    record('OPC1-SAB-2', 'PASS', 'byte-neutralized partsCallService → s1/s14 FAILed → restored (sha256) → green');
});

// ═════════════════════════════════════════════════════════════════════════════
// Runner
// ═════════════════════════════════════════════════════════════════════════════
function parseSectionArg() {
    const arg = process.argv.find((a) => a.startsWith('--section='));
    const v = arg ? arg.split('=')[1] : (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'all');
    return v || 'all';
}

async function main() {
    const sel = parseSectionArg();
    const selected = CASES.filter((c) => sel === 'all' || c.id === sel || c.section === sel);
    if (selected.length === 0) {
        console.error(`No cases match "${sel}". Cases: ${CASES.map((c) => c.id).join(', ')}; sections: ${[...new Set(CASES.map((c) => c.section))].join(', ')}`);
        await db.pool.end();
        process.exit(2);
    }

    console.log(`OUTBOUND-PARTS-CALL-001 verify — DATABASE_URL=${process.env.DATABASE_URL}`);
    console.log(`Company A=${COMPANY_A} (= DEFAULT_COMPANY_ID / v1 dial gate; real dev rows coexist → asserts row-targeted by tag 'OPC1')`);
    console.log(`Company B=${COMPANY_B} (seeded here for cross-tenant rows that MUST be invisible)`);
    console.log(`Stubbed: VAPI placeCall + Zenbooker (Module._load) + slot-engine recommendSlots (module boundary). Everything else is real.`);
    console.log(`Selection: ${sel} → ${selected.length} case(s)\n`);

    await cleanupAll();
    for (const c of selected) {
        await cleanupAll();
        try {
            await c.fn();
            if (!results.some((r) => r.id === c.id)) record(c.id, 'PASS', c.title);
        } catch (e) {
            const note = `${c.title} — ${e instanceof CheckError ? e.message : (e.stack || e.message)}`;
            record(c.id, 'FAIL', note);
        } finally {
            restoreRecommend();
            restorePlaceCall();
            restoreBusinessHours();
        }
    }
    await cleanupAll();

    const pass = results.filter((r) => r.status === 'PASS').length;
    const fail = results.filter((r) => r.status === 'FAIL').length;
    const skip = results.filter((r) => r.status === 'SKIP').length;
    console.log(`\n══════════════════════════════════════════════`);
    console.log(`PASS ${pass} · FAIL ${fail}${skip ? ` · SKIP ${skip}` : ''} (of ${results.length})`);
    if (fail > 0) console.log(`FAILED: ${results.filter((r) => r.status === 'FAIL').map((r) => r.id).join(', ')}`);
    console.log(`OUTBOUND-PARTS-CALL-001 P0 gates on real rows:`);
    console.log(`  FSM-mig-156 (fsm) · task idempotence (s1) · happy path (s2) · dup-call partial-unique (s14) ·`);
    console.log(`  no-slots no-call (s6) · ZB-409 no-false-success (s8) · cross-tenant (s10). Sabotage (sab) certifies the detectors.`);

    await db.pool.end();
    process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
    console.error('FATAL:', e);
    try { await db.pool.end(); } catch { /* noop */ }
    process.exit(1);
});
