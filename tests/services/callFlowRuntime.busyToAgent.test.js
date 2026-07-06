/**
 * G2 — CALLFLOW-BUSY-TO-AGENT-001: runtime path over the TRANSFORMED graph.
 *
 * Spec: docs/specs/CALLFLOW-BUSY-TO-AGENT-001.md (S1–S6)
 * Test cases: docs/test-cases/CALLFLOW-BUSY-TO-AGENT-001.md (T-G2-01 … T-G2-10)
 *
 * Proves the graph-data delta drives the UNMODIFIED runtime as specced:
 * business-hours queue exhaustion (no agents / ring timeout / dial failure)
 * → Sara (vapi <Dial answerOnBridge><Sip>), and voicemail only as the LAST
 * resort (Sara dial-fail or unresolvable SIP → BUSINESS-hours greeting).
 * After-hours branch, queue.connected and vapi.completed semantics unchanged.
 *
 * The graph under test is built by IMPORTING applyBusyToAgentTransform from
 * T1's script and applying it to the PROD_SHAPE fixture — never hand-copied —
 * so these tests can never drift from the shipped delta. PROD_SHAPE mirrors
 * the spec's 9-state / 8-transition prod graph (after-hours vapi success+
 * fallback pair modeled as the editor-persisted collapsed 'Next' edge — see
 * the fixture note in tests/callFlowBusyToAgentTransform.test.js).
 *
 * Harness mirrors tests/services/callFlowRuntime.vapi.test.js /
 * callFlowAutonomousMode.test.js: mock db/connection, realtimeService,
 * groupRouting, telephonyTenantService. The db mock is STATEFUL (UPDATE
 * call_flow_executions applies COALESCE patch semantics to the row) so
 * chained renders observe consistent execution state and tests can assert
 * the finally-saved current_node_id / status.
 *
 * Product code untouched — this suite is the tripwire for the freeze list.
 */
'use strict';

// Distinct greeting markers make the business-vs-after-hours voicemail
// selection observable (buildVoicemailTwiml reads env at call time).
process.env.VM_GREETING = 'BUSINESS_VM_MARKER';
process.env.VM_AFTER_HOURS_GREETING = 'AFTERHOURS_VM_MARKER';
// S4B (T-G2-05) requires the env SIP fallback ABSENT so an empty
// vapi_tenant_resources result makes the SIP target unresolvable.
delete process.env.VAPI_SIP_URI;
delete process.env.DIAL_TIMEOUT;

const mockQuery = jest.fn();
jest.mock('../../backend/src/db/connection', () => ({ query: mockQuery }));
jest.mock('../../backend/src/services/realtimeService', () => ({
    broadcast: jest.fn(),
    publishCallUpdate: jest.fn(),
}));
jest.mock('../../backend/src/services/groupRouting', () => ({
    availableAgentsForGroup: jest.fn(),
    isBusinessHours: jest.fn(),
}));
jest.mock('../../backend/src/services/telephonyTenantService', () => ({
    getAutonomousMode: jest.fn(),
}));

// T1's transform — the tests' graph fixture is its ACTUAL output.
const { applyBusyToAgentTransform } = require('../../scripts/apply-callflow-busy-to-agent-001.js');
const {
    startExecution,
    advance,
    eventFromDialStatus,
    vapiEventFromDialStatus,
} = require('../../backend/src/services/callFlowRuntime');
const realtimeService = require('../../backend/src/services/realtimeService');
const groupRouting = require('../../backend/src/services/groupRouting');
const telephonyTenantService = require('../../backend/src/services/telephonyTenantService');

// ─── Fixture: the spec's prod shape (same 9-state/8-transition graph as G1) ───

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
        { id: 'skt-fallback', from_state_id: 'sk-current-group', to_state_id: 'sk-vm-business-hours', label: 'Not answered / timeout', edgeRole: 'fallback', transitionMode: 'event', event_key: 'queue.timeout queue.not_answered queue.failed' },
        { id: 'skt-success', from_state_id: 'sk-current-group', to_state_id: 'sk-done-routed', edgeRole: 'success', transitionMode: 'event', event_key: 'queue.connected call.handoff', hidden: true },
        { id: 'e-1780888101886', from_state_id: 'n-1780888101885', to_state_id: 'sk-vm-after-hours', label: 'Next', edgeLabel: 'Next', edgeRole: 'next', transitionMode: 'event', event_key: 'vapi.completed vapi.no_target vapi.failed vapi.timeout', insertable: true, insertMode: 'between' },
        { id: 'skt-vm-bh-done', from_state_id: 'sk-vm-business-hours', to_state_id: 'sk-done-voicemail-business-hours', edgeRole: 'completion', transitionMode: 'event', event_key: 'voicemail.recorded voicemail.completed' },
        { id: 'skt-vm-ah-done', from_state_id: 'sk-vm-after-hours', to_state_id: 'sk-done-voicemail-after-hours', edgeRole: 'completion', transitionMode: 'event', event_key: 'voicemail.recorded voicemail.completed' },
    ],
};

// The graph under test = T1's transform output. If the shipped delta changes,
// this changes with it (no spec/fixture drift possible).
const TRANSFORMED = applyBusyToAgentTransform(PROD_SHAPE).graph;

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const GROUP_ID = 'ug-2385d69d';
const FLOW_ID = 'cf-bbd3689d';
const CALL_SID = 'CA_busy_to_agent';
const BASE_URL = 'https://example.test';
const SARA_SIP = 'sip:sara@sip.vapi.ai';

const group = { id: GROUP_ID, name: 'Dispatch Team', company_id: COMPANY_ID, timezone: 'America/New_York' };
const flowFor = (graph) => ({ id: FLOW_ID, graph: clone(graph), updated_at: '2026-07-06T00:00:00Z' });

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

// ─── Stateful db mock ─────────────────────────────────────────────────────────

let executionRow; // the single call_flow_executions row under test
let sipRows;      // vapi_tenant_resources SELECT result (default: Sara resolvable)

function installDb() {
    mockQuery.mockImplementation(async (sql, params) => {
        if (sql.includes('INSERT INTO call_flow_executions')) {
            // createExecution params: [id, companyId, callSid, groupId, flowId, startNodeId, contextJson]
            executionRow = {
                id: params[0],
                company_id: params[1],
                call_sid: params[2],
                group_id: params[3],
                flow_id: params[4],
                current_node_id: params[5],
                context_json: params[6],
                status: 'active',
            };
            return { rows: [{ ...executionRow }] };
        }
        if (sql.includes('SELECT * FROM call_flow_executions')) {
            return { rows: executionRow ? [{ ...executionRow }] : [] };
        }
        if (sql.includes('UPDATE call_flow_executions')) {
            // saveExecutionState params: [callSid, companyId, currentNodeId|null, contextJson|null, status|null]
            // Apply the COALESCE semantics so chained renders see consistent state.
            const [, , currentNodeId, contextJson, status] = params;
            if (executionRow) {
                if (currentNodeId != null) executionRow.current_node_id = currentNodeId;
                if (contextJson != null) executionRow.context_json = contextJson;
                if (status != null) executionRow.status = status;
            }
            return { rows: executionRow ? [{ ...executionRow }] : [] };
        }
        if (sql.includes('FROM vapi_tenant_resources r')) {
            return { rows: sipRows };
        }
        if (sql.includes('UPDATE calls')) {
            return { rows: [] };
        }
        return { rows: [] };
    });
}

/** Seeds an active execution parked at `nodeId` with the given graph in its context snapshot. */
function seedExecution(nodeId, { graph = TRANSFORMED, context = {}, status = 'active' } = {}) {
    executionRow = {
        id: 'cfe-test',
        company_id: COMPANY_ID,
        call_sid: CALL_SID,
        group_id: GROUP_ID,
        flow_id: FLOW_ID,
        current_node_id: nodeId,
        status,
        context_json: JSON.stringify({
            graph: clone(graph),
            callSid: CALL_SID,
            companyId: COMPANY_ID,
            groupId: GROUP_ID,
            groupName: 'Dispatch Team',
            callerNumber: '+15551112222',
            calledNumber: '+16175550100',
            isBusinessHours: true,
            baseUrl: BASE_URL,
            ...context,
        }),
    };
    return executionRow;
}

function runStartExecution(graph) {
    return startExecution({
        callSid: CALL_SID,
        fromNumber: '+15551112222',
        toNumber: '+16175550100',
        group,
        flow: flowFor(graph),
        baseUrl: BASE_URL,
        traceId: 'test',
    });
}

/** The vapi_agent leg TwiML: Dial answerOnBridge → Sip Sara, dial-action tagged vapiNode=1, never VM content. */
function expectVapiTwiml(twiml) {
    expect(twiml).toContain('<Sip');
    expect(twiml).toContain(SARA_SIP);
    expect(twiml).toContain('answerOnBridge="true"');
    expect(twiml).toContain('/webhooks/twilio/voice-dial-action?vapiNode=1');
    expect(twiml).not.toContain('<Record');
    expect(twiml).not.toContain('BUSINESS_VM_MARKER');
    expect(twiml).not.toContain('AFTERHOURS_VM_MARKER');
}

beforeEach(() => {
    jest.clearAllMocks();
    executionRow = null;
    sipRows = [{ sip_uri: SARA_SIP }]; // Sara resolvable by default (vapi_tenant_resources hit)
    installDb();
    telephonyTenantService.getAutonomousMode.mockResolvedValue(false);
    groupRouting.isBusinessHours.mockResolvedValue(true);
    groupRouting.availableAgentsForGroup.mockResolvedValue([]);
});

// ─── Sanity tripwire: the imported transform actually applied ─────────────────

describe('fixture sanity (transform import tripwire)', () => {
    test('applyBusyToAgentTransform(PROD_SHAPE) applied: 10 states / 10 transitions, fallback repointed', () => {
        const result = applyBusyToAgentTransform(PROD_SHAPE);
        expect(result.status).toBe('applied');
        expect(TRANSFORMED.states).toHaveLength(10);
        expect(TRANSFORMED.transitions).toHaveLength(10);
        const fallback = TRANSFORMED.transitions.find((t) => t.id === 'skt-fallback');
        expect(fallback.to_state_id).toBe('n-vapi-bh-backup');
        expect(TRANSFORMED.states.some((s) => s.id === 'n-vapi-bh-backup' && s.kind === 'vapi_agent')).toBe(true);
    });
});

// ─── T-G2-01 (S1) — no agents available → Sara, instantly ────────────────────

describe('T-G2-01 (S1): business-hours call, zero available agents → vapi TwiML in the inbound response', () => {
    test('startExecution renders start → hours-check → queue → (no agents) → n-vapi-bh-backup Sip dial', async () => {
        groupRouting.availableAgentsForGroup.mockResolvedValue([]);

        const twiml = await runStartExecution(TRANSFORMED);

        // The inbound-webhook response itself is the vapi leg — Sara, not voicemail.
        expectVapiTwiml(twiml);
        expect(twiml).toContain('timeLimit="900"');
        expect(twiml).toContain(`x-blanc-company-id=${COMPANY_ID}`);
        expect(twiml).toContain(`x-blanc-group-id=${GROUP_ID}`);
        // NO announcement, NO voicemail, NO client dial ever happened.
        expect(twiml).not.toContain('<Say');
        expect(twiml).not.toContain('<Client');

        // Execution parked at the new backup node.
        expect(executionRow.current_node_id).toBe('n-vapi-bh-backup');
        expect(executionRow.status).toBe('active');

        // Queue was actually consulted for THIS group/company, and the queued
        // broadcast still fires with the no-agents status (SSE unchanged).
        expect(groupRouting.availableAgentsForGroup).toHaveBeenCalledWith(GROUP_ID, COMPANY_ID, 'test');
        expect(realtimeService.broadcast).toHaveBeenCalledWith('group.call.queued', expect.objectContaining({
            call_sid: CALL_SID,
            group_id: GROUP_ID,
            status: 'no_available_agents',
        }));
    });
});

// ─── T-G2-02 (S2) — dispatchers ring, nobody answers → Sara ──────────────────

describe('T-G2-02 (S2): agents ring (queue Dial), DialCallStatus=no-answer → vapi TwiML in the dial-action response', () => {
    test('queue <Dial><Client> first, then advance(queue.timeout) returns the Sip dial seamlessly', async () => {
        groupRouting.availableAgentsForGroup.mockResolvedValue([{ identity: 'softphone-dispatcher-1' }]);

        // Phase 1 — inbound webhook: the queue node dials the human agents.
        const dialTwiml = await runStartExecution(TRANSFORMED);
        expect(dialTwiml).toContain('<Dial timeout="120"'); // fixture queue config, not the vapi dial
        expect(dialTwiml).toContain('answerOnBridge="true"');
        expect(dialTwiml).toContain('<Client');
        expect(dialTwiml).toContain('softphone-dispatcher-1');
        expect(dialTwiml).toContain('/webhooks/twilio/voice-dial-action"');
        expect(dialTwiml).not.toContain('vapiNode=1');
        expect(dialTwiml).not.toContain('<Sip');
        expect(executionRow.current_node_id).toBe('sk-current-group');

        // Phase 2 — Twilio posts the dial result: no-answer → queue.timeout.
        const event = eventFromDialStatus('no-answer');
        expect(event).toBe('queue.timeout');
        const twiml = await advance(CALL_SID, event, 'test');

        // The dial-action HTTP response IS the vapi leg (no <Redirect>, no voicemail).
        expectVapiTwiml(twiml);
        expect(executionRow.current_node_id).toBe('n-vapi-bh-backup');
    });
});

// ─── T-G2-03 (S3) — dial failure → Sara ──────────────────────────────────────

describe('T-G2-03 (S3): dial failure statuses map onto the repointed edge → vapi TwiML', () => {
    test.each([
        ['busy', 'queue.failed'],
        ['failed', 'queue.failed'],
        ['canceled', 'queue.failed'],
        ['some-unknown-status', 'queue.not_answered'],
    ])('DialCallStatus=%s → %s → Sip dial to Sara', async (dialStatus, expectedEvent) => {
        expect(eventFromDialStatus(dialStatus)).toBe(expectedEvent); // mapping pin
        seedExecution('sk-current-group');

        const twiml = await advance(CALL_SID, expectedEvent, 'test');

        expectVapiTwiml(twiml);
        expect(executionRow.current_node_id).toBe('n-vapi-bh-backup');
    });
});

// ─── T-G2-04 (S4A) — Sara dial-level failure → BUSINESS-hours voicemail ───────

describe('T-G2-04 (S4A): vapi dial failure at n-vapi-bh-backup → business-hours voicemail (LAST resort)', () => {
    test.each([
        ['busy', 'vapi.failed'],
        ['failed', 'vapi.failed'],
        ['', 'vapi.failed'],
        ['no-answer', 'vapi.timeout'],
    ])('vapiNode=1 DialCallStatus=%s → %s → BUSINESS_VM_MARKER greeting + <Record>', async (dialStatus, expectedEvent) => {
        expect(vapiEventFromDialStatus(dialStatus)).toBe(expectedEvent); // ?vapiNode=1 mapping pin
        seedExecution('n-vapi-bh-backup');

        const twiml = await advance(CALL_SID, expectedEvent, 'test');

        // Business-hours greeting (branchKey business_hours → VM_GREETING) — NOT after-hours.
        expect(twiml).toContain('BUSINESS_VM_MARKER');
        expect(twiml).toContain('<Record');
        expect(twiml).not.toContain('AFTERHOURS_VM_MARKER');
        expect(twiml).not.toContain('<Sip');
        // Completion wiring stays live (untouched skt-vm-bh-done path).
        expect(twiml).toContain('voicemail-complete?flowEvent=voicemail.recorded');

        expect(executionRow.current_node_id).toBe('sk-vm-business-hours');
        expect(executionRow.status).toBe('voicemail');
    });
});

// ─── T-G2-05 (S4B) — unresolvable SIP → business voicemail in the SAME response ─

describe('T-G2-05 (S4B): no vapi_tenant_resources row AND no env VAPI_SIP_URI → business VM in the same response', () => {
    test('advance(queue.timeout) renders the backup node, SIP unresolvable → t-vapi-bh-backup-fallback → business VM', async () => {
        sipRows = []; // no active tenant resource; env VAPI_SIP_URI deleted at module top
        seedExecution('sk-current-group');

        const twiml = await advance(CALL_SID, 'queue.timeout', 'test');

        // followFailureEdge probes vapi.no_target → the new fallback edge — the
        // voicemail TwiML comes back in the SAME response that attempted the vapi render.
        expect(twiml).toContain('BUSINESS_VM_MARKER');
        expect(twiml).toContain('<Record');
        expect(twiml).not.toContain('<Sip');
        expect(twiml).not.toContain('AFTERHOURS_VM_MARKER');
        expect(twiml).not.toContain('AI agent is not configured'); // edge followed, not the audible fallback
        expect(executionRow.current_node_id).toBe('sk-vm-business-hours');
        expect(executionRow.status).toBe('voicemail');
    });

    test('full catastrophe chain: no agents AND no SIP → the inbound response itself is the business VM', async () => {
        sipRows = [];
        groupRouting.availableAgentsForGroup.mockResolvedValue([]);

        const twiml = await runStartExecution(TRANSFORMED);

        expect(twiml).toContain('BUSINESS_VM_MARKER');
        expect(twiml).toContain('<Record');
        expect(twiml).not.toContain('<Sip');
        expect(twiml).not.toContain('<Client');
        expect(executionRow.current_node_id).toBe('sk-vm-business-hours');
        expect(executionRow.status).toBe('voicemail');
    });
});

// ─── T-G2-06 (S4 non-case) — Sara handled the call → completed, never VM ──────

describe('T-G2-06 (S4 non-case): vapi.completed at n-vapi-bh-backup → call completed (advance intercept)', () => {
    test('vapi.completed → <Hangup>, status completed, no voicemail content', async () => {
        seedExecution('n-vapi-bh-backup');

        const twiml = await advance(CALL_SID, 'vapi.completed', 'test');

        expect(twiml).toContain('<Hangup');
        expect(twiml).not.toContain('BUSINESS_VM_MARKER');
        expect(twiml).not.toContain('AFTERHOURS_VM_MARKER');
        expect(twiml).not.toContain('<Record');
        expect(twiml).not.toContain('<Sip');

        expect(executionRow.status).toBe('completed');
        const sawCompleted = mockQuery.mock.calls.some(([sql, params]) =>
            /UPDATE call_flow_executions/.test(sql) && Array.isArray(params) && params.includes('completed'));
        expect(sawCompleted).toBe(true);
    });
});

// ─── T-G2-07 (S6) — dispatcher answers → unchanged ────────────────────────────

describe('T-G2-07 (S6): queue.connected → done, unchanged', () => {
    test('completed/answered map to queue.connected; advance intercepts → accepted broadcast + <Hangup>', async () => {
        expect(eventFromDialStatus('completed')).toBe('queue.connected'); // mapping pins
        expect(eventFromDialStatus('answered')).toBe('queue.connected');
        seedExecution('sk-current-group');

        const twiml = await advance(CALL_SID, 'queue.connected', 'test');

        expect(twiml).toContain('<Hangup');
        expect(twiml).not.toContain('<Sip');
        expect(twiml).not.toContain('<Record');
        expect(twiml).not.toContain('BUSINESS_VM_MARKER');
        expect(twiml).not.toContain('AFTERHOURS_VM_MARKER');

        expect(realtimeService.broadcast).toHaveBeenCalledWith('group.call.accepted', expect.objectContaining({
            call_sid: CALL_SID,
            group_id: GROUP_ID,
        }));
        expect(executionRow.status).toBe('completed');
        // Interception happens BEFORE edge routing — the call never moved to the backup node.
        expect(executionRow.current_node_id).toBe('sk-current-group');
    });
});

// ─── T-G2-08 (S5) — after-hours branch unchanged ──────────────────────────────

describe('T-G2-08 (S5): after-hours branch untouched — original vapi node, its failure → after-hours VM', () => {
    test('isBusinessHours=false routes to n-1780888101885 (NOT n-vapi-bh-backup); vapi.failed → AFTERHOURS_VM_MARKER', async () => {
        groupRouting.isBusinessHours.mockResolvedValue(false);

        const twiml1 = await runStartExecution(TRANSFORMED);

        // Hours-check chose the ORIGINAL after-hours vapi node.
        expect(executionRow.current_node_id).toBe('n-1780888101885');
        expect(twiml1).toContain('<Sip');
        expect(twiml1).toContain(SARA_SIP);
        expect(twiml1).toContain('answerOnBridge="true"');
        // The queue (and therefore the backup node) is unreachable on this branch.
        expect(groupRouting.availableAgentsForGroup).not.toHaveBeenCalled();

        const twiml2 = await advance(CALL_SID, 'vapi.failed', 'test');

        expect(twiml2).toContain('AFTERHOURS_VM_MARKER');
        expect(twiml2).toContain('<Record');
        expect(twiml2).not.toContain('BUSINESS_VM_MARKER');
        expect(executionRow.current_node_id).toBe('sk-vm-after-hours');
        expect(executionRow.status).toBe('voicemail');
    });
});

// ─── T-G2-09 — duplicate/stray queue event at the backup node: no loop ────────

describe('T-G2-09: stray/duplicate queue.timeout while already at n-vapi-bh-backup → no cycle', () => {
    test('duplicate event ends the call (<Hangup> + completed), never re-dials Sara or the queue', async () => {
        seedExecution('n-vapi-bh-backup');

        const twiml = await advance(CALL_SID, 'queue.timeout', 'test');

        // No cycle through the repointed edge: no new Sip leg, no client dial,
        // no voicemail — the execution just completes with a hangup.
        // (Observed routing: no vapi.* edge matches queue.timeout; advance's
        // eventless probe resolves the hidden success edge → sk-done-routed
        // final → completed — same observable contract as the spec's
        // "matches no edge → complete + <Hangup>" sketch.)
        expect(twiml).toContain('<Hangup');
        expect(twiml).not.toContain('<Sip');
        expect(twiml).not.toContain('<Client');
        expect(twiml).not.toContain('<Record');
        expect(twiml).not.toContain('BUSINESS_VM_MARKER');
        expect(executionRow.status).toBe('completed');
    });
});

// ─── T-G2-10 — CONTROL: the UNTRANSFORMED graph still voicemails ──────────────

describe('T-G2-10 (CONTROL): untransformed PROD_SHAPE, no agents → voicemail (today\'s behavior)', () => {
    test('same harness, original graph: queue exhaustion lands on the business VM announcement, no Sip', async () => {
        groupRouting.availableAgentsForGroup.mockResolvedValue([]);

        const twiml = await runStartExecution(PROD_SHAPE);

        // Proves T-G2-01's green comes from the DELTA, not the harness: with the
        // original graph the very same call goes straight to voicemail.
        expect(twiml).toContain('BUSINESS_VM_MARKER');
        expect(twiml).toContain('<Record');
        expect(twiml).not.toContain('<Sip');
        expect(twiml).not.toContain('vapiNode=1');
        expect(twiml).not.toContain('AFTERHOURS_VM_MARKER');
        expect(executionRow.current_node_id).toBe('sk-vm-business-hours');
        expect(executionRow.status).toBe('voicemail');
    });
});
