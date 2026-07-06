#!/usr/bin/env node
/**
 * CALLFLOW-BUSY-TO-AGENT-001 — G3 real-DB verification harness (the P0 GATE
 * before the owner-consented PROD data apply).
 *
 * Spec: docs/specs/CALLFLOW-BUSY-TO-AGENT-001.md (S7 + G3)
 * Test cases: docs/test-cases/CALLFLOW-BUSY-TO-AGENT-001.md (T-G3-01 … T-G3-07
 * plus the runtime half of T-G3-06). The PROD apply itself (T-G3-08) is NOT
 * performed here — it is a separate owner-consented step run by the operator.
 *
 * What this proves ON A REAL LOCAL POSTGRES (mocked jest alone does not prove
 * P0 — LIST-PAGINATION-001 lesson): the shipped apply script
 * (scripts/apply-callflow-busy-to-agent-001.js) driven as a REAL child process
 * against a REAL call_flows row carrying a byte-exact COPY of the prod graph
 * shape (the spec's 9-state/8-transition graph for cf-bbd3689d, after-hours
 * vapi pair in its editor-persisted collapsed-'Next' form — see the fixture
 * note in tests/callFlowBusyToAgentTransform.test.js).
 *
 * Cases (--section selects by id or section name):
 *   G3-01 dryrun     — default run prints WOULD-APPLY + 4 changes + diff; row
 *                      byte-unchanged (graph_json AND updated_at).
 *   G3-02 apply      — --apply → APPLIED; re-read: 10 states/10 transitions,
 *                      fallback repointed, 2 new vapi edges, config/provider
 *                      copied; bytes == JSON.stringify(transform output);
 *                      updated_at bumped (trigger) and the row is still the
 *                      ensureFlowForGroup selection; post-commit self-check ran.
 *   G3-03 noop       — second --apply → NOOP, graph byte-identical (fixed point
 *                      on the real DB), updated_at untouched.
 *   G3-04 sentinel   — another company's flow row + another group's flow row
 *                      (both seeded) byte-untouched across the WHOLE cycle
 *                      (dry-run → apply → noop → refused run); total call_flows
 *                      row count unchanged vs the post-seed baseline.
 *   G3-05 editor     — editor-loadable invariants on the applied graph: no
 *                      dangling transition endpoints, kinds within the
 *                      ENABLED_KINDS mirror, exactly one isInitial, the exact
 *                      visible-subgraph adjacency, every field of every state/
 *                      edge on the editor reactFlowToGraph serialization
 *                      whitelist, and the new vapi edge pair NOT collapsible by
 *                      collapseDuplicateVapiEdges (different targets + hidden
 *                      success edge). NOTE: the editor transform itself lives
 *                      inside frontend/src/pages/telephony/CallFlowBuilderPage.tsx
 *                      (TSX + React imports) and CANNOT be required from node —
 *                      so this case asserts the whitelist/invariants mirror
 *                      (CallFlowBuilderPage.tsx l.330–377 serialization set,
 *                      routes/callFlows.js ENABLED_KINDS) instead of importing.
 *   G3-06 durability — the REAL groupRouting.ensureFlowForGroup (unmocked, real
 *                      DB) returns the transformed row UNCHANGED: no skeleton
 *                      regeneration, no write, graph stays 10/10, row bytes and
 *                      updated_at identical after the call.
 *   G3-07 sabotage   — P0 controls: (a) fallback-edge token renamed
 *                      (queue.timeout→queue.timeoutX) → REFUSED exit 2 naming
 *                      P5, DB byte-unchanged; (b) vapi source node deleted →
 *                      REFUSED naming P4, byte-unchanged; (c) the harness's OWN
 *                      assertions inverted out-of-band MUST trip (non-vacuity
 *                      of the harness itself), then restored.
 *   G3-08 runtime    — runtime spot over the REAL DB row: the REAL (unmocked)
 *                      callFlowRuntime.startExecution with the flow returned by
 *                      the REAL ensureFlowForGroup; monkeypatched ONLY (T2-
 *                      mirror minimal mocks): groupRouting.availableAgentsForGroup
 *                      → [], groupRouting.isBusinessHours → true,
 *                      telephonyTenantService.getAutonomousMode → false, and the
 *                      realtimeService broadcast/publish recorders. Response is
 *                      <Sip> + answerOnBridge + vapiNode=1 — NOT the voicemail
 *                      announcement; execution row lands on n-vapi-bh-backup in
 *                      the REAL call_flow_executions table.
 *
 * Fixtures are self-seeded and tagged 'vfy1' (sentinel ids cf-/ug-vfy1-*,
 * executions call_sid LIKE 'CA-vfy1-%', the target group row tag-marked in its
 * description) so real dev rows coexist, re-runs are idempotent, and FK-ordered
 * cleanup (executions → flows → groups) removes everything the harness created.
 * The target ids themselves are the PROD ids (cf-bbd3689d / ug-2385d69d /
 * company …0001) — the local dev DB does NOT carry them naturally (T1 confirmed
 * the apply script REFUSES P1 there); this harness creates and removes them.
 *
 * SAFETY: this harness INSERTS/DELETES rows under prod ids — it must NEVER run
 * against prod. It hard-refuses any DATABASE_URL whose host is not
 * localhost/127.0.0.1/::1.
 *
 * Usage:
 *   node scripts/verify-callflow-busy-to-agent-001.js [--section=<id|section>|all]
 *   sections: dryrun apply noop sentinel editor durability sabotage runtime
 *   DATABASE_URL defaults to postgresql://localhost/twilio_calls (house local).
 * Exit code 0 only when no case FAILs.
 */
'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/twilio_calls';
// Distinct greeting markers make "the VM announcement" detectable in G3-08
// (buildVoicemailTwiml reads env at render time — same trick as the G2 suite).
process.env.VM_GREETING = 'VFY_BUSINESS_VM_MARKER';
process.env.VM_AFTER_HOURS_GREETING = 'VFY_AFTERHOURS_VM_MARKER';
// G3-08 needs the SIP target resolvable even on an empty vapi_tenant_resources
// table — the env fallback keeps the smoke deterministic (the assertion does
// NOT pin the URI, so a real local resource row winning the lookup is fine too).
process.env.VAPI_SIP_URI = process.env.VAPI_SIP_URI || 'sip:sara-verify@sip.vapi.ai';

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APPLY_SCRIPT = path.join(ROOT, 'scripts', 'apply-callflow-busy-to-agent-001.js');

// ─── Hard local-only guard (BEFORE any DB module loads) ──────────────────────
function assertLocalDatabaseUrl(rawUrl) {
    let host = null;
    try {
        host = new URL(rawUrl).hostname; // postgresql:// parses as a URL
    } catch (_e) {
        host = null;
    }
    const LOCAL_HOSTS = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]']);
    if (host === null || !LOCAL_HOSTS.has(host)) {
        console.error(`REFUSING TO RUN: DATABASE_URL host '${host}' is not local.`);
        console.error('This harness seeds AND DELETES rows under the PROD ids (cf-bbd3689d /');
        console.error('ug-2385d69d / company …0001) — it must only ever touch a local copy.');
        console.error('The prod apply is a separate owner-consented step (see docs/tasks.md T3).');
        process.exit(1);
    }
}
assertLocalDatabaseUrl(process.env.DATABASE_URL);

// ─── Real modules (db reads DATABASE_URL at load — env is already set) ───────
const db = require(path.join(ROOT, 'backend/src/db/connection'));
const { applyBusyToAgentTransform } = require(APPLY_SCRIPT);
const groupRouting = require(path.join(ROOT, 'backend/src/services/groupRouting'));
const callFlowRuntime = require(path.join(ROOT, 'backend/src/services/callFlowRuntime'));
const realtimeService = require(path.join(ROOT, 'backend/src/services/realtimeService'));
const telephonyTenantService = require(path.join(ROOT, 'backend/src/services/telephonyTenantService'));

// ─── Targets (the PROD ids — hardcoded in the apply script; mirrored here) ───
const COMPANY_A = '00000000-0000-0000-0000-000000000001';
const COMPANY_B = '00000000-0000-0000-0000-0000000000b3'; // sentinel-only; no FK on company_id
const FLOW_ID = 'cf-bbd3689d';
const GROUP_ID = 'ug-2385d69d';

const TAG = 'vfy1';
const TAG_MARKER = 'VFY1-CALLFLOW-BUSY-TO-AGENT-001-HARNESS';
const SENTINEL_FLOW_B = 'cf-vfy1-sent-b'; // other COMPANY's flow
const SENTINEL_FLOW_G = 'cf-vfy1-sent-g'; // same company, OTHER group's flow
const SENTINEL_GROUP_B = 'ug-vfy1-sent-b';
const SENTINEL_GROUP_G = 'ug-vfy1-sent-g';
const CALL_SID_PREFIX = 'CA-vfy1-';

// ─── The REAL prod graph shape (byte-exact copy of the G1/G2 fixture:
//     9 states / 8 transitions; after-hours vapi pair as the editor-persisted
//     collapsed 'Next' edge — the shape the transform expects and T1 pinned) ──
const PROD_GRAPH = {
    states: [
        { id: 'sk-start', name: 'Start', kind: 'start', isInitial: true, system: true, hidden: true },
        { id: 'sk-hours-check', name: 'Hours Check', kind: 'branch', system: true },
        { id: 'sk-current-group', name: 'Dispatch Team', kind: 'queue', system: true, groupRef: 'group.current', config: { queue_name: 'group_agents', timeout_sec: 120 } },
        { id: 'sk-vm-business-hours', name: 'Voicemail', kind: 'voicemail', system: true, config: { greeting: 'missed_call', branchKey: 'business_hours' } },
        { id: 'sk-vm-after-hours', name: 'Voicemail', kind: 'voicemail', system: true, config: { greeting: 'after_hours', branchKey: 'after_hours' } },
        { id: 'n-1780888101885', name: 'AI Greeting', kind: 'vapi_agent', provider: 'vapi', config: {} },
        { id: 'sk-done-routed', name: 'Done', kind: 'final', system: true, hidden: true },
        { id: 'sk-done-voicemail-business-hours', name: 'Done', kind: 'final', system: true, hidden: true },
        { id: 'sk-done-voicemail-after-hours', name: 'Done', kind: 'final', system: true, hidden: true },
    ],
    transitions: [
        { id: 'skt-entry', from_state_id: 'sk-start', to_state_id: 'sk-hours-check', edgeRole: 'entry', transitionMode: 'eventless' },
        { id: 'skt-bh', from_state_id: 'sk-hours-check', to_state_id: 'sk-current-group', label: 'Business Hours', branchKey: 'business_hours', transitionMode: 'conditional', condExpr: 'isBusinessHours === true' },
        { id: 'skt-ah', from_state_id: 'sk-hours-check', to_state_id: 'n-1780888101885', label: 'After Hours', branchKey: 'after_hours', transitionMode: 'conditional', condExpr: 'isBusinessHours === false' },
        { id: 'skt-fallback', from_state_id: 'sk-current-group', to_state_id: 'sk-vm-business-hours', label: 'Not answered / timeout', edgeRole: 'fallback', transitionMode: 'event', event_key: 'queue.timeout queue.not_answered queue.failed' },
        { id: 'skt-success', from_state_id: 'sk-current-group', to_state_id: 'sk-done-routed', edgeRole: 'success', transitionMode: 'event', event_key: 'queue.connected call.handoff', hidden: true },
        { id: 'e-1780888101886', from_state_id: 'n-1780888101885', to_state_id: 'sk-vm-after-hours', label: 'Next', edgeLabel: 'Next', edgeRole: 'next', transitionMode: 'event', event_key: 'vapi.completed vapi.no_target vapi.failed vapi.timeout', insertable: true, insertMode: 'between' },
        { id: 'skt-vm-bh-done', from_state_id: 'sk-vm-business-hours', to_state_id: 'sk-done-voicemail-business-hours', edgeRole: 'completion', transitionMode: 'event', event_key: 'voicemail.recorded voicemail.completed' },
        { id: 'skt-vm-ah-done', from_state_id: 'sk-vm-after-hours', to_state_id: 'sk-done-voicemail-after-hours', edgeRole: 'completion', transitionMode: 'event', event_key: 'voicemail.recorded voicemail.completed' },
    ],
};
const PROD_GRAPH_RAW = JSON.stringify(PROD_GRAPH);

// Distinctive sentinel graphs — any byte movement is detectable.
const SENTINEL_GRAPH_B_RAW = JSON.stringify({
    states: [{ id: 's-b', name: 'VFY1-SENTINEL-B-DO-NOT-TOUCH', kind: 'start', isInitial: true }],
    transitions: [],
});
const SENTINEL_GRAPH_G_RAW = JSON.stringify({
    states: [{ id: 's-g', name: 'VFY1-SENTINEL-G-DO-NOT-TOUCH', kind: 'start', isInitial: true }],
    transitions: [],
});

// ─── Editor mirrors (frontend TSX is not requireable from node — see header) ──
// reactFlowToGraph serialization whitelist — CallFlowBuilderPage.tsx l.330–377.
const EDITOR_STATE_WHITELIST = new Set(['id', 'name', 'kind', 'isInitial', 'protected', 'system', 'immutable', 'uiTerminal', 'hidden', 'labelExpr', 'groupRef', 'provider', 'configRef', 'config']);
const EDITOR_EDGE_WHITELIST = new Set(['id', 'from_state_id', 'to_state_id', 'event_key', 'label', 'system', 'immutable', 'deletable', 'hidden', 'insertable', 'insertMode', 'edgeLabel', 'branchKey', 'edgeRole', 'transitionMode', 'condExpr']);
// routes/callFlows.js ENABLED_KINDS (validateGraph) mirror.
const ENABLED_KINDS = new Set(['start', 'greeting', 'queue', 'branch', 'transfer', 'voicemail', 'hangup', 'play_audio', 'vapi_agent', 'final']);

// ─── tiny assert/report kit (mirrors scripts/verify-agent-skills-002.js) ─────
class CheckError extends Error {}
function check(cond, msg) { if (!cond) throw new CheckError(msg); }
function eq(actual, expected, label) { check(String(actual) === String(expected), `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
const results = [];
function record(id, status, note) {
    results.push({ id, status, note: note || '' });
    const pad = ' '.repeat(Math.max(1, 10 - id.length));
    console.log(`${status} ${id}${pad}${note || ''}`);
}
/** Non-vacuous sabotage helper: true only if a CheckError actually tripped. */
async function sabotageTrips(body) {
    try { await body(); return false; } catch (e) { return e instanceof CheckError; }
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function tokenSet(eventKey) { return new Set(String(eventKey || '').split(/\s+/).filter(Boolean)); }
function tokenSetEquals(eventKey, expected) {
    const s = tokenSet(eventKey);
    return s.size === expected.length && expected.every((t) => s.has(t));
}

// ─── DB helpers (row-targeted) ─────────────────────────────────────────────────
async function readFlowRow(flowId) {
    const { rows } = await db.query(
        `SELECT id, company_id, group_id, name, status, graph_json,
                updated_at, updated_at::text AS updated_at_text
         FROM call_flows WHERE id = $1`,
        [flowId],
    );
    return rows[0] || null;
}

async function updatedAtBumped(flowId, beforeText) {
    const { rows } = await db.query(
        `SELECT (updated_at > $2::timestamptz) AS bumped FROM call_flows WHERE id = $1`,
        [flowId, beforeText],
    );
    return rows[0] ? rows[0].bumped === true : false;
}

async function totalFlowCount() {
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM call_flows`);
    return rows[0].n;
}

async function ensureFlowSelectionId() {
    const { rows } = await db.query(
        `SELECT id FROM call_flows WHERE group_id = $1 AND company_id = $2
         ORDER BY updated_at DESC LIMIT 1`,
        [GROUP_ID, COMPANY_A],
    );
    return rows[0] ? String(rows[0].id) : null;
}

// ─── seed / cleanup (FK order: executions → flows → groups) ───────────────────
async function cleanupAll() {
    await db.query(`DELETE FROM call_flow_executions WHERE call_sid LIKE $1`, [`${CALL_SID_PREFIX}%`]);
    await db.query(`DELETE FROM call_flows WHERE id IN ($1, $2, $3)`, [FLOW_ID, SENTINEL_FLOW_B, SENTINEL_FLOW_G]);
    await db.query(`DELETE FROM user_groups WHERE id IN ($1, $2)`, [SENTINEL_GROUP_B, SENTINEL_GROUP_G]);
    // The prod group id is only deleted when THIS harness created it (tag-marked
    // description) — a real dev row with the same id would be left alone.
    await db.query(`DELETE FROM user_groups WHERE id = $1 AND description = $2`, [GROUP_ID, TAG_MARKER]);
}

/** Seeds the UN-applied prod-shape target row + both isolation sentinels. */
let harnessSeededThisProcess = false;
async function seedFresh() {
    const preExisting = await readFlowRow(FLOW_ID);
    if (preExisting && !harnessSeededThisProcess) {
        // Only a row we did NOT plant ourselves is worth flagging (prod-dump copy).
        console.log(`  (note: pre-existing row '${FLOW_ID}' found — replacing it for this run; prod-dump-copy mode)`);
    }
    harnessSeededThisProcess = true;
    await cleanupAll();
    // FK targets first. The prod group id may already exist on a prod-dump copy —
    // insert only if absent, tag-marked so cleanup removes only OUR row.
    await db.query(
        `INSERT INTO user_groups (id, company_id, name, description, strategy)
         VALUES ($1, $2, 'Dispatch Team', $3, 'Simultaneous')
         ON CONFLICT (id) DO NOTHING`,
        [GROUP_ID, COMPANY_A, TAG_MARKER],
    );
    await db.query(
        `INSERT INTO user_groups (id, company_id, name, description, strategy)
         VALUES ($1, $2, 'VFY1 Sentinel Group B', $3, 'Simultaneous'),
                ($4, $5, 'VFY1 Sentinel Group G', $3, 'Simultaneous')`,
        [SENTINEL_GROUP_B, COMPANY_B, TAG_MARKER, SENTINEL_GROUP_G, COMPANY_A],
    );
    await db.query(
        `INSERT INTO call_flows (id, company_id, group_id, name, status, graph_json)
         VALUES ($1, $2, $3, 'Dispatch Team Flow', 'active', $4)`,
        [FLOW_ID, COMPANY_A, GROUP_ID, PROD_GRAPH_RAW],
    );
    await db.query(
        `INSERT INTO call_flows (id, company_id, group_id, name, status, graph_json)
         VALUES ($1, $2, $3, 'VFY1 Sentinel Flow B', 'active', $4),
                ($5, $6, $7, 'VFY1 Sentinel Flow G', 'active', $8)`,
        [SENTINEL_FLOW_B, COMPANY_B, SENTINEL_GROUP_B, SENTINEL_GRAPH_B_RAW,
            SENTINEL_FLOW_G, COMPANY_A, SENTINEL_GROUP_G, SENTINEL_GRAPH_G_RAW],
    );
}

/** Runs the REAL apply CLI as a child process. Returns { status, stdout, stderr }. */
function runCli(args = []) {
    const res = spawnSync(process.execPath, [APPLY_SCRIPT, ...args], {
        env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
    });
    return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

/** seedFresh + a real `--apply` through the CLI (the artifact under test). */
async function seedApplied() {
    await seedFresh();
    const run = runCli(['--apply']);
    check(run.status === 0 && run.stdout.includes('VERDICT: APPLIED'),
        `seedApplied: CLI --apply must succeed (exit ${run.status}); stdout tail: ${run.stdout.slice(-400)}; stderr: ${run.stderr.slice(-400)}`);
    return run;
}

// ═════════════════════════════════════════════════════════════════════════════
// Cases
// ═════════════════════════════════════════════════════════════════════════════
const CASES = [];
function CASE(id, section, title, fn) { CASES.push({ id, section, title, fn }); }

// ── G3-01 (T-G3-01) — dry-run is read-only ────────────────────────────────────
CASE('G3-01', 'dryrun', 'dry-run (default) → WOULD-APPLY, prints 4 changes + diff; row byte-unchanged', async () => {
    await seedFresh();
    const before = await readFlowRow(FLOW_ID);
    eq(before.graph_json, PROD_GRAPH_RAW, 'seeded target row carries the exact prod-shape bytes');

    const run = runCli([]); // no flags = dry-run default
    eq(run.status, 0, 'dry-run exit code');
    check(run.stdout.includes('VERDICT: WOULD-APPLY'), `dry-run verdict is WOULD-APPLY; got tail: ${run.stdout.slice(-300)}`);
    check(run.stdout.includes('DRY-RUN (default'), 'mode line names DRY-RUN');
    check(run.stdout.includes('Changes (4):'), 'prints exactly 4 changes');
    check(/1\. add-state n-vapi-bh-backup /.test(run.stdout), 'change 1 = add-state n-vapi-bh-backup');
    check(/2\. repoint-fallback /.test(run.stdout) && run.stdout.includes("'sk-vm-business-hours' -> 'n-vapi-bh-backup'"), 'change 2 = repoint-fallback to n-vapi-bh-backup');
    check(/3\. add-edge t-vapi-bh-backup-success/.test(run.stdout), 'change 3 = add-edge success');
    check(/4\. add-edge t-vapi-bh-backup-fallback/.test(run.stdout), 'change 4 = add-edge fallback');
    check(run.stdout.includes('BEFORE graph_json'), 'prints the BEFORE payload (the rollback JSON)');
    check(run.stdout.includes(PROD_GRAPH_RAW), 'the BEFORE payload is the exact stored string');
    check(run.stdout.includes('@@ '), 'prints unified-diff hunks');
    check(/\n\+.*n-vapi-bh-backup/.test(run.stdout), 'diff has + lines introducing the backup node');

    const after = await readFlowRow(FLOW_ID);
    eq(after.graph_json, before.graph_json, 'graph_json byte-identical after dry-run (nothing written)');
    eq(after.updated_at_text, before.updated_at_text, 'updated_at untouched after dry-run');

    record('G3-01', 'PASS', 'WOULD-APPLY + 4 changes + diff printed; row bytes and updated_at unchanged');
});

// ── G3-02 (T-G3-02) — --apply writes exactly the delta ────────────────────────
CASE('G3-02', 'apply', '--apply → APPLIED; 10/10 graph, fallback repointed, 2 new edges, config copied; updated_at bumped; self-check ran', async () => {
    await seedFresh();
    const before = await readFlowRow(FLOW_ID);

    const run = runCli(['--apply']);
    eq(run.status, 0, 'apply exit code');
    check(run.stdout.includes('VERDICT: APPLIED'), `apply verdict; got tail: ${run.stdout.slice(-300)}`);
    check(run.stdout.includes('Post-write self-check: re-read graph NOOPs — OK.'), 'post-commit self-check passed');
    check(run.stdout.includes('Applied: 1 row updated'), 'exactly 1 row updated');

    const after = await readFlowRow(FLOW_ID);
    // Byte-exact: the CLI writes JSON.stringify(transform(parse(before)).graph).
    const expectedRaw = JSON.stringify(applyBusyToAgentTransform(JSON.parse(before.graph_json)).graph);
    eq(after.graph_json, expectedRaw, 'stored bytes == JSON.stringify of the transform output (no driver/trigger mangling)');

    const graph = JSON.parse(after.graph_json);
    eq(graph.states.length, 10, '10 states');
    eq(graph.transitions.length, 10, '10 transitions');

    // Fallback edge structurally repointed; every other field byte-identical.
    const beforeFallback = PROD_GRAPH.transitions.find((t) => t.id === 'skt-fallback');
    const fallback = graph.transitions.find((t) => t.from_state_id === 'sk-current-group' && tokenSetEquals(t.event_key, ['queue.timeout', 'queue.not_answered', 'queue.failed']));
    check(fallback, 'the queue failure edge exists');
    eq(fallback.to_state_id, 'n-vapi-bh-backup', 'fallback edge repointed to n-vapi-bh-backup');
    const stripTo = ({ to_state_id: _x, ...rest }) => rest;
    eq(JSON.stringify(stripTo(fallback)), JSON.stringify(stripTo(beforeFallback)), 'every other fallback-edge field byte-identical');

    // New state with config/provider deep-copied from the source vapi node.
    const backup = graph.states.find((s) => s.id === 'n-vapi-bh-backup');
    check(backup, 'n-vapi-bh-backup state present');
    eq(backup.kind, 'vapi_agent', 'backup kind');
    eq(backup.name, 'AI Backup', 'backup name');
    const source = graph.states.find((s) => s.id === 'n-1780888101885');
    eq(JSON.stringify(backup.config), JSON.stringify(source.config), 'config deep-copied from n-1780888101885');
    eq(JSON.stringify(backup.provider), JSON.stringify(source.provider), 'provider copied from n-1780888101885');

    // Both new edges present with the spec wiring.
    const success = graph.transitions.find((t) => t.id === 't-vapi-bh-backup-success');
    check(success && success.from_state_id === 'n-vapi-bh-backup' && success.to_state_id === 'sk-done-routed'
        && success.hidden === true && tokenSetEquals(success.event_key, ['vapi.completed']),
    `t-vapi-bh-backup-success wired as specced (got ${JSON.stringify(success)})`);
    const fb = graph.transitions.find((t) => t.id === 't-vapi-bh-backup-fallback');
    check(fb && fb.from_state_id === 'n-vapi-bh-backup' && fb.to_state_id === 'sk-vm-business-hours'
        && fb.label === 'AI unavailable / failed' && tokenSetEquals(fb.event_key, ['vapi.no_target', 'vapi.failed', 'vapi.timeout']),
    `t-vapi-bh-backup-fallback wired as specced (got ${JSON.stringify(fb)})`);

    // updated_at bumped by the trigger, and the row is still the runtime selection.
    check(await updatedAtBumped(FLOW_ID, before.updated_at_text), `updated_at bumped (before ${before.updated_at_text}, after ${after.updated_at_text})`);
    eq(await ensureFlowSelectionId(), FLOW_ID, 'row is still the max-updated_at ensureFlowForGroup selection');

    record('G3-02', 'PASS', `APPLIED; 10/10, repointed + 2 edges + config copy byte-verified; updated_at ${before.updated_at_text} -> ${after.updated_at_text}`);
});

// ── G3-03 (T-G3-03) — second --apply is a byte-identical NOOP ─────────────────
CASE('G3-03', 'noop', 'second --apply → NOOP; graph byte-identical (fixed point on the real DB)', async () => {
    await seedApplied();
    const afterFirst = await readFlowRow(FLOW_ID);

    const run = runCli(['--apply']);
    eq(run.status, 0, 'noop exit code');
    check(run.stdout.includes('VERDICT: NOOP (nothing written)'), `second apply verdict is NOOP; got tail: ${run.stdout.slice(-300)}`);
    check(run.stdout.includes('idempotent fixed point'), 'noop message names the fixed point');

    const afterSecond = await readFlowRow(FLOW_ID);
    eq(afterSecond.graph_json, afterFirst.graph_json, 'graph_json byte-identical after the NOOP re-run');
    eq(afterSecond.updated_at_text, afterFirst.updated_at_text, 'updated_at untouched by the NOOP (no write happened at all)');

    record('G3-03', 'PASS', 'NOOP verdict; bytes and updated_at identical to post-apply state');
});

// ── G3-04 (T-G3-04) — tenant/row isolation sentinels across the whole cycle ──
CASE('G3-04', 'sentinel', "other-company and other-group sentinel rows byte-untouched by the whole cycle (dry-run/apply/noop/refuse)", async () => {
    await seedFresh();
    const baseB = await readFlowRow(SENTINEL_FLOW_B);
    const baseG = await readFlowRow(SENTINEL_FLOW_G);
    eq(baseB.graph_json, SENTINEL_GRAPH_B_RAW, 'sentinel B seeded bytes');
    eq(baseG.graph_json, SENTINEL_GRAPH_G_RAW, 'sentinel G seeded bytes');
    const baseCount = await totalFlowCount();

    // The whole cycle: dry-run → apply → noop → a REFUSED run on drifted data.
    eq(runCli([]).status, 0, 'cycle: dry-run exit');
    eq(runCli(['--apply']).status, 0, 'cycle: apply exit');
    eq(runCli(['--apply']).status, 0, 'cycle: noop exit');
    // Drift the TARGET back to a corrupted fresh shape → the CLI must refuse.
    const corrupted = clone(PROD_GRAPH);
    corrupted.transitions.find((t) => t.id === 'skt-fallback').event_key = 'queue.timeoutX queue.not_answered queue.failed';
    await db.query(`UPDATE call_flows SET graph_json = $1 WHERE id = $2 AND company_id = $3`, [JSON.stringify(corrupted), FLOW_ID, COMPANY_A]);
    eq(runCli(['--apply']).status, 2, 'cycle: refused run exit');

    const afterB = await readFlowRow(SENTINEL_FLOW_B);
    const afterG = await readFlowRow(SENTINEL_FLOW_G);
    eq(afterB.graph_json, baseB.graph_json, "other COMPANY's flow graph byte-identical across the cycle");
    eq(afterB.updated_at_text, baseB.updated_at_text, "other COMPANY's flow updated_at untouched");
    eq(afterB.status, 'active', "other COMPANY's flow status untouched");
    eq(afterG.graph_json, baseG.graph_json, "other GROUP's flow graph byte-identical across the cycle");
    eq(afterG.updated_at_text, baseG.updated_at_text, "other GROUP's flow updated_at untouched");
    eq(await totalFlowCount(), baseCount, 'total call_flows row count unchanged (no rows created/deleted)');

    record('G3-04', 'PASS', 'both sentinels byte-identical (graph_json + updated_at) through dry-run/apply/noop/refuse; row count stable');
});

// ── G3-05 (T-G3-05) — editor-loadable invariants on the applied graph ─────────
CASE('G3-05', 'editor', 'editor invariants: no dangling refs, kinds enabled, one isInitial, exact visible adjacency, whitelist fields, collapse-safe', async () => {
    await seedApplied();
    const row = await readFlowRow(FLOW_ID);
    const graph = JSON.parse(row.graph_json);

    // validateGraph mirror (routes/callFlows.js): dangling refs + enabled kinds.
    const stateIds = new Set(graph.states.map((s) => s.id));
    for (const t of graph.transitions) {
        check(stateIds.has(t.from_state_id), `transition '${t.id}' has dangling from_state_id '${t.from_state_id}'`);
        check(stateIds.has(t.to_state_id), `transition '${t.id}' has dangling to_state_id '${t.to_state_id}'`);
    }
    for (const s of graph.states) {
        check(ENABLED_KINDS.has(s.kind), `state '${s.id}' kind '${s.kind}' not in ENABLED_KINDS`);
    }
    const initials = graph.states.filter((s) => s.isInitial);
    eq(initials.length, 1, 'exactly one isInitial state');
    eq(initials[0].id, 'sk-start', 'the initial state is sk-start');

    // Editor serialization whitelist — EVERY field of EVERY state/edge must be
    // on the reactFlowToGraph set, or an editor save round-trip would drop it.
    for (const s of graph.states) {
        for (const key of Object.keys(s)) {
            check(EDITOR_STATE_WHITELIST.has(key), `state '${s.id}' field '${key}' is off the editor state whitelist`);
        }
    }
    for (const t of graph.transitions) {
        for (const key of Object.keys(t)) {
            check(EDITOR_EDGE_WHITELIST.has(key), `transition '${t.id}' field '${key}' is off the editor edge whitelist`);
        }
    }

    // Visible-subgraph adjacency exactly as S8 specs it (graphToReactFlow shows
    // non-hidden nodes; an edge renders only when it is non-hidden AND both
    // endpoints are non-hidden — hidden finals drop their incoming edges).
    const hiddenStates = new Set(graph.states.filter((s) => s.hidden).map((s) => s.id));
    const visibleNodeIds = graph.states.filter((s) => !s.hidden).map((s) => s.id).sort();
    eq(JSON.stringify(visibleNodeIds),
        JSON.stringify(['n-1780888101885', 'n-vapi-bh-backup', 'sk-current-group', 'sk-hours-check', 'sk-vm-after-hours', 'sk-vm-business-hours'].sort()),
        'visible nodes = Hours Check, Dispatch Team, AI Greeting, AI Backup, 2 voicemails');
    const visibleEdges = graph.transitions
        .filter((t) => !t.hidden && !hiddenStates.has(t.from_state_id) && !hiddenStates.has(t.to_state_id))
        .map((t) => `${t.from_state_id}->${t.to_state_id}:${t.label || t.edgeLabel || t.event_key}`)
        .sort();
    eq(JSON.stringify(visibleEdges), JSON.stringify([
        'n-1780888101885->sk-vm-after-hours:Next',
        'n-vapi-bh-backup->sk-vm-business-hours:AI unavailable / failed',
        'sk-current-group->n-vapi-bh-backup:Not answered / timeout',
        'sk-hours-check->n-1780888101885:After Hours',
        'sk-hours-check->sk-current-group:Business Hours',
    ].sort()), 'visible adjacency exactly = S8 picture (5 edges incl. queue->AI Backup and AI Backup->VM-BH)');

    // collapseDuplicateVapiEdges cannot merge the new pair: it groups NON-hidden
    // vapi-source edges by 'from->to'; the success edge is hidden AND the pair's
    // targets differ — assert both structural facts.
    const outOfBackup = graph.transitions.filter((t) => t.from_state_id === 'n-vapi-bh-backup');
    eq(outOfBackup.length, 2, 'exactly two edges out of n-vapi-bh-backup');
    const [e1, e2] = outOfBackup;
    check(e1.to_state_id !== e2.to_state_id, 'the two vapi edges have DIFFERENT targets (collapse group key differs)');
    check(outOfBackup.some((t) => t.hidden === true && t.edgeRole === 'success'), 'the success edge is hidden (skt-success convention; collapse skips hidden)');

    record('G3-05', 'PASS', 'validateGraph mirror + whitelist + exact visible adjacency + collapse-safety hold. NOTE: frontend transform (CallFlowBuilderPage.tsx TSX) is NOT requireable from node — whitelist/invariant mirror asserted instead, per the T3 contract');
});

// ── G3-06 (T-G3-06 first half) — REAL ensureFlowForGroup durability ───────────
CASE('G3-06', 'durability', 'REAL groupRouting.ensureFlowForGroup returns the transformed row unchanged (no regeneration, no write)', async () => {
    await seedApplied();
    const before = await readFlowRow(FLOW_ID);

    // The REAL service, REAL DB — exactly what every inbound call runs per-call.
    const flow = await groupRouting.ensureFlowForGroup({ id: GROUP_ID, name: 'Dispatch Team' }, COMPANY_A);

    eq(flow.id, FLOW_ID, 'ensureFlowForGroup selected the transformed row');
    eq(flow.status, 'active', 'flow returned active');
    eq(flow.graph.states.length, 10, 'returned graph has 10 states (customized, not the 8-state skeleton)');
    eq(flow.graph.transitions.length, 10, 'returned graph has 10 transitions');
    check(flow.graph.states.some((s) => s.id === 'n-vapi-bh-backup'), 'returned graph carries n-vapi-bh-backup');
    eq(JSON.stringify(flow.graph), JSON.stringify(JSON.parse(before.graph_json)), 'returned graph deep-equal to the stored row');

    const after = await readFlowRow(FLOW_ID);
    eq(after.graph_json, before.graph_json, 'row bytes untouched by ensureFlowForGroup (no skeleton overwrite)');
    eq(after.updated_at_text, before.updated_at_text, 'updated_at untouched (no write at all)');

    record('G3-06', 'PASS', 'real ensureFlowForGroup returned the 10/10 customized graph and wrote nothing');
});

// ── G3-07 (T-G3-07) — sabotage controls (script refusal + harness non-vacuity) ─
CASE('G3-07', 'sabotage', 'P0 sabotage: token-drift → REFUSED P5; deleted vapi node → REFUSED P4; DB byte-unchanged; harness assertions non-vacuous', async () => {
    // (a1) fallback-edge token renamed — the T-G3-07 drift — must refuse naming P5.
    await seedFresh();
    const driftA = clone(PROD_GRAPH);
    driftA.transitions.find((t) => t.id === 'skt-fallback').event_key = 'queue.timeoutX queue.not_answered queue.failed';
    const driftARaw = JSON.stringify(driftA);
    await db.query(`UPDATE call_flows SET graph_json = $1 WHERE id = $2 AND company_id = $3`, [driftARaw, FLOW_ID, COMPANY_A]);
    const beforeA = await readFlowRow(FLOW_ID);

    const runA = runCli(['--apply']);
    eq(runA.status, 2, 'token-drift run exits 2');
    check(runA.stderr.includes('VERDICT: REFUSED (nothing written)'), `token-drift verdict REFUSED; stderr tail: ${runA.stderr.slice(-300)}`);
    check(/P5/.test(runA.stderr), `refusal names P5 (the fallback-edge matcher); stderr: ${runA.stderr.slice(-300)}`);
    const afterA = await readFlowRow(FLOW_ID);
    eq(afterA.graph_json, beforeA.graph_json, 'DB bytes untouched by the P5 refusal');
    eq(afterA.updated_at_text, beforeA.updated_at_text, 'updated_at untouched by the P5 refusal');

    // (a2) source vapi node deleted — must refuse naming P4.
    await seedFresh();
    const driftB = clone(PROD_GRAPH);
    driftB.states = driftB.states.filter((s) => s.id !== 'n-1780888101885');
    driftB.transitions = driftB.transitions.filter((t) => t.from_state_id !== 'n-1780888101885' && t.to_state_id !== 'n-1780888101885');
    await db.query(`UPDATE call_flows SET graph_json = $1 WHERE id = $2 AND company_id = $3`, [JSON.stringify(driftB), FLOW_ID, COMPANY_A]);
    const beforeB = await readFlowRow(FLOW_ID);

    const runB = runCli(['--apply']);
    eq(runB.status, 2, 'deleted-vapi-node run exits 2');
    check(/P4/.test(runB.stderr), `refusal names P4 (anchor node missing); stderr: ${runB.stderr.slice(-300)}`);
    check(runB.stderr.includes("n-1780888101885"), 'refusal names the missing node');
    const afterB = await readFlowRow(FLOW_ID);
    eq(afterB.graph_json, beforeB.graph_json, 'DB bytes untouched by the P4 refusal');

    // (b) HARNESS non-vacuity: invert the two load-bearing assertions out-of-band —
    // each MUST trip a CheckError; if either "passes", this harness proves nothing.
    const trippedExit = await sabotageTrips(async () => {
        eq(runA.status, 0, 'SABOTAGE(inverted): refused run should exit 0 (intentionally wrong)');
    });
    check(trippedExit, 'SABOTAGE FAILED TO TRIP: the exit-code assertion is vacuous');
    const trippedBytes = await sabotageTrips(async () => {
        check(afterA.graph_json !== beforeA.graph_json, 'SABOTAGE(inverted): the graph should have changed on refusal (intentionally wrong)');
    });
    check(trippedBytes, 'SABOTAGE FAILED TO TRIP: the byte-compare assertion is vacuous');
    // restored: nothing to undo — the inversions were transient assertions.

    record('G3-07', 'PASS', 'P5 + P4 refusals live (exit 2, precise diagnostic, zero bytes written); harness assertions proven non-vacuous and restored');
});

// ── G3-08 (T-G3-06 runtime half) — runtime spot over the REAL DB row ──────────
CASE('G3-08', 'runtime', 'REAL startExecution over the REAL applied row (agents+broadcast mocked only) → <Sip> answerOnBridge, not voicemail', async () => {
    await seedApplied();

    // Minimal T2-mirror mocks — everything else (DB row, ensureFlowForGroup,
    // execution INSERT/UPDATE, SIP resolution query) is REAL:
    //   availableAgentsForGroup → []   (the scenario under test: nobody available)
    //   isBusinessHours → true         (pin the business-hours branch)
    //   getAutonomousMode → false      (a dev DB with autonomous ON must not skew the path)
    //   realtime broadcast/publish     (recorders — no SSE side effects)
    const saved = {
        avail: groupRouting.availableAgentsForGroup,
        hours: groupRouting.isBusinessHours,
        auto: telephonyTenantService.getAutonomousMode,
        broadcast: realtimeService.broadcast,
        publish: realtimeService.publishCallUpdate,
    };
    const broadcasts = [];
    groupRouting.availableAgentsForGroup = async () => [];
    groupRouting.isBusinessHours = async () => true;
    telephonyTenantService.getAutonomousMode = async () => false;
    realtimeService.broadcast = (event, payload) => { broadcasts.push({ event, payload }); };
    realtimeService.publishCallUpdate = () => {};

    const callSid = `${CALL_SID_PREFIX}${Date.now()}`;
    try {
        // The flow comes from the REAL DB row via the REAL selection query.
        const flow = await groupRouting.ensureFlowForGroup({ id: GROUP_ID, name: 'Dispatch Team' }, COMPANY_A);
        eq(flow.id, FLOW_ID, 'runtime smoke reads the transformed row');

        const twiml = await callFlowRuntime.startExecution({
            callSid,
            fromNumber: '+15551110000',
            toNumber: '+16175550100',
            group: { id: GROUP_ID, name: 'Dispatch Team', company_id: COMPANY_A },
            flow,
            baseUrl: 'https://verify.invalid',
            traceId: 'vfy1',
        });

        // The inbound response IS the Sara leg — never the voicemail announcement.
        check(twiml.includes('<Sip'), `response contains <Sip>; got: ${twiml.slice(0, 400)}`);
        check(twiml.includes('answerOnBridge="true"'), 'answerOnBridge preserved');
        check(twiml.includes('voice-dial-action?vapiNode=1'), 'dial action tagged vapiNode=1');
        check(twiml.includes('timeLimit="900"'), 'vapi leg wall-clock cap present');
        check(!twiml.includes('<Record'), 'no <Record> (not voicemail)');
        check(!twiml.includes('VFY_BUSINESS_VM_MARKER'), 'no business VM announcement');
        check(!twiml.includes('VFY_AFTERHOURS_VM_MARKER'), 'no after-hours VM announcement');
        check(!twiml.includes('<Client'), 'no client dial (zero agents)');

        // The execution row is REAL — parked at the backup node in the real table.
        const { rows } = await db.query(
            `SELECT current_node_id, status, flow_id FROM call_flow_executions WHERE call_sid = $1`,
            [callSid],
        );
        check(rows[0], 'real call_flow_executions row created');
        eq(rows[0].current_node_id, 'n-vapi-bh-backup', 'execution parked at n-vapi-bh-backup');
        eq(rows[0].status, 'active', 'execution active (awaiting the Sara dial result)');
        eq(rows[0].flow_id, FLOW_ID, 'execution bound to the transformed flow');

        // SSE contract unchanged: queued broadcast with the no-agents status.
        const queued = broadcasts.find((b) => b.event === 'group.call.queued');
        check(queued && queued.payload && queued.payload.status === 'no_available_agents',
            `group.call.queued fired with status no_available_agents (got ${JSON.stringify(queued && queued.payload)})`);
    } finally {
        groupRouting.availableAgentsForGroup = saved.avail;
        groupRouting.isBusinessHours = saved.hours;
        telephonyTenantService.getAutonomousMode = saved.auto;
        realtimeService.broadcast = saved.broadcast;
        realtimeService.publishCallUpdate = saved.publish;
        await db.query(`DELETE FROM call_flow_executions WHERE call_sid = $1`, [callSid]);
    }

    record('G3-08', 'PASS', 'real startExecution over the real row: <Sip> answerOnBridge vapiNode=1, no VM; execution row at n-vapi-bh-backup');
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
        console.error(`No cases match "${sel}". Cases: ${CASES.map((c) => c.id).join(', ')}; sections: ${CASES.map((c) => c.section).join(', ')}`);
        await db.pool.end();
        process.exit(2);
    }

    console.log(`CALLFLOW-BUSY-TO-AGENT-001 G3 verify — DATABASE_URL=${process.env.DATABASE_URL} (local-only guard passed)`);
    console.log(`Target row (seeded by this harness): call_flows id='${FLOW_ID}' company='${COMPANY_A}' group='${GROUP_ID}' — the prod graph SHAPE, not prod data`);
    console.log(`Sentinels: '${SENTINEL_FLOW_B}' (company ${COMPANY_B}) + '${SENTINEL_FLOW_G}' (other group, company A) — must stay byte-identical`);
    console.log(`Apply script under test: ${path.relative(ROOT, APPLY_SCRIPT)} (driven as a real child process)`);
    console.log(`Selection: ${sel} -> ${selected.length} case(s)\n`);

    await cleanupAll();
    for (const c of selected) {
        try {
            await c.fn();
            if (!results.some((r) => r.id === c.id)) record(c.id, 'PASS', c.title);
        } catch (e) {
            const note = `${c.title} — ${e instanceof CheckError ? e.message : (e.stack || e.message)}`;
            record(c.id, 'FAIL', note);
        }
    }
    await cleanupAll();

    const pass = results.filter((r) => r.status === 'PASS').length;
    const fail = results.filter((r) => r.status === 'FAIL').length;
    console.log(`\n══════════════════════════════════════════════`);
    console.log(`PASS ${pass} · FAIL ${fail} (of ${results.length})`);
    if (fail > 0) console.log(`FAILED: ${results.filter((r) => r.status === 'FAIL').map((r) => r.id).join(', ')}`);
    console.log(`G3 gates on a real Postgres row: dry-run read-only (G3-01) · apply delta byte-exact (G3-02) ·`);
    console.log(`NOOP fixed point (G3-03) · tenant/row sentinels (G3-04) · editor invariants (G3-05) ·`);
    console.log(`real ensureFlowForGroup durability (G3-06) · refusal sabotage P5/P4 + harness non-vacuity (G3-07) ·`);
    console.log(`real startExecution runtime spot (G3-08). A red on any BLOCKS the prod apply.`);

    await db.pool.end();
    process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
    console.error('FATAL:', e);
    try { await cleanupAll(); } catch { /* noop */ }
    try { await db.pool.end(); } catch { /* noop */ }
    process.exit(1);
});
