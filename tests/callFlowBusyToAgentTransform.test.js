/**
 * G1 — CALLFLOW-BUSY-TO-AGENT-001: applyBusyToAgentTransform pure-function suite.
 *
 * Spec: docs/specs/CALLFLOW-BUSY-TO-AGENT-001.md
 * Test cases: docs/test-cases/CALLFLOW-BUSY-TO-AGENT-001.md (T-G1-01 … T-G1-09)
 *
 * Pure/mocked — NO DB. Fixture PROD_SHAPE mirrors the spec's 9-state /
 * 8-transition prod graph for flow cf-bbd3689d. All cases operate on deep clones.
 *
 * Fixture note (after-hours vapi edges): the spec's transition list mentions the
 * after-hours pair "success vapi.completed + fallback vapi.no_target vapi.failed
 * vapi.timeout", but the spec's own count (8 transitions), T-G1-01's expected
 * 10-transitions-post-delta, and S8's "AI Greeting's collapsed 'Next'" all match
 * the editor-persisted form: collapseDuplicateVapiEdges (CallFlowBuilderPage.tsx)
 * merges a visible same-target vapi success+fallback pair into ONE 'Next' edge
 * (event_key 'vapi.completed vapi.no_target vapi.failed vapi.timeout') on load,
 * and reactFlowToGraph persists that collapsed edge on save. The fixture models
 * that single collapsed edge — behaviorally identical for the runtime (the token
 * set carries both roles; vapi.completed is intercepted by advance() before edge
 * routing). The transform itself never touches the after-hours subtree either way,
 * and T3 runs against the REAL prod row.
 */
'use strict';

const { applyBusyToAgentTransform } = require('../scripts/apply-callflow-busy-to-agent-001');

// ─── Fixture: the spec's prod shape (9 states / 8 transitions) ───────────────

const PROD_SHAPE = {
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
        // THE fallback edge (the transform's structural match target)
        { id: 'skt-fallback', from_state_id: 'sk-current-group', to_state_id: 'sk-vm-business-hours', label: 'Not answered / timeout', edgeRole: 'fallback', transitionMode: 'event', event_key: 'queue.timeout queue.not_answered queue.failed' },
        { id: 'skt-success', from_state_id: 'sk-current-group', to_state_id: 'sk-done-routed', edgeRole: 'success', transitionMode: 'event', event_key: 'queue.connected call.handoff', hidden: true },
        // After-hours vapi node's success+fallback pair as the editor persists it:
        // ONE collapsed 'Next' edge (see fixture note in the header comment).
        { id: 'e-1780888101886', from_state_id: 'n-1780888101885', to_state_id: 'sk-vm-after-hours', label: 'Next', edgeLabel: 'Next', edgeRole: 'next', transitionMode: 'event', event_key: 'vapi.completed vapi.no_target vapi.failed vapi.timeout', insertable: true, insertMode: 'between' },
        // Voicemail completion edges
        { id: 'skt-vm-bh-done', from_state_id: 'sk-vm-business-hours', to_state_id: 'sk-done-voicemail-business-hours', edgeRole: 'completion', transitionMode: 'event', event_key: 'voicemail.recorded voicemail.completed' },
        { id: 'skt-vm-ah-done', from_state_id: 'sk-vm-after-hours', to_state_id: 'sk-done-voicemail-after-hours', edgeRole: 'completion', transitionMode: 'event', event_key: 'voicemail.recorded voicemail.completed' },
    ],
};

// Sanity pins on the fixture itself against the spec's expected prod shape.
test('fixture: PROD_SHAPE anchors match the spec (9 states / 8 transitions)', () => {
    expect(PROD_SHAPE.states).toHaveLength(9);
    expect(PROD_SHAPE.transitions).toHaveLength(8);
    const kinds = Object.fromEntries(PROD_SHAPE.states.map((s) => [s.id, s.kind]));
    expect(kinds['sk-current-group']).toBe('queue');
    expect(kinds['sk-vm-business-hours']).toBe('voicemail');
    expect(kinds['sk-done-routed']).toBe('final');
    expect(kinds['n-1780888101885']).toBe('vapi_agent');
    const fallbacks = PROD_SHAPE.transitions.filter(
        (t) => t.from_state_id === 'sk-current-group' && t.to_state_id === 'sk-vm-business-hours'
    );
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0].event_key.split(/\s+/).sort()).toEqual(['queue.failed', 'queue.not_answered', 'queue.timeout']);
    // After-hours vapi routing carries BOTH roles' tokens (collapsed 'Next' edge).
    const ahEdges = PROD_SHAPE.transitions.filter((t) => t.from_state_id === 'n-1780888101885');
    expect(ahEdges).toHaveLength(1);
    expect(ahEdges[0].to_state_id).toBe('sk-vm-after-hours');
    for (const token of ['vapi.completed', 'vapi.no_target', 'vapi.failed', 'vapi.timeout']) {
        expect(ahEdges[0].event_key.split(/\s+/)).toContain(token);
    }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function prodShape() {
    return clone(PROD_SHAPE);
}

/** Builds the byte-exact expected applied graph from an input clone (spec delta §1–§3). */
function expectedAppliedGraph(input) {
    const expected = clone(input);
    const src = expected.states.find((s) => s.id === 'n-1780888101885');
    expected.states.push({
        id: 'n-vapi-bh-backup',
        name: 'AI Backup',
        kind: 'vapi_agent',
        provider: clone(src.provider),
        config: clone(src.config),
    });
    const fallback = expected.transitions.find(
        (t) => t.from_state_id === 'sk-current-group' && t.to_state_id === 'sk-vm-business-hours' &&
            String(t.event_key).split(/\s+/).sort().join(' ') === 'queue.failed queue.not_answered queue.timeout'
    );
    fallback.to_state_id = 'n-vapi-bh-backup';
    expected.transitions.push({
        id: 't-vapi-bh-backup-success',
        from_state_id: 'n-vapi-bh-backup',
        to_state_id: 'sk-done-routed',
        hidden: true,
        edgeRole: 'success',
        transitionMode: 'event',
        event_key: 'vapi.completed',
    });
    expected.transitions.push({
        id: 't-vapi-bh-backup-fallback',
        from_state_id: 'n-vapi-bh-backup',
        to_state_id: 'sk-vm-business-hours',
        label: 'AI unavailable / failed',
        edgeLabel: 'AI unavailable / failed',
        edgeRole: 'fallback',
        insertable: true,
        insertMode: 'between',
        transitionMode: 'event',
        event_key: 'vapi.no_target vapi.failed vapi.timeout',
    });
    return expected;
}

/** Applies `mutate` to a fresh clone and asserts the transform throws a ShapeError matching `pattern`. */
function expectShapeError(mutate, pattern) {
    const graph = prodShape();
    mutate(graph);
    let caught = null;
    try {
        applyBusyToAgentTransform(graph);
    } catch (err) {
        caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught.name).toBe('ShapeError');
    expect(caught.message).toMatch(pattern);
    return caught;
}

// ─── T-G1-01 — delta exactness ────────────────────────────────────────────────

describe('T-G1-01 delta exactness', () => {
    test('applied result is byte-exactly the spec delta (full JSON diff, not spot checks)', () => {
        const input = prodShape();
        const result = applyBusyToAgentTransform(input);

        expect(result.status).toBe('applied');
        expect(result.graph.states).toHaveLength(10);
        expect(result.graph.transitions).toHaveLength(10);

        // Full-graph equality against the independently-built expected delta …
        const expected = expectedAppliedGraph(PROD_SHAPE);
        expect(result.graph).toEqual(expected);
        // … and byte-identical serialization (key order preserved: clone + in-place repoint + appends).
        expect(JSON.stringify(result.graph)).toBe(JSON.stringify(expected));
    });

    test('(a) appended state: AI Backup with config/provider deep-equal but NOT the same reference', () => {
        const input = prodShape();
        const inputSrc = input.states.find((s) => s.id === 'n-1780888101885');
        const result = applyBusyToAgentTransform(input);

        const backup = result.graph.states.find((s) => s.id === 'n-vapi-bh-backup');
        expect(backup).toBeDefined();
        expect(result.graph.states[result.graph.states.length - 1]).toBe(backup); // appended last
        expect(backup.name).toBe('AI Backup');
        expect(backup.kind).toBe('vapi_agent');

        const resultSrc = result.graph.states.find((s) => s.id === 'n-1780888101885');
        expect(backup.config).toEqual(inputSrc.config);
        expect(backup.provider).toEqual(inputSrc.provider);
        expect(backup.config).not.toBe(inputSrc.config);   // deep-copied, not shared with input
        expect(backup.config).not.toBe(resultSrc.config);  // nor shared inside the result
    });

    test('(b) fallback edge repointed with EVERY other field byte-identical', () => {
        const input = prodShape();
        const inputEdge = input.transitions.find((t) => t.id === 'skt-fallback');
        const result = applyBusyToAgentTransform(input);

        const repointed = result.graph.transitions.find((t) => t.id === 'skt-fallback');
        expect(repointed.to_state_id).toBe('n-vapi-bh-backup');

        const { to_state_id: _after, ...restAfter } = repointed;
        const { to_state_id: _before, ...restBefore } = inputEdge;
        expect(JSON.stringify(restAfter)).toBe(JSON.stringify(restBefore));
        // Position in the transitions array unchanged (mutated in place, not re-appended).
        expect(result.graph.transitions.findIndex((t) => t.id === 'skt-fallback'))
            .toBe(input.transitions.findIndex((t) => t.id === 'skt-fallback'));
    });

    test('(c) the two appended transitions match the spec field-by-field', () => {
        const result = applyBusyToAgentTransform(prodShape());
        const success = result.graph.transitions.find((t) => t.id === 't-vapi-bh-backup-success');
        const fallback = result.graph.transitions.find((t) => t.id === 't-vapi-bh-backup-fallback');

        expect(success).toEqual({
            id: 't-vapi-bh-backup-success',
            from_state_id: 'n-vapi-bh-backup',
            to_state_id: 'sk-done-routed',
            hidden: true,
            edgeRole: 'success',
            transitionMode: 'event',
            event_key: 'vapi.completed',
        });
        expect(Object.keys(success).sort()).toEqual(
            ['id', 'from_state_id', 'to_state_id', 'hidden', 'edgeRole', 'transitionMode', 'event_key'].sort()
        );
        expect(fallback).toEqual({
            id: 't-vapi-bh-backup-fallback',
            from_state_id: 'n-vapi-bh-backup',
            to_state_id: 'sk-vm-business-hours',
            label: 'AI unavailable / failed',
            edgeLabel: 'AI unavailable / failed',
            edgeRole: 'fallback',
            insertable: true,
            insertMode: 'between',
            transitionMode: 'event',
            event_key: 'vapi.no_target vapi.failed vapi.timeout',
        });
        expect(Object.keys(fallback).sort()).toEqual(
            ['id', 'from_state_id', 'to_state_id', 'label', 'edgeLabel', 'edgeRole', 'insertable', 'insertMode', 'transitionMode', 'event_key'].sort()
        );
        // Appended in order, at the tail.
        const ids = result.graph.transitions.map((t) => t.id);
        expect(ids.slice(-2)).toEqual(['t-vapi-bh-backup-success', 't-vapi-bh-backup-fallback']);
    });

    test('changes list names exactly the 4 operations', () => {
        const result = applyBusyToAgentTransform(prodShape());
        expect(result.changes).toHaveLength(4);
        expect(result.changes[0]).toMatch(/^add-state n-vapi-bh-backup /);
        expect(result.changes[1]).toMatch(/^repoint-fallback /);
        expect(result.changes[1]).toContain("'n-vapi-bh-backup'");
        expect(result.changes[2]).toMatch(/^add-edge t-vapi-bh-backup-success/);
        expect(result.changes[3]).toMatch(/^add-edge t-vapi-bh-backup-fallback/);
    });
});

// ─── T-G1-02 — untouched subtrees ─────────────────────────────────────────────

describe('T-G1-02 untouched subtrees', () => {
    test('after-hours subtree and queue success edge are JSON.stringify-identical before/after', () => {
        const input = prodShape();
        const result = applyBusyToAgentTransform(input);

        // After-hours subtree: skt-ah edge, the vapi node's (collapsed) edge,
        // sk-vm-after-hours completion edge — plus the queue success edge and
        // every other pre-existing transition except the repointed fallback.
        const untouchedTransitionIds = ['skt-entry', 'skt-bh', 'skt-ah', 'skt-success', 'e-1780888101886', 'skt-vm-bh-done', 'skt-vm-ah-done'];
        for (const id of untouchedTransitionIds) {
            const before = input.transitions.find((t) => t.id === id);
            const after = result.graph.transitions.find((t) => t.id === id);
            expect(before).toBeDefined();
            expect(JSON.stringify(after)).toBe(JSON.stringify(before));
        }

        // All 9 pre-existing states byte-identical (incl. n-1780888101885 and sk-vm-after-hours).
        for (const { id } of PROD_SHAPE.states) {
            const before = input.states.find((s) => s.id === id);
            const after = result.graph.states.find((s) => s.id === id);
            expect(JSON.stringify(after)).toBe(JSON.stringify(before));
        }
    });
});

// ─── T-G1-03 — input not mutated ──────────────────────────────────────────────

describe('T-G1-03 purity', () => {
    test('input graph is byte-identical to its pre-call snapshot', () => {
        const input = prodShape();
        const snapshot = clone(input);
        const result = applyBusyToAgentTransform(input);
        expect(input).toEqual(snapshot);
        expect(JSON.stringify(input)).toBe(JSON.stringify(snapshot));
        expect(result.graph).not.toBe(input); // result is a fresh structure
    });

    test('noop input is not mutated either, and the returned graph is a clone', () => {
        const applied = applyBusyToAgentTransform(prodShape());
        const snapshot = clone(applied.graph);
        const second = applyBusyToAgentTransform(applied.graph);
        expect(JSON.stringify(applied.graph)).toBe(JSON.stringify(snapshot));
        expect(second.graph).not.toBe(applied.graph);
    });
});

// ─── T-G1-04 — idempotency (fixed point) ──────────────────────────────────────

describe('T-G1-04 idempotency', () => {
    test('transform(transform(g)) is a noop fixed point', () => {
        const applied = applyBusyToAgentTransform(prodShape());
        expect(applied.status).toBe('applied');

        const second = applyBusyToAgentTransform(applied.graph);
        expect(second.status).toBe('noop');
        expect(second.graph).toEqual(applied.graph);
        expect(JSON.stringify(second.graph)).toBe(JSON.stringify(applied.graph));
        expect(second.changes).toBeUndefined();

        // And a third application stays fixed.
        const third = applyBusyToAgentTransform(second.graph);
        expect(third.status).toBe('noop');
        expect(JSON.stringify(third.graph)).toBe(JSON.stringify(applied.graph));
    });
});

// ─── T-G1-05 — editor-whitelist fields only ───────────────────────────────────

describe('T-G1-05 editor-whitelist fields only (reactFlowToGraph serialization set)', () => {
    const STATE_WHITELIST = ['id', 'name', 'kind', 'isInitial', 'protected', 'system', 'immutable', 'uiTerminal', 'hidden', 'labelExpr', 'groupRef', 'provider', 'configRef', 'config'];
    const EDGE_WHITELIST = ['id', 'from_state_id', 'to_state_id', 'event_key', 'label', 'system', 'immutable', 'deletable', 'hidden', 'insertable', 'insertMode', 'edgeLabel', 'branchKey', 'edgeRole', 'transitionMode', 'condExpr'];

    test('every field of the new state and the 2 new edges is on the whitelist', () => {
        const result = applyBusyToAgentTransform(prodShape());

        const backup = result.graph.states.find((s) => s.id === 'n-vapi-bh-backup');
        for (const key of Object.keys(backup)) {
            expect(STATE_WHITELIST).toContain(key);
        }

        for (const edgeId of ['t-vapi-bh-backup-success', 't-vapi-bh-backup-fallback']) {
            const edge = result.graph.transitions.find((t) => t.id === edgeId);
            for (const key of Object.keys(edge)) {
                expect(EDGE_WHITELIST).toContain(key);
            }
        }
    });

    test('no coordinates or editor-internal fields are written (ELK auto-layout)', () => {
        const result = applyBusyToAgentTransform(prodShape());
        const backup = result.graph.states.find((s) => s.id === 'n-vapi-bh-backup');
        for (const forbidden of ['x', 'y', 'position', 'type', 'data', 'source', 'target']) {
            expect(backup).not.toHaveProperty(forbidden);
        }
    });
});

// ─── T-G1-06 — refusals (each names its precondition) ─────────────────────────

describe('T-G1-06 refusals — ShapeError naming the precondition', () => {
    test('(a) queue node id renamed -> P4', () => {
        expectShapeError((g) => {
            g.states.find((s) => s.id === 'sk-current-group').id = 'sk-queue-renamed';
        }, /P4/);
    });

    test('(b) sk-vm-business-hours kind changed -> P4', () => {
        expectShapeError((g) => {
            g.states.find((s) => s.id === 'sk-vm-business-hours').kind = 'greeting';
        }, /P4/);
    });

    test('(c) fallback edge token removed -> P5', () => {
        expectShapeError((g) => {
            g.transitions.find((t) => t.id === 'skt-fallback').event_key = 'queue.timeout queue.failed';
        }, /P5/);
    });

    test('(c2) fallback edge token added -> P5', () => {
        expectShapeError((g) => {
            g.transitions.find((t) => t.id === 'skt-fallback').event_key = 'queue.timeout queue.not_answered queue.failed queue.extra';
        }, /P5/);
    });

    test('(d) TWO fallback-matching edges -> P5', () => {
        expectShapeError((g) => {
            const original = g.transitions.find((t) => t.id === 'skt-fallback');
            g.transitions.push({ ...JSON.parse(JSON.stringify(original)), id: 'skt-fallback-dup' });
        }, /P5/);
    });

    test('(e) zero matching edges (fallback edge removed) -> P5', () => {
        expectShapeError((g) => {
            g.transitions = g.transitions.filter((t) => t.id !== 'skt-fallback');
        }, /P5/);
    });

    test('(f) n-1780888101885 absent -> P4', () => {
        expectShapeError((g) => {
            g.states = g.states.filter((s) => s.id !== 'n-1780888101885');
        }, /P4/);
    });

    test('(g) sk-done-routed absent -> P4', () => {
        expectShapeError((g) => {
            g.states = g.states.filter((s) => s.id !== 'sk-done-routed');
        }, /P4/);
    });

    test('(h) states empty -> P3; transitions not an array -> P3', () => {
        expectShapeError((g) => {
            g.states = [];
        }, /P3/);
        expectShapeError((g) => {
            g.transitions = 'not-an-array';
        }, /P3/);
        // and non-object graphs refuse too
        expect(() => applyBusyToAgentTransform(null)).toThrow(/P3/);
        expect(() => applyBusyToAgentTransform(undefined)).toThrow(/P3/);
    });
});

// ─── T-G1-07 — partial-application refusal (never heals silently) ─────────────

describe('T-G1-07 partial application -> refuse, never auto-heal', () => {
    test('only the new state added (edge not repointed, edges missing) -> P6', () => {
        expectShapeError((g) => {
            g.states.push({ id: 'n-vapi-bh-backup', name: 'AI Backup', kind: 'vapi_agent', provider: 'vapi', config: {} });
        }, /P6/);
    });

    test('edge repointed but new state/edges missing -> P6', () => {
        expectShapeError((g) => {
            g.transitions.find((t) => t.id === 'skt-fallback').to_state_id = 'n-vapi-bh-backup';
        }, /P6/);
    });

    test('state added + edge repointed, but the two new edges missing -> P6', () => {
        expectShapeError((g) => {
            g.states.push({ id: 'n-vapi-bh-backup', name: 'AI Backup', kind: 'vapi_agent', provider: 'vapi', config: {} });
            g.transitions.find((t) => t.id === 'skt-fallback').to_state_id = 'n-vapi-bh-backup';
        }, /P6/);
    });

    test('all 4 artifacts present but success edge mis-wired -> P6 (wiring check)', () => {
        const applied = applyBusyToAgentTransform(prodShape());
        const drifted = clone(applied.graph);
        drifted.transitions.find((t) => t.id === 't-vapi-bh-backup-success').to_state_id = 'sk-vm-after-hours';
        let caught = null;
        try {
            applyBusyToAgentTransform(drifted);
        } catch (err) {
            caught = err;
        }
        expect(caught).not.toBeNull();
        expect(caught.name).toBe('ShapeError');
        expect(caught.message).toMatch(/P6/);
    });
});

// ─── T-G1-08 — token-order insensitivity ──────────────────────────────────────

describe('T-G1-08 token-order insensitivity', () => {
    test('reordered event_key still matches (token-SET compare) and is preserved byte-identical', () => {
        const input = prodShape();
        input.transitions.find((t) => t.id === 'skt-fallback').event_key = 'queue.failed queue.timeout queue.not_answered';

        const result = applyBusyToAgentTransform(input);
        expect(result.status).toBe('applied');

        const repointed = result.graph.transitions.find((t) => t.id === 'skt-fallback');
        expect(repointed.to_state_id).toBe('n-vapi-bh-backup');
        expect(repointed.event_key).toBe('queue.failed queue.timeout queue.not_answered'); // untouched
    });
});

// ─── T-G1-09 — SABOTAGE CONTROL (proves the refusal guard is non-vacuous) ─────

describe('T-G1-09 sabotage control', () => {
    test('fallback edge pointing at sk-vm-after-hours MUST throw — if this passes, the guard is vacuous', () => {
        const sabotaged = prodShape();
        sabotaged.transitions.find((t) => t.id === 'skt-fallback').to_state_id = 'sk-vm-after-hours';

        let caught = null;
        try {
            applyBusyToAgentTransform(sabotaged);
        } catch (err) {
            caught = err;
        }
        // Non-vacuous guard: the matcher requires to_state_id === 'sk-vm-business-hours';
        // a graph whose fallback targets the after-hours voicemail must be REFUSED,
        // not silently transformed.
        expect(caught).not.toBeNull();
        expect(caught.name).toBe('ShapeError');
        expect(caught.message).toMatch(/P5/);
    });
});
