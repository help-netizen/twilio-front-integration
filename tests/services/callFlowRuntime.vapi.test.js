/**
 * callFlowRuntime — vapi_agent post-agent routing (LQV2 node simplification).
 *
 * Behaviour baked into the backend (no longer per-node UI config):
 *   - vapi.completed         → end the call (assistant handled it)
 *   - vapi.failed / timeout   → follow the node's outgoing edge (fallback)
 */

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

const {
    advance,
    vapiEventFromDialStatus,
} = require('../../backend/src/services/callFlowRuntime');

// AI agent node with a single combined fallback edge (the edge model the
// telephony rework produces). Fallback target is a greeting node we can detect.
const graph = {
    states: [
        { id: 'ai', name: 'AI Agent', kind: 'vapi_agent', config: {} },
        { id: 'fb', name: 'Fallback', kind: 'greeting', config: { text: 'FALLBACK_REACHED' } },
    ],
    transitions: [
        {
            id: 'ai-fb',
            from_state_id: 'ai',
            to_state_id: 'fb',
            transitionMode: 'event',
            event_key: 'vapi.completed vapi.failed vapi.timeout',
        },
    ],
};

function mockExecutionAt(nodeId) {
    const execution = {
        call_sid: 'CA_vapi',
        company_id: 'company-1',
        group_id: 'ug-1',
        current_node_id: nodeId,
        status: 'active',
        context_json: JSON.stringify({
            graph,
            groupId: 'ug-1',
            callerNumber: '+15551112222',
            calledNumber: '+16175550100',
            baseUrl: 'https://example.test',
        }),
    };
    mockQuery.mockImplementation((sql) => {
        if (sql.includes('SELECT * FROM call_flow_executions')) return { rows: [execution] };
        return { rows: [execution] }; // UPDATE saveExecutionState
    });
    return execution;
}

describe('vapiEventFromDialStatus', () => {
    test('completed/answered → vapi.completed', () => {
        expect(vapiEventFromDialStatus('completed')).toBe('vapi.completed');
        expect(vapiEventFromDialStatus('answered')).toBe('vapi.completed');
        expect(vapiEventFromDialStatus('COMPLETED')).toBe('vapi.completed');
    });
    test('no-answer → vapi.timeout', () => {
        expect(vapiEventFromDialStatus('no-answer')).toBe('vapi.timeout');
    });
    test('busy/failed/canceled/unknown → vapi.failed', () => {
        expect(vapiEventFromDialStatus('busy')).toBe('vapi.failed');
        expect(vapiEventFromDialStatus('failed')).toBe('vapi.failed');
        expect(vapiEventFromDialStatus('canceled')).toBe('vapi.failed');
        expect(vapiEventFromDialStatus('')).toBe('vapi.failed');
    });
});

describe('advance() — vapi_agent routing', () => {
    beforeEach(() => jest.clearAllMocks());

    test('vapi.completed → ends the call (does NOT follow the edge)', async () => {
        mockExecutionAt('ai');
        const twiml = await advance('CA_vapi', 'vapi.completed', 'test');
        expect(twiml).toContain('<Hangup');
        expect(twiml).not.toContain('FALLBACK_REACHED');
        // status set to completed via an UPDATE carrying 'completed'
        const sawCompleted = mockQuery.mock.calls.some(([sql, params]) =>
            /UPDATE call_flow_executions/.test(sql) && Array.isArray(params) && params.includes('completed'));
        expect(sawCompleted).toBe(true);
    });

    test('vapi.failed → follows the outgoing edge to the fallback node', async () => {
        mockExecutionAt('ai');
        const twiml = await advance('CA_vapi', 'vapi.failed', 'test');
        expect(twiml).toContain('FALLBACK_REACHED');
    });

    test('vapi.timeout → follows the outgoing edge to the fallback node', async () => {
        mockExecutionAt('ai');
        const twiml = await advance('CA_vapi', 'vapi.timeout', 'test');
        expect(twiml).toContain('FALLBACK_REACHED');
    });
});

describe('renderVapiNode TwiML', () => {
    // Regression: the VAPI <Dial> must carry answerOnBridge="true" (like the
    // queue/transfer dials). Without it Twilio answers the inbound leg and
    // plays ringback while the SIP leg connects; the assistant speaks its
    // firstMessage greeting before the bridge completes, so the caller never
    // hears it and ends up talking first.
    test('VAPI dial sets answerOnBridge so the assistant greeting is not clipped', async () => {
        const vapiGraph = {
            states: [
                { id: 'entry', name: 'Entry', kind: 'branch', config: {} },
                { id: 'ai', name: 'AI Agent', kind: 'vapi_agent', config: { sip_uri: 'sip:blanc-ai@sip.vapi.ai' } },
            ],
            transitions: [
                { id: 'entry-ai', from_state_id: 'entry', to_state_id: 'ai', transitionMode: 'event', event_key: 'node.completed' },
            ],
        };
        const execution = {
            call_sid: 'CA_vapi_bridge',
            company_id: 'company-1',
            group_id: 'ug-1',
            current_node_id: 'entry',
            status: 'active',
            context_json: JSON.stringify({
                graph: vapiGraph,
                groupId: 'ug-1',
                companyId: 'company-1',
                callerNumber: '+15551112222',
                calledNumber: '+16175550100',
                baseUrl: 'https://example.test',
            }),
        };
        mockQuery.mockImplementation(() => ({ rows: [execution] }));

        const twiml = await advance('CA_vapi_bridge', 'node.completed', 'test');
        expect(twiml).toContain('<Sip');
        expect(twiml).toContain('sip:blanc-ai@sip.vapi.ai');
        expect(twiml).toContain('answerOnBridge="true"');
    });
});
