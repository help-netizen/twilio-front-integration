#!/usr/bin/env node
/**
 * VAPI-SLOT-ENGINE-001 — T4 real-DB integration verify.
 *
 * Proves the load-bearing invariants on a REAL local Postgres (no mocks — a mocked
 * jest only validates the SQL string / dispatch shape, LIST-PAGINATION-001 lesson):
 *   • a caller's held lead (open + geo, in-window) really BLOCKS its window in the
 *     engine occupancy, and is ABSENT when terminal-status / geo-less / out-of-window;
 *   • createLead persists a chosen slot as real TIMESTAMPTZ + coords and the lead
 *     renders on the Schedule UNION; without a chosen slot all four columns stay NULL;
 *   • convert (status='Converted') and lose (status='Lost') really DROP the lead from
 *     BOTH the occupancy sub-read AND the Schedule UNION — the case-fix (LOWER(status))
 *     is what frees the slot (a bare case-sensitive NOT IN would keep the capitalized
 *     'Converted'/'Lost' row in both, failing AC-6);
 *   • tzCombine is DST-aware (EDT date → UTC−4, EST date → UTC−5);
 *   • the held-lead sub-read is date-windowed / company-scoped / small (EXPLAIN);
 *   • the repo assistant JSON is valid (6 tools, recommendSlots shape + 8 params,
 *     scheduling prompt steps 6+9 rewritten) — NOT pushed to the live assistant.
 *
 * REAL (unmocked) functions exercised:
 *   • slotEngineService._buildScheduledJobs(companyId, start, end, tz [, excludeJobId])  (T1 occupancy)
 *   • slotEngineService.tzCombine / resolveTimezone                                       (T1 helpers)
 *   • leadsService.createLead (body composed exactly as vapi-tools handleCreateLead) +
 *     leadsService.markLost                                                               (T2 persist / lifecycle)
 *   • scheduleQueries.getScheduleItems (the leads-in-Schedule UNION render, T1 case-fix)
 *
 * Fixtures are self-seeded with the unique tag VSE1 (leads.uuid LIKE 'vse1%';
 * leads.uuid is varchar(20) so the tag is kept short + unique) and cleaned BEFORE
 * every case and at process start/end (FK order: leads first — its children
 * lead_team_assignments/tasks CASCADE, jobs/estimates/invoices SET NULL). Company A =
 * the seed company 00000000-0000-0000-0000-000000000001; real dev leads coexist, so
 * EVERY assertion is row-targeted by the tagged lead id, NEVER an absolute whole-
 * company count.
 *
 * Convert is applied as a direct `UPDATE ... SET status='Converted'` — the exact
 * value convertLead writes (leadsService.js:704) — so the case-fix is proven in
 * isolation from convertLead's heavy ZB/job side effects (which are out of scope
 * here and would add unrelated fragility). markLost is the real service function.
 *
 * Usage:
 *   node scripts/verify-vapi-slot-engine-001.js [--section=<id>|all]
 *   DATABASE_URL defaults to postgresql://localhost/twilio_calls (house default).
 * Never point this at prod. Exit code 0 only when no case FAILs.
 */
'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/twilio_calls';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const db = require(path.join(ROOT, 'backend/src/db/connection'));
const slotEngineService = require(path.join(ROOT, 'backend/src/services/slotEngineService'));
const leadsService = require(path.join(ROOT, 'backend/src/services/leadsService'));
const scheduleQueries = require(path.join(ROOT, 'backend/src/db/scheduleQueries'));

const COMPANY_A = '00000000-0000-0000-0000-000000000001'; // seed company (real dev data coexists)
const TZ = 'America/New_York';                            // company A dispatch tz (verified)

// A fixed window well clear of "today" so it survives real dev rows and any horizon
// math. Uses a July date (EDT, UTC−4) so tzCombine's DST branch is exercised end-to-end.
const WIN_DATE = '2026-07-08';        // Wednesday, EDT
const WIN_START = '10:00';
const WIN_END = '13:00';
const WIN_ISO_START = '2026-07-08T14:00:00.000Z'; // 10:00 America/New_York (EDT = UTC−4)
const WIN_ISO_END = '2026-07-08T17:00:00.000Z';   // 13:00 America/New_York
// The occupancy / render window we query (a day on each side of the held slot).
const Q_START = '2026-07-07';
const Q_END = '2026-07-09';
// Boston-ish coords (in a plausible service area; only presence, not routing, matters here).
const LAT = 42.3601;
const LNG = -71.0589;

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

// ─── seeding helpers (all tagged VSE1) ──────────────────────────────────────

let leadSeq = 0;
function nextUuid() {
    leadSeq += 1;
    // leads.uuid is varchar(20); keep the tagged value short + unique.
    return `vse1${String(leadSeq).padStart(3, '0')}${Date.now().toString(36)}`.slice(0, 20);
}

/**
 * Insert a tagged lead row directly so we control status / dates / coords exactly
 * (including shapes the app writers wouldn't emit, e.g. a capitalized-terminal lead
 * that carries lead_date_time). Returns { id, uuid }.
 */
async function seedLead({
    status = 'Review',
    startIso = WIN_ISO_START,
    endIso = WIN_ISO_END,
    lat = LAT,
    lng = LNG,
    jobType = 'Refrigerator Repair',
    firstName = 'VSE1',
} = {}) {
    const uuid = nextUuid();
    const r = await db.query(
        `INSERT INTO leads (uuid, company_id, status, first_name, job_type,
                            lead_date_time, lead_end_date_time, latitude, longitude)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, uuid`,
        [uuid, COMPANY_A, status, firstName, jobType, startIso, endIso, lat, lng]
    );
    return { id: Number(r.rows[0].id), uuid: r.rows[0].uuid };
}

// ─── cleanup (FK order; run before every case + at start/end) ───────────────

async function cleanupAll() {
    // Tasks/jobs/estimates/invoices that reference a tagged lead (only tasks CASCADE
    // on lead delete; the rest SET NULL). We create none of those here, but scrub any
    // tagged strays defensively before deleting the leads themselves.
    await db.query(`DELETE FROM tasks WHERE lead_id IN (SELECT id FROM leads WHERE uuid LIKE 'vse1%')`);
    // lead_team_assignments CASCADE on lead delete; leads last.
    await db.query(`DELETE FROM leads WHERE uuid LIKE 'vse1%'`);
}

// ─── occupancy / render helpers (REAL functions) ────────────────────────────

/** REAL held-lead occupancy read: the entry buildScheduledJobs pushes for a lead. */
async function occupancyEntryFor(leadId, { start = Q_START, end = Q_END } = {}) {
    const out = await slotEngineService._buildScheduledJobs(COMPANY_A, start, end, TZ);
    return out.find(o => o.id === `lead:${leadId}`) || null;
}

/** REAL Schedule leads-UNION render: does the tagged lead appear as a 'lead' item? */
async function scheduleLeadItemFor(leadId, { start = Q_START, end = Q_END } = {}) {
    const { rows } = await scheduleQueries.getScheduleItems({
        companyId: COMPANY_A,
        startDate: start,
        endDate: end,
        entityTypes: ['lead'],
        timezone: TZ,
        limit: 500,
    });
    return rows.find(r => r.entity_type === 'lead' && Number(r.entity_id) === Number(leadId)) || null;
}

/** The exact held-lead sub-read SQL from slotEngineService.buildScheduledJobs (for EXPLAIN). */
const HELD_LEAD_SQL = `
    SELECT id, lead_date_time, lead_end_date_time, latitude, longitude, job_type
    FROM leads
    WHERE company_id = $1
      AND LOWER(status) NOT IN ('converted','lost','spam')
      AND lead_date_time IS NOT NULL
      AND latitude IS NOT NULL AND longitude IS NOT NULL
      AND lead_date_time >= ($2::date::timestamp AT TIME ZONE $4)
      AND lead_date_time <  (($3::date + INTERVAL '1 day')::timestamp AT TIME ZONE $4)
`;

// ═════════════════════════════════════════════════════════════════════════════
// Cases
// ═════════════════════════════════════════════════════════════════════════════

const CASES = [];
function CASE(id, section, title, fn) {
    CASES.push({ id, section, title, fn });
}

// ── occ — VSE-INT-01 (held-lead occupancy, P0-gate) ──────────────────────────
CASE('VSE-INT-01', 'occ', 'held-lead occupancy: present when open+geo; absent when terminal/geo-less/out-of-window', async () => {
    // (present) open 'Review' lead with coords, in-window → in occupancy, shape correct.
    const held = await seedLead({ status: 'Review' });
    const entry = await occupancyEntryFor(held.id);
    check(entry !== null, `held 'Review' lead must appear in occupancy as lead:${held.id}`);
    eq(entry.id, `lead:${held.id}`, 'occupancy id');
    check(Array.isArray(entry.assigned_technicians) && entry.assigned_technicians.length === 0,
        `held lead is an area block: assigned_technicians must be [] (got ${JSON.stringify(entry.assigned_technicians)})`);
    eq(entry.date, WIN_DATE, 'occupancy local date');
    eq(entry.window_start, WIN_START, 'occupancy window_start (company-local HH:MM)');
    eq(entry.window_end, WIN_END, 'occupancy window_end');
    check(Number(entry.lat) === LAT && Number(entry.lng) === LNG, `occupancy lat/lng carried (${entry.lat},${entry.lng})`);
    eq(entry.duration_minutes, 180, 'occupancy duration_minutes = window span (10:00→13:00)');
    check(entry.status === 'scheduled', 'occupancy status normalized to scheduled');

    // (absent a) capitalized terminal status 'Converted' — proves LOWER(status) case-fix.
    const conv = await seedLead({ status: 'Converted' });
    check((await occupancyEntryFor(conv.id)) === null,
        `capitalized 'Converted' lead MUST be excluded from occupancy (proves LOWER(status) case-fix)`);
    // (absent a') capitalized terminal status 'Lost'.
    const lost = await seedLead({ status: 'Lost' });
    check((await occupancyEntryFor(lost.id)) === null,
        `capitalized 'Lost' lead MUST be excluded from occupancy (proves LOWER(status) case-fix)`);

    // (absent b) open lead with lead_date_time but NULL coords → geo-skip.
    const noGeo = await seedLead({ status: 'Review', lat: null, lng: null });
    check((await occupancyEntryFor(noGeo.id)) === null,
        `open lead with NULL latitude/longitude MUST be excluded (geo requirement)`);

    // (absent c) open lead with coords but OUT of the query window → not in occupancy.
    const outWin = await seedLead({
        status: 'Review',
        startIso: '2026-08-20T14:00:00.000Z',
        endIso: '2026-08-20T17:00:00.000Z',
    });
    check((await occupancyEntryFor(outWin.id)) === null,
        `lead outside the [${Q_START}..${Q_END}] window MUST be excluded`);
    // …and the in-window held lead is still present alongside all the controls.
    check((await occupancyEntryFor(held.id)) !== null, 'in-window held lead still present with controls seeded');

    record('VSE-INT-01', 'PASS', `held present (lead:${held.id}, techs:[]); Converted/Lost/no-geo/out-of-window all absent`);
});

// ── persist — VSE-INT-05 (createLead persist + render, P0-gate) ───────────────
CASE('VSE-INT-05', 'persist', 'createLead persists real TIMESTAMPTZ+coords via tzCombine and renders on Schedule; no chosenSlot → NULL', async () => {
    // Compose the createLead body EXACTLY as vapi-tools handleCreateLead does for a
    // valid chosenSlot + coords: resolveTimezone → tzCombine both endpoints → add
    // Latitude/Longitude. Then call the REAL leadsService.createLead.
    const tz = await slotEngineService.resolveTimezone(COMPANY_A);
    eq(tz, TZ, 'resolveTimezone(companyA)');
    const body = {
        FirstName: 'VSE1', LastName: 'Persist', Phone: '+16175550137',
        Status: 'Review', JobType: 'Dishwasher Repair', JobSource: 'AI Phone',
        Comments: 'VSE1 persist case',
        LeadDateTime: slotEngineService.tzCombine(WIN_DATE, WIN_START, tz),
        LeadEndDateTime: slotEngineService.tzCombine(WIN_DATE, WIN_END, tz),
        Latitude: LAT, Longitude: LNG,
    };
    // Tag the uuid post-hoc isn't possible (createLead generates it), so we target the
    // returned id/uuid directly and clean by the FirstName/Comments tag as a backstop.
    const created = await leadsService.createLead(body, COMPANY_A);
    const leadId = Number(created.ClientId);
    check(Number.isFinite(leadId), `createLead returned a numeric ClientId (got ${created.ClientId})`);
    // Retag the freshly-created row's uuid so cleanupAll('vse1%') sweeps it.
    await db.query(`UPDATE leads SET uuid = $1 WHERE id = $2`, [nextUuid(), leadId]);

    // Row-level assertion: the four columns landed as real values.
    const { rows } = await db.query(
        `SELECT lead_date_time, lead_end_date_time, latitude, longitude, status FROM leads WHERE id = $1`,
        [leadId]
    );
    check(rows.length === 1, 'created lead row exists');
    const row = rows[0];
    eq(new Date(row.lead_date_time).toISOString(), WIN_ISO_START, 'persisted lead_date_time = tzCombine(EDT) instant');
    eq(new Date(row.lead_end_date_time).toISOString(), WIN_ISO_END, 'persisted lead_end_date_time');
    check(row.latitude !== null && Number(row.latitude) === LAT, `persisted latitude (${row.latitude})`);
    check(row.longitude !== null && Number(row.longitude) === LNG, `persisted longitude (${row.longitude})`);
    eq(row.status, 'Review', 'persisted status stays non-terminal Review');

    // Render: the held lead appears on the Schedule leads-UNION at that time.
    const item = await scheduleLeadItemFor(leadId);
    check(item !== null, `persisted lead must render as a 'lead' schedule item (id ${leadId})`);
    eq(new Date(item.start_at).toISOString(), WIN_ISO_START, 'schedule item start_at = the hold instant');
    // And it occupies the engine slot too (persist ⇒ occupancy, end-to-end).
    check((await occupancyEntryFor(leadId)) !== null, 'persisted lead also occupies the engine slot');

    // Back-compat: createLead WITHOUT chosenSlot ⇒ all four columns NULL.
    const bcBody = {
        FirstName: 'VSE1', LastName: 'NoSlot', Phone: '+16175550188',
        Status: 'Review', JobType: 'Appliance Repair', JobSource: 'AI Phone',
        Comments: 'VSE1 back-compat',
    };
    const bc = await leadsService.createLead(bcBody, COMPANY_A);
    const bcId = Number(bc.ClientId);
    await db.query(`UPDATE leads SET uuid = $1 WHERE id = $2`, [nextUuid(), bcId]);
    const bcRow = (await db.query(
        `SELECT lead_date_time, lead_end_date_time, latitude, longitude FROM leads WHERE id = $1`, [bcId]
    )).rows[0];
    check(bcRow.lead_date_time === null && bcRow.lead_end_date_time === null
        && bcRow.latitude === null && bcRow.longitude === null,
        `back-compat: no chosenSlot ⇒ all four columns NULL (got ${JSON.stringify(bcRow)})`);
    // A slot-less lead is not in the occupancy (lead_date_time NULL filtered out).
    check((await occupancyEntryFor(bcId)) === null, 'slot-less lead is not in occupancy');

    record('VSE-INT-05', 'PASS', `slot persisted (${WIN_ISO_START}), renders + occupies; no-slot lead ⇒ 4 NULLs`);
});

// ── free — VSE-INT-07 (convert DROPs the slot; proves case-fix) ──────────────
CASE('VSE-INT-07', 'free', 'convert (status=Converted) drops the lead from occupancy AND Schedule — slot freed', async () => {
    const held = await seedLead({ status: 'Review' });
    // Pre-condition: the hold occupies both surfaces.
    check((await occupancyEntryFor(held.id)) !== null, 'pre-convert: lead occupies the engine slot');
    check((await scheduleLeadItemFor(held.id)) !== null, 'pre-convert: lead renders on the Schedule');

    // Convert = the exact status value convertLead writes (leadsService.js:704),
    // applied directly so the case-fix is proven without ZB/job side effects.
    await db.query(`UPDATE leads SET status = 'Converted' WHERE id = $1`, [held.id]);

    // Post: dropped from BOTH — a bare case-sensitive NOT IN would have kept it.
    check((await occupancyEntryFor(held.id)) === null,
        `'Converted' lead MUST drop from occupancy (LOWER(status) frees the slot)`);
    check((await scheduleLeadItemFor(held.id)) === null,
        `'Converted' lead MUST drop from the Schedule leads-UNION (LOWER(l.status) case-fix)`);

    // Symmetry: the window is free again for a fresh in-window held lead.
    const next = await seedLead({ status: 'Review' });
    check((await occupancyEntryFor(next.id)) !== null, 'the same window is offerable again after convert');

    record('VSE-INT-07', 'PASS', `Converted lead left occupancy + Schedule; window re-offerable`);
});

// ── free — VSE-INT-08 (lose DROPs the slot; proves case-fix) ─────────────────
CASE('VSE-INT-08', 'free', 'markLost (status=Lost) drops the lead from occupancy AND Schedule — slot freed', async () => {
    const held = await seedLead({ status: 'Review' });
    check((await occupancyEntryFor(held.id)) !== null, 'pre-lost: lead occupies the engine slot');
    check((await scheduleLeadItemFor(held.id)) !== null, 'pre-lost: lead renders on the Schedule');

    // REAL service function — writes capitalized 'Lost' (leadsService.js:459).
    await leadsService.markLost(held.uuid, COMPANY_A);
    const st = (await db.query(`SELECT status FROM leads WHERE id = $1`, [held.id])).rows[0].status;
    eq(st, 'Lost', 'markLost wrote capitalized Lost');

    check((await occupancyEntryFor(held.id)) === null,
        `'Lost' lead MUST drop from occupancy (LOWER(status) frees the slot)`);
    check((await scheduleLeadItemFor(held.id)) === null,
        `'Lost' lead MUST drop from the Schedule leads-UNION (LOWER(l.status) case-fix)`);

    record('VSE-INT-08', 'PASS', `Lost lead (via real markLost) left occupancy + Schedule`);
});

// ── tz — VSE-U-01 (tz-combine DST, P0) ───────────────────────────────────────
CASE('VSE-U-01', 'tz', 'tzCombine is DST-aware: EDT date → UTC−4, EST date → UTC−5, GMT/no-offset → 0', async () => {
    // EDT (summer, UTC−4).
    eq(slotEngineService.tzCombine('2026-07-08', '10:00', TZ), '2026-07-08T14:00:00.000Z', 'EDT 10:00 → 14:00Z');
    // EST (winter, UTC−5).
    eq(slotEngineService.tzCombine('2026-01-08', '10:00', TZ), '2026-01-08T15:00:00.000Z', 'EST 10:00 → 15:00Z');
    // A non-ET zone at the same wall clock resolves its own offset (Denver: MDT UTC−6 in July).
    eq(slotEngineService.tzCombine('2026-07-08', '10:00', 'America/Denver'), '2026-07-08T16:00:00.000Z', 'MDT 10:00 → 16:00Z');
    // UTC → offset 0 (identity).
    eq(slotEngineService.tzCombine('2026-07-08', '10:00', 'UTC'), '2026-07-08T10:00:00.000Z', 'UTC 10:00 → 10:00Z (offset 0)');
    record('VSE-U-01', 'PASS', `EDT/EST/MDT/UTC instants exact (DST-aware)`);
});

// ── explain — EXPLAIN the held-lead sub-read ─────────────────────────────────
CASE('VSE-EXPLAIN', 'explain', 'held-lead sub-read is date-windowed + company-scoped; no cross-table join', async () => {
    // Seed one in-window held lead so the plan has something to consider.
    await seedLead({ status: 'Review' });
    const plan = (await db.query(`EXPLAIN (FORMAT TEXT) ${HELD_LEAD_SQL}`, [COMPANY_A, Q_START, Q_END, TZ]))
        .rows.map(r => r['QUERY PLAN']).join('\n');

    // The read touches ONLY `leads` — no per-row join / correlated subplan.
    check(!/Nested Loop|Hash Join|Merge Join|SubPlan/.test(plan),
        `held-lead read must be join-free.\nPlan:\n${plan}`);
    const otherTable = (plan.match(/Scan on (\w+)/g) || []).filter(s => !/ on leads\b/.test(s));
    check(otherTable.length === 0, `read must scan ONLY leads, saw: ${otherTable.join(', ')}\nPlan:\n${plan}`);

    // idx_leads_lead_date_time exists and is usable at scale (with seqscan off the
    // planner picks a leads index — the small dev table otherwise prefers a Seq Scan,
    // which is correct and NOT a regression). No new index is added by this feature.
    const client = await db.pool.connect();
    let scaledPlan;
    try {
        await client.query('BEGIN');
        await client.query('SET LOCAL enable_seqscan = off'); // reverted by ROLLBACK
        scaledPlan = (await client.query(`EXPLAIN (FORMAT TEXT) ${HELD_LEAD_SQL}`, [COMPANY_A, Q_START, Q_END, TZ]))
            .rows.map(r => r['QUERY PLAN']).join('\n');
        await client.query('ROLLBACK');
    } finally {
        client.release();
    }
    const usesLeadsIndex = /Index (Only )?Scan[^\n]*on leads|Bitmap Index Scan on idx_leads/.test(scaledPlan);
    check(usesLeadsIndex,
        `with seqscan off the read should use a leads index (idx_leads_lead_date_time; proves no new index needed).\nPlan:\n${scaledPlan}`);

    const scanLine = (scaledPlan.split('\n').find(l => /Scan/.test(l)) || '').trim();
    record('VSE-EXPLAIN', 'PASS', `join-free leads-only scan; index-usable at scale (${scanLine})`);
});

// ── cfg — VSE-CFG (assistant JSON validated, NOT pushed) ─────────────────────
CASE('VSE-CFG', 'cfg', 'assistant JSON valid: 6 tools, recommendSlots shape + 8 params, prompt steps 6+9 rewritten', async () => {
    const fs = require('fs');
    const jsonPath = path.join(ROOT, 'voice-agent/assistants/lead-qualifier-v2.json');
    const raw = fs.readFileSync(jsonPath, 'utf8');
    let j;
    try { j = JSON.parse(raw); } catch (e) { throw new CheckError(`lead-qualifier-v2.json is not valid JSON: ${e.message}`); }

    const tools = j.model?.tools || [];
    eq(tools.length, 6, 'model.tools has exactly 6 tools');
    const rs = tools.find(t => t.function?.name === 'recommendSlots');
    check(rs, 'recommendSlots tool-def present');
    eq(rs.type, 'function', 'recommendSlots is a function tool');
    eq(rs.server?.url, 'https://api.albusto.com/api/vapi-tools', 'recommendSlots server.url matches the vapi-tools endpoint');
    eq(rs.server?.secret, 'REPLACE_WITH_VAPI_TOOLS_SECRET', 'recommendSlots server.secret is the repo placeholder (real secret injected at push)');
    const props = Object.keys(rs.function?.parameters?.properties || {}).sort();
    const expected = ['address', 'daysAhead', 'durationMinutes', 'excludeSlots', 'lat', 'lng', 'unitType', 'zip'].sort();
    eq(JSON.stringify(props), JSON.stringify(expected), 'recommendSlots has exactly the 8 documented params');
    eq(rs.function.parameters.properties.excludeSlots?.type, 'array', 'excludeSlots is an array param');

    // Scheduling prompt (system message) rewritten for steps 6 + 9.
    const sys = (j.model?.messages || []).find(m => m.role === 'system');
    const content = sys?.content || '';
    check(/recommendSlots/.test(content), 'scheduling prompt references recommendSlots (step 6)');
    check(/chosenSlot/.test(content), 'scheduling prompt references chosenSlot (step 9)');
    check(/excludeSlots/.test(content), 'scheduling prompt references excludeSlots (deeper mode)');

    record('VSE-CFG', 'PASS', `6 tools; recommendSlots shape+8 params; prompt 6/9 rewritten (NOT pushed to 30e85a87)`);
});

// ── sab — sabotage negative control ──────────────────────────────────────────
// Proves the harness actually reports FAIL when a real-state expectation is violated.
// We convert a held lead (so it truly drops), then assert the KNOWN-WRONG expectation
// that it is STILL present in occupancy — the detector MUST trip. If it doesn't, the
// state-inspection is a no-op and every green above is meaningless.
CASE('VSE-SABOTAGE', 'sab', 'negative control: asserting a converted lead is still present must FAIL', async () => {
    const held = await seedLead({ status: 'Review' });
    check((await occupancyEntryFor(held.id)) !== null, 'sabotage setup: lead is present before convert');
    await db.query(`UPDATE leads SET status = 'Converted' WHERE id = $1`, [held.id]);

    let threw = false;
    try {
        // Deliberately wrong: after convert the lead is GONE; asserting presence must throw.
        const entry = await occupancyEntryFor(held.id);
        check(entry !== null, `SABOTAGE EXPECTATION: converted lead:${held.id} should be present (this is intentionally wrong)`);
    } catch (e) {
        threw = e instanceof CheckError;
    }
    check(threw, 'SABOTAGE FAILED TO TRIP: the harness did not detect a converted-lead drop — the state check is broken');

    // Restore-assert: the true state (converted ⇒ absent) still holds green.
    check((await occupancyEntryFor(held.id)) === null, 'sabotage true state: converted lead is absent from occupancy');
    record('VSE-SABOTAGE', 'PASS', `wrong "still-present" expectation tripped a CheckError; true state re-asserted`);
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
    const selected = CASES.filter(c => sel === 'all' || c.id === sel || c.section === sel);
    if (selected.length === 0) {
        console.error(`No cases match "${sel}". Cases: ${CASES.map(c => c.id).join(', ')}; sections: ${[...new Set(CASES.map(c => c.section))].join(', ')}`);
        await db.pool.end();
        process.exit(2);
    }

    console.log(`VAPI-SLOT-ENGINE-001 verify — DATABASE_URL=${process.env.DATABASE_URL}`);
    console.log(`Company A=${COMPANY_A} (seed; real dev leads coexist → asserts are row-targeted by tagged lead id)`);
    console.log(`Window: ${WIN_DATE} ${WIN_START}–${WIN_END} ${TZ} (EDT) → ${WIN_ISO_START}..${WIN_ISO_END}`);
    console.log(`Selection: ${sel} → ${selected.length} case(s)\n`);

    await cleanupAll();

    for (const c of selected) {
        await cleanupAll();
        try {
            await c.fn();
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
    console.log(`P0 gates: VSE-INT-01 (occupancy) · VSE-INT-05 (persist) · VSE-U-01 (tz-combine) — red on any blocks release.`);

    await db.pool.end();
    process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
    console.error('FATAL:', e);
    try { await db.pool.end(); } catch { /* noop */ }
    process.exit(1);
});
