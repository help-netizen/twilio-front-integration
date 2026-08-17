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
const mockReserveInboundSession = jest.fn();
jest.mock('../../backend/src/services/vapiCallIdentityService', () => ({
    TOKEN_HEADER: 'x-albusto-call-token',
    reserveInboundSession: (...args) => mockReserveInboundSession(...args),
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
        const twiml = await advance('CA_vapi', 'vapi.completed', 'test', 'company-1');
        expect(twiml).toContain('<Hangup');
        expect(twiml).not.toContain('FALLBACK_REACHED');
        // status set to completed via an UPDATE carrying 'completed'
        const sawCompleted = mockQuery.mock.calls.some(([sql, params]) =>
            /UPDATE call_flow_executions/.test(sql) && Array.isArray(params) && params.includes('completed'));
        expect(sawCompleted).toBe(true);
    });

    test('vapi.failed → follows the outgoing edge to the fallback node', async () => {
        mockExecutionAt('ai');
        const twiml = await advance('CA_vapi', 'vapi.failed', 'test', 'company-1');
        expect(twiml).toContain('FALLBACK_REACHED');
    });

    test('vapi.timeout → follows the outgoing edge to the fallback node', async () => {
        mockExecutionAt('ai');
        const twiml = await advance('CA_vapi', 'vapi.timeout', 'test', 'company-1');
        expect(twiml).toContain('FALLBACK_REACHED');
    });
});

describe('advance() — VAPI-AGENCY-001 durable inbound reservation', () => {
    const inboundGraph = {
        states: [
            { id: 'start', kind: 'start' },
            {
                id: 'ai',
                kind: 'vapi_agent',
                config: {
                    purpose: 'inbound_call',
                    environment: 'prod',
                    sip_uri: 'sip:caller-controlled@sip.vapi.ai',
                    assistantId: 'caller-controlled-assistant',
                },
            },
            { id: 'fb', kind: 'greeting', config: { text: 'SAFE_FALLBACK' } },
        ],
        transitions: [
            { id: 'start-ai', from_state_id: 'start', to_state_id: 'ai', transitionMode: 'eventless' },
            {
                id: 'ai-fb',
                from_state_id: 'ai',
                to_state_id: 'fb',
                transitionMode: 'event',
                event_key: 'vapi.no_target vapi.failed vapi.timeout',
            },
        ],
    };

    function wireInboundExecution() {
        const base = {
            id: 'execution-vapi-identity',
            call_sid: 'CA_parent_shared',
            company_id: '00000000-0000-4000-8000-00000000000a',
            group_id: 'group-a',
            current_node_id: 'start',
            status: 'active',
            context_json: JSON.stringify({
                graph: inboundGraph,
                baseUrl: 'https://example.test',
            }),
        };
        let current = base;
        mockQuery.mockImplementation(async (sql, params) => {
            if (sql.includes('SELECT * FROM call_flow_executions')) {
                return { rows: [{ ...current }] };
            }
            if (sql.includes('UPDATE call_flow_executions')) {
                current = {
                    ...current,
                    current_node_id: params[2] || current.current_node_id,
                    context_json: params[3] || current.context_json,
                    status: params[4] || current.status,
                };
                return { rows: [{ ...current }] };
            }
            return { rows: [] };
        });
    }

    beforeEach(() => {
        jest.clearAllMocks();
        wireInboundExecution();
    });

    test('creates the session reservation before emitting Sip and exposes only the opaque token', async () => {
        mockReserveInboundSession.mockResolvedValue({
            sessionId: 'session-a',
            correlationToken: 'opaque-token-a',
            sipUri: 'sip:registry-owned@sip.vapi.ai',
        });

        const twiml = await advance(
            'CA_parent_shared',
            'node.completed',
            'trace-a',
            '00000000-0000-4000-8000-00000000000a',
        );

        expect(mockReserveInboundSession).toHaveBeenCalledWith({
            companyId: '00000000-0000-4000-8000-00000000000a',
            twilioParentCallSid: 'CA_parent_shared',
            flowExecutionId: 'execution-vapi-identity',
            flowNodeId: 'ai',
            purpose: 'inbound_call',
            environment: 'prod',
        });
        expect(twiml).toContain('sip:registry-owned@sip.vapi.ai?x-albusto-call-token=opaque-token-a');
        expect(twiml).not.toContain('caller-controlled');
        expect(twiml).not.toContain('company-id');
        expect(twiml).not.toContain('group-id');
        expect(twiml).not.toContain('CA_parent_shared');
    });

    // Paid for in production on 2026-08-17: the owner rang the office and heard the
    // voicemail branch. A missing assistant-registry row refused the reservation and
    // the caller was dropped onto the failure edge. Not being able to attribute a
    // call's cost must never stop us answering the phone.
    test('reservation refusal still dials the assistant, unattributed', async () => {
        mockReserveInboundSession.mockRejectedValue(
            Object.assign(new Error('tuple unavailable'), {
                code: 'VAPI_IDENTITY_TUPLE_UNAVAILABLE',
            }),
        );
        const wired = mockQuery.getMockImplementation();
        mockQuery.mockImplementation(async (sql, params) => (
            String(sql).includes('vapi_tenant_resources')
                ? { rows: [{ sip_uri: 'sip:tenant-a@sip.vapi.ai' }] }
                : wired(sql, params)
        ));

        const twiml = await advance(
            'CA_parent_shared',
            'node.completed',
            'trace-a',
            '00000000-0000-4000-8000-00000000000a',
        );

        expect(twiml).toContain('<Sip');
        expect(twiml).toContain('sip:tenant-a@sip.vapi.ai');
        expect(twiml).not.toContain('SAFE_FALLBACK');
        // Unattributed means no correlation token on the wire — assistant-request
        // refuses an absent token, so the call cannot borrow another company's session.
        expect(twiml).not.toContain('x-albusto-call-token');
        // ...and the address is dialled clean, not with a dangling '?'.
        expect(twiml).toContain('>sip:tenant-a@sip.vapi.ai</Sip>');
    });

    test('reservation refusal with no SIP resource at all falls back to voicemail', async () => {
        mockReserveInboundSession.mockRejectedValue(
            Object.assign(new Error('tuple unavailable'), {
                code: 'VAPI_IDENTITY_TUPLE_UNAVAILABLE',
            }),
        );

        const twiml = await advance(
            'CA_parent_shared',
            'node.completed',
            'trace-a',
            '00000000-0000-4000-8000-00000000000a',
        );

        expect(twiml).toContain('SAFE_FALLBACK');
        expect(twiml).not.toContain('<Sip');
    });
});
