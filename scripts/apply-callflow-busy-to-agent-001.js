#!/usr/bin/env node
/**
 * CALLFLOW-BUSY-TO-AGENT-001 — business-hours queue exhaustion routes to Sara;
 * voicemail becomes the LAST resort. Data-only change to ONE prod call_flows row.
 *
 * Spec: docs/specs/CALLFLOW-BUSY-TO-AGENT-001.md
 * Test cases: docs/test-cases/CALLFLOW-BUSY-TO-AGENT-001.md (G1 unit suite:
 * tests/callFlowBusyToAgentTransform.test.js)
 *
 * The exact 4-change graph delta:
 *   1. ADD state 'n-vapi-bh-backup' ('AI Backup', kind vapi_agent; provider/config
 *      DEEP-COPIED from 'n-1780888101885' at transform time).
 *   2. REPOINT the ONE structurally-matched queue fallback edge
 *      (sk-current-group -> sk-vm-business-hours, event_key token-set
 *      {queue.timeout, queue.not_answered, queue.failed}) to 'n-vapi-bh-backup'.
 *      Every other field of that edge stays byte-identical.
 *   3. ADD transition 't-vapi-bh-backup-success' (hidden, vapi.completed -> sk-done-routed).
 *   4. ADD transition 't-vapi-bh-backup-fallback' ('AI unavailable / failed',
 *      vapi.no_target vapi.failed vapi.timeout -> sk-vm-business-hours).
 *
 * Every written field is on the flow editor's reactFlowToGraph serialization
 * whitelist (frontend/src/pages/telephony/CallFlowBuilderPage.tsx l.330-377), so
 * the delta survives an editor save round-trip. No coordinates (ELK auto-layout).
 *
 * Usage:
 *   node scripts/apply-callflow-busy-to-agent-001.js            # DRY-RUN (default): prints
 *                                                               # matched row, change list,
 *                                                               # before/after diff, verdict.
 *                                                               # Writes NOTHING.
 *   node scripts/apply-callflow-busy-to-agent-001.js --apply    # transactional write
 *                                                               # (SELECT ... FOR UPDATE)
 *
 *   env DATABASE_URL — defaults to house-local postgresql://localhost/twilio_calls.
 *   NEVER defaults to prod; prod apply = explicit URL + owner consent (T3).
 *
 * Exit codes: 0 = success (WOULD-APPLY / APPLIED / NOOP) · 2 = REFUSED (a
 * precondition P1–P6 is violated; nothing written) · 1 = operational error
 * (DB unreachable, bad invocation, post-commit self-check failure).
 *
 * Idempotent: a second run detects the applied shape and NOOPs (no write).
 * REFUSES (exit 2) on any drift or partial application — never auto-heals.
 */
'use strict';

// ─── Hardcoded targets — multi-tenant safety: NO override flags ──────────────
const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const FLOW_ID = 'cf-bbd3689d';
const GROUP_ID = 'ug-2385d69d';
const DEFAULT_DATABASE_URL = 'postgresql://localhost/twilio_calls';

// Existing graph anchors (expected prod shape — refuse on drift)
const QUEUE_NODE_ID = 'sk-current-group';        // kind: queue ('Dispatch Team')
const VM_BH_NODE_ID = 'sk-vm-business-hours';    // kind: voicemail (branchKey business_hours)
const DONE_ROUTED_NODE_ID = 'sk-done-routed';    // kind: final (hidden)
const SOURCE_VAPI_NODE_ID = 'n-1780888101885';   // kind: vapi_agent ('AI Greeting')

// New ids introduced by the delta
const NEW_STATE_ID = 'n-vapi-bh-backup';
const NEW_SUCCESS_EDGE_ID = 't-vapi-bh-backup-success';
const NEW_FALLBACK_EDGE_ID = 't-vapi-bh-backup-fallback';

const QUEUE_FAIL_TOKENS = ['queue.timeout', 'queue.not_answered', 'queue.failed'];
const VAPI_FAIL_TOKENS = ['vapi.no_target', 'vapi.failed', 'vapi.timeout'];

/** Typed refusal: a spec precondition (P1–P6) does not hold. Never a crash. */
class ShapeError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ShapeError';
    }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/** JSON-faithful deep clone (graphs are JSON.parsed data — no undefined/functions inside). */
function deepClone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Tokenizes event_key exactly like callFlowRuntime.eventMatches: split(/\s+/).filter(Boolean). */
function tokenSet(eventKey) {
    return new Set(String(eventKey || '').split(/\s+/).filter(Boolean));
}

/** Order-insensitive token-SET compare of an event_key against an expected token list. */
function tokenSetEquals(eventKey, expectedTokens) {
    const set = tokenSet(eventKey);
    return set.size === expectedTokens.length && expectedTokens.every((t) => set.has(t));
}

// ─── The pure transform (no DB, input never mutated) ─────────────────────────

/**
 * applyBusyToAgentTransform(graph)
 *   -> { status: 'applied', graph: newGraph, changes: string[] }  (fresh apply)
 *   -> { status: 'noop',    graph: clone }                        (already applied — fixed point)
 *   -> throws ShapeError(reason)                                  (P3–P6 violated; refuse, never heal)
 *
 * P3  graph is an object; states/transitions are arrays; states non-empty.
 * P4  anchor nodes present with expected kinds (queue / voicemail / final / vapi_agent).
 * P5  exactly ONE structurally-matched queue fallback edge (see matcher above).
 * P6  no partial application: the 4 delta artifacts are all absent (-> apply) or
 *     all present with expected wiring (-> noop); any mix -> refuse.
 */
function applyBusyToAgentTransform(graph) {
    // P3 — structural shape
    if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
        throw new ShapeError('P3: graph is not an object');
    }
    if (!Array.isArray(graph.states)) {
        throw new ShapeError(`P3: graph.states is not an array (got ${typeof graph.states})`);
    }
    if (graph.states.length === 0) {
        throw new ShapeError('P3: graph.states is empty');
    }
    if (!Array.isArray(graph.transitions)) {
        throw new ShapeError(`P3: graph.transitions is not an array (got ${typeof graph.transitions})`);
    }

    const states = graph.states;
    const transitions = graph.transitions;
    const findState = (id) => states.find((s) => s && s.id === id) || null;
    const findTransition = (id) => transitions.find((t) => t && t.id === id) || null;

    // ── P6 — application-state detection (all-or-nothing) ────────────────────
    const backupState = findState(NEW_STATE_ID);
    const successEdge = findTransition(NEW_SUCCESS_EDGE_ID);
    const fallbackEdge = findTransition(NEW_FALLBACK_EDGE_ID);
    // All queue-failure-shaped edges out of the queue node (order-insensitive token-SET match)
    const queueFailEdges = transitions.filter(
        (t) => t && t.from_state_id === QUEUE_NODE_ID && tokenSetEquals(t.event_key, QUEUE_FAIL_TOKENS)
    );
    const repointedEdges = queueFailEdges.filter((t) => t.to_state_id === NEW_STATE_ID);

    const artifacts = [
        [`state '${NEW_STATE_ID}'`, Boolean(backupState)],
        [`transition '${NEW_SUCCESS_EDGE_ID}'`, Boolean(successEdge)],
        [`transition '${NEW_FALLBACK_EDGE_ID}'`, Boolean(fallbackEdge)],
        [`queue fallback edge repointed to '${NEW_STATE_ID}'`, repointedEdges.length > 0],
    ];
    const present = artifacts.filter(([, p]) => p).map(([name]) => name);
    const missing = artifacts.filter(([, p]) => !p).map(([name]) => name);

    if (present.length === artifacts.length) {
        // Applied shape detected — verify the expected wiring, then NOOP.
        const problems = [];
        if (backupState.kind !== 'vapi_agent') {
            problems.push(`state '${NEW_STATE_ID}' has kind='${backupState.kind}', expected 'vapi_agent'`);
        }
        if (queueFailEdges.length !== 1 || repointedEdges.length !== 1) {
            problems.push(
                `expected exactly ONE queue failure edge, repointed to '${NEW_STATE_ID}' — found ` +
                `${queueFailEdges.length} queue failure edge(s), ${repointedEdges.length} repointed`
            );
        }
        if (
            successEdge.from_state_id !== NEW_STATE_ID ||
            successEdge.to_state_id !== DONE_ROUTED_NODE_ID ||
            !tokenSetEquals(successEdge.event_key, ['vapi.completed'])
        ) {
            problems.push(
                `transition '${NEW_SUCCESS_EDGE_ID}' wiring is not ${NEW_STATE_ID} -> ${DONE_ROUTED_NODE_ID} ` +
                `on 'vapi.completed' (got ${successEdge.from_state_id} -> ${successEdge.to_state_id} on '${successEdge.event_key}')`
            );
        }
        if (
            fallbackEdge.from_state_id !== NEW_STATE_ID ||
            fallbackEdge.to_state_id !== VM_BH_NODE_ID ||
            !tokenSetEquals(fallbackEdge.event_key, VAPI_FAIL_TOKENS)
        ) {
            problems.push(
                `transition '${NEW_FALLBACK_EDGE_ID}' wiring is not ${NEW_STATE_ID} -> ${VM_BH_NODE_ID} ` +
                `on '${VAPI_FAIL_TOKENS.join(' ')}' (got ${fallbackEdge.from_state_id} -> ${fallbackEdge.to_state_id} on '${fallbackEdge.event_key}')`
            );
        }
        if (problems.length > 0) {
            throw new ShapeError(`P6: applied-shape artifacts all present but wiring is unexpected — ${problems.join('; ')}`);
        }
        return { status: 'noop', graph: deepClone(graph) };
    }

    if (present.length > 0) {
        // Any mix of applied/unapplied artifacts = partial application. Never auto-heal.
        throw new ShapeError(
            `P6: partial application detected — present: [${present.join(', ')}]; ` +
            `missing: [${missing.join(', ')}]. Refusing (this script never auto-heals a partial state).`
        );
    }

    // ── Fresh apply path ──────────────────────────────────────────────────────
    // P4 — anchor nodes present with expected kinds
    const expectedNodes = [
        [QUEUE_NODE_ID, 'queue'],
        [VM_BH_NODE_ID, 'voicemail'],
        [DONE_ROUTED_NODE_ID, 'final'],
        [SOURCE_VAPI_NODE_ID, 'vapi_agent'],
    ];
    for (const [nodeId, expectedKind] of expectedNodes) {
        const node = findState(nodeId);
        if (!node) {
            throw new ShapeError(`P4: expected node '${nodeId}' (kind '${expectedKind}') is missing from graph.states`);
        }
        if (node.kind !== expectedKind) {
            throw new ShapeError(`P4: node '${nodeId}' has kind='${node.kind}', expected '${expectedKind}'`);
        }
    }

    // P5 — exactly ONE structurally-matched fallback edge:
    // from sk-current-group ∧ to sk-vm-business-hours ∧ token-set == QUEUE_FAIL_TOKENS
    const matches = queueFailEdges.filter((t) => t.to_state_id === VM_BH_NODE_ID);
    if (matches.length === 0) {
        throw new ShapeError(
            `P5: no queue fallback edge matches (from='${QUEUE_NODE_ID}', to='${VM_BH_NODE_ID}', ` +
            `event_key token-set {${QUEUE_FAIL_TOKENS.join(', ')}}) — found ${queueFailEdges.length} ` +
            `queue-failure-shaped edge(s) with target(s) [${queueFailEdges.map((t) => `'${t.to_state_id}'`).join(', ')}]`
        );
    }
    if (matches.length > 1) {
        throw new ShapeError(
            `P5: expected exactly ONE matching queue fallback edge, found ${matches.length} ` +
            `(ids: ${matches.map((t) => `'${t.id}'`).join(', ')})`
        );
    }
    const matchedIndex = transitions.indexOf(matches[0]);
    const matchedEdgeRef = matches[0].id != null ? `'${matches[0].id}'` : `transitions[${matchedIndex}]`;

    // ── Build the new graph (input untouched) ─────────────────────────────────
    const next = deepClone(graph);

    // 1. ADD state — provider/config DEEP-COPIED from the existing vapi node at
    // transform time. Fields: editor state whitelist only (id,name,kind,provider,config).
    const sourceNode = next.states.find((s) => s && s.id === SOURCE_VAPI_NODE_ID);
    const newState = {
        id: NEW_STATE_ID,
        name: 'AI Backup',
        kind: 'vapi_agent',
        provider: deepClone(sourceNode.provider),
        config: deepClone(sourceNode.config),
    };
    if (newState.provider === undefined) delete newState.provider;
    if (newState.config === undefined) delete newState.config;
    next.states.push(newState);

    // 2. REPOINT the matched fallback edge — the ONLY change to an existing object.
    next.transitions[matchedIndex].to_state_id = NEW_STATE_ID;

    // 3.+4. ADD transitions — exactly the spec objects (editor transition whitelist only).
    next.transitions.push({
        id: NEW_SUCCESS_EDGE_ID,
        from_state_id: NEW_STATE_ID,
        to_state_id: DONE_ROUTED_NODE_ID,
        hidden: true,
        edgeRole: 'success',
        transitionMode: 'event',
        event_key: 'vapi.completed',
    });
    next.transitions.push({
        id: NEW_FALLBACK_EDGE_ID,
        from_state_id: NEW_STATE_ID,
        to_state_id: VM_BH_NODE_ID,
        label: 'AI unavailable / failed',
        edgeLabel: 'AI unavailable / failed',
        edgeRole: 'fallback',
        insertable: true,
        insertMode: 'between',
        transitionMode: 'event',
        event_key: 'vapi.no_target vapi.failed vapi.timeout',
    });

    const changes = [
        `add-state ${NEW_STATE_ID} ('AI Backup', kind=vapi_agent; provider/config deep-copied from ${SOURCE_VAPI_NODE_ID})`,
        `repoint-fallback ${matchedEdgeRef}: to_state_id '${VM_BH_NODE_ID}' -> '${NEW_STATE_ID}' (all other fields untouched)`,
        `add-edge ${NEW_SUCCESS_EDGE_ID}: ${NEW_STATE_ID} -> ${DONE_ROUTED_NODE_ID} (hidden success, event_key 'vapi.completed')`,
        `add-edge ${NEW_FALLBACK_EDGE_ID}: ${NEW_STATE_ID} -> ${VM_BH_NODE_ID} ('AI unavailable / failed', event_key '${VAPI_FAIL_TOKENS.join(' ')}')`,
    ];

    return { status: 'applied', graph: next, changes };
}

// Spec export surface (pure, unit-testable, no DB): module.exports = { applyBusyToAgentTransform }
module.exports = { applyBusyToAgentTransform };

// ─── CLI (require.main gate — nothing below runs on require()) ───────────────

/** Pretty-print for diffing. */
function pretty(graph) {
    return JSON.stringify(graph, null, 2);
}

/** Plain LCS line diff -> unified-style hunks with @@ headers. Graphs are small (~10² lines). */
function unifiedDiff(beforeText, afterText, context = 3) {
    const a = beforeText.split('\n');
    const b = afterText.split('\n');
    const n = a.length;
    const m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    // ops: [' '|'-'|'+', line, aLineNo|null, bLineNo|null]
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) ops.push([' ', a[i], i + 1, j + 1]), i++, j++;
        else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(['-', a[i], i + 1, null]), i++;
        else ops.push(['+', b[j], null, j + 1]), j++;
    }
    while (i < n) ops.push(['-', a[i], i + 1, null]), i++;
    while (j < m) ops.push(['+', b[j], null, j + 1]), j++;

    const keep = new Array(ops.length).fill(false);
    ops.forEach((op, idx) => {
        if (op[0] === ' ') return;
        for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) keep[k] = true;
    });

    const out = [];
    let idx = 0;
    while (idx < ops.length) {
        if (!keep[idx]) {
            idx++;
            continue;
        }
        let end = idx;
        while (end < ops.length && keep[end]) end++;
        const hunk = ops.slice(idx, end);
        const aStart = hunk.find((o) => o[2] != null)?.[2] ?? 0;
        const bStart = hunk.find((o) => o[3] != null)?.[3] ?? 0;
        const aCount = hunk.filter((o) => o[2] != null).length;
        const bCount = hunk.filter((o) => o[3] != null).length;
        out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
        for (const [tag, line] of hunk) out.push(`${tag} ${line}`);
        idx = end;
    }
    return out.length > 0 ? out.join('\n') : '(no differences)';
}

/** P3 (parse half): the stored graph_json must parse. Column is TEXT (migration 040). */
function parseGraphJson(raw) {
    if (raw == null || raw === '') throw new ShapeError('P3: graph_json is empty');
    if (typeof raw === 'object') return raw; // defensive: jsonb-style driver decode
    try {
        return JSON.parse(raw);
    } catch (err) {
        throw new ShapeError(`P3: graph_json does not parse as JSON — ${err.message}`);
    }
}

/** P1: the target row exists with the expected company/group/status. */
async function fetchTargetRow(client, { forUpdate }) {
    const res = await client.query(
        `SELECT id, company_id, group_id, name, status, graph_json, updated_at
         FROM call_flows
         WHERE id = $1 AND company_id = $2${forUpdate ? '\n         FOR UPDATE' : ''}`,
        [FLOW_ID, COMPANY_ID]
    );
    if (res.rows.length === 0) {
        throw new ShapeError(`P1: call_flows row id='${FLOW_ID}' with company_id='${COMPANY_ID}' not found`);
    }
    const row = res.rows[0];
    if (String(row.group_id) !== GROUP_ID) {
        throw new ShapeError(`P1: flow '${FLOW_ID}' has group_id='${row.group_id}', expected '${GROUP_ID}'`);
    }
    if (String(row.status) !== 'active') {
        throw new ShapeError(`P1: flow '${FLOW_ID}' has status='${row.status}', expected 'active'`);
    }
    return row;
}

/**
 * P2: the target row must be the groupRouting.ensureFlowForGroup selection —
 * the max-updated_at row for (GROUP_ID, COMPANY_ID) (that query is
 * `ORDER BY updated_at DESC LIMIT 1`). An updated_at tie with another row would
 * make the runtime selection ambiguous -> refuse.
 */
async function assertEnsureFlowSelection(client) {
    const res = await client.query(
        `SELECT id, status, updated_at
         FROM call_flows
         WHERE group_id = $1 AND company_id = $2
         ORDER BY updated_at DESC, id ASC`,
        [GROUP_ID, COMPANY_ID]
    );
    const rows = res.rows;
    const newest = rows[0];
    if (!newest || String(newest.id) !== FLOW_ID) {
        throw new ShapeError(
            `P2: flow '${FLOW_ID}' is NOT the ensureFlowForGroup selection for ` +
            `(group='${GROUP_ID}', company='${COMPANY_ID}') — newest row by updated_at is ` +
            `'${newest ? newest.id : '<none>'}'${newest ? ` (status='${newest.status}', updated_at=${toIso(newest.updated_at)})` : ''}`
        );
    }
    const tie = rows.find(
        (r) => String(r.id) !== FLOW_ID && new Date(r.updated_at).getTime() === new Date(newest.updated_at).getTime()
    );
    if (tie) {
        throw new ShapeError(
            `P2: updated_at tie between '${FLOW_ID}' and '${tie.id}' (${toIso(newest.updated_at)}) — ` +
            `ensureFlowForGroup selection would be ambiguous; refusing`
        );
    }
}

function toIso(value) {
    return value instanceof Date ? value.toISOString() : String(value);
}

async function main() {
    const argv = process.argv.slice(2);
    const apply = argv.includes('--apply');
    const unknown = argv.filter((arg) => arg !== '--apply');
    if (unknown.length > 0) {
        // Multi-tenant safety: NO override flags — targets are hardcoded.
        console.error(`Unknown argument(s): ${unknown.join(' ')}`);
        console.error('Usage: node scripts/apply-callflow-busy-to-agent-001.js [--apply]');
        process.exitCode = 1;
        return;
    }

    const databaseUrl = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
    console.log('CALLFLOW-BUSY-TO-AGENT-001 — queue exhaustion -> AI Backup (Sara); voicemail last resort');
    console.log(`Mode:     ${apply ? 'APPLY (transactional write: SELECT ... FOR UPDATE)' : 'DRY-RUN (default — nothing will be written)'}`);
    console.log(`Database: ${databaseUrl}`);
    console.log(`Target:   call_flows id='${FLOW_ID}' company_id='${COMPANY_ID}' group_id='${GROUP_ID}'`);

    const { Client } = require('pg');
    const client = new Client({ connectionString: databaseUrl });
    try {
        await client.connect();
    } catch (err) {
        console.error(`\nERROR: database unreachable — ${err.message}`);
        process.exitCode = 1;
        return;
    }

    let inTransaction = false;
    try {
        if (apply) {
            await client.query('BEGIN');
            inTransaction = true;
        }

        const row = await fetchTargetRow(client, { forUpdate: apply });          // P1 (+ row lock in apply mode)
        console.log(`\nMatched row: ${JSON.stringify({ id: row.id, group_id: row.group_id, status: row.status, updated_at: toIso(row.updated_at) })}`);
        await assertEnsureFlowSelection(client);                                 // P2
        const beforeRaw = String(row.graph_json);
        const graph = parseGraphJson(row.graph_json);                            // P3 (parse)
        const result = applyBusyToAgentTransform(graph);                         // P3–P6 + delta

        if (result.status === 'noop') {
            if (inTransaction) {
                await client.query('ROLLBACK');
                inTransaction = false;
            }
            console.log('\nChanges: none — applied shape already present (idempotent fixed point). graph_json untouched.');
            console.log('\nVERDICT: NOOP (nothing written)');
            return; // exit 0
        }

        const afterRaw = JSON.stringify(result.graph);
        console.log(`\nChanges (${result.changes.length}):`);
        result.changes.forEach((change, idx) => console.log(`  ${idx + 1}. ${change}`));
        console.log('\nBEFORE graph_json (exact stored string — keep as the rollback payload):');
        console.log(beforeRaw);
        console.log('\nDiff (pretty-printed graph_json, before -> after):');
        console.log(unifiedDiff(pretty(graph), pretty(result.graph)));

        if (!apply) {
            console.log('\nVERDICT: WOULD-APPLY (dry-run — nothing written; re-run with --apply to write)');
            return; // exit 0
        }

        const upd = await client.query(
            `UPDATE call_flows SET graph_json = $1 WHERE id = $2 AND company_id = $3`,
            [afterRaw, FLOW_ID, COMPANY_ID]
        );
        if (upd.rowCount !== 1) {
            throw new Error(`UPDATE affected ${upd.rowCount} row(s), expected exactly 1 — rolling back`);
        }
        await client.query('COMMIT'); // trigger trg_call_flows_updated_at bumps updated_at
        inTransaction = false;

        // Post-write self-check (after commit, per spec): re-read and assert the transform now NOOPs.
        const reread = await client.query(
            `SELECT graph_json, updated_at FROM call_flows WHERE id = $1 AND company_id = $2`,
            [FLOW_ID, COMPANY_ID]
        );
        let selfCheckFailure = null;
        let rereadRaw = null;
        try {
            rereadRaw = String(reread.rows[0].graph_json);
            const check = applyBusyToAgentTransform(parseGraphJson(reread.rows[0].graph_json));
            if (check.status !== 'noop') selfCheckFailure = `re-read graph still transforms (status='${check.status}')`;
        } catch (err) {
            selfCheckFailure = `re-read graph refused: ${err.message}`;
        }
        if (selfCheckFailure) {
            console.error(`\nPOST-WRITE SELF-CHECK FAILED (transaction already committed — review manually): ${selfCheckFailure}`);
            if (rereadRaw !== null && rereadRaw !== afterRaw) {
                console.error('\nDiff (written -> re-read):');
                console.error(unifiedDiff(pretty(JSON.parse(afterRaw)), pretty(JSON.parse(rereadRaw))));
            }
            process.exitCode = 1;
            return;
        }
        console.log(`\nApplied: 1 row updated; updated_at ${toIso(row.updated_at)} -> ${toIso(reread.rows[0].updated_at)} (trigger).`);
        console.log('Post-write self-check: re-read graph NOOPs — OK.');
        console.log('\nVERDICT: APPLIED');
        // exit 0
    } catch (err) {
        if (inTransaction) await client.query('ROLLBACK').catch(() => {});
        if (err && err.name === 'ShapeError') {
            console.error(`\nPrecondition violated — ${err.message}`);
            console.error('\nVERDICT: REFUSED (nothing written)');
            process.exitCode = 2;
        } else {
            console.error(`\nERROR: ${err.message}`);
            process.exitCode = 1;
        }
    } finally {
        await client.end().catch(() => {});
    }
}

if (require.main === module) {
    main();
}
