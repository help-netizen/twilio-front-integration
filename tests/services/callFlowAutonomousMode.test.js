// TELEPHONY-AUTONOMOUS-MODE-001 — startExecution override.
//
// When company-wide Autonomous mode is ON, startExecution must force
// context.isBusinessHours = false (so the flow takes the after_hours edge)
// regardless of the group's real hours. When OFF (default), the real
// groupRouting.isBusinessHours result is preserved unchanged.

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

const { startExecution } = require('../../backend/src/services/callFlowRuntime');
const groupRouting = require('../../backend/src/services/groupRouting');
const telephonyTenantService = require('../../backend/src/services/telephonyTenantService');

// start → branch → business_hours (greeting "BUSINESS") | after_hours (greeting "AFTERHOURS")
const graph = {
    states: [
        { id: 'start', name: 'Start', kind: 'start' },
        { id: 'hours', name: 'Hours Check', kind: 'branch' },
        { id: 'biz', name: 'Business', kind: 'greeting', config: { text: 'BUSINESS' } },
        { id: 'after', name: 'After Hours', kind: 'greeting', config: { text: 'AFTERHOURS' } },
    ],
    transitions: [
        { id: 'start-hours', from_state_id: 'start', to_state_id: 'hours', transitionMode: 'eventless' },
        { id: 'b', from_state_id: 'hours', to_state_id: 'biz', label: 'Business Hours', edgeRole: 'business_hours' },
        { id: 'a', from_state_id: 'hours', to_state_id: 'after', label: 'After Hours', edgeRole: 'after_hours' },
    ],
};

const flow = { id: 'flow-1', graph, updated_at: '2026-06-30T00:00:00Z' };
const group = { id: 'ug-1', name: 'Front Desk', company_id: 'company-1', timezone: 'America/New_York' };

// Capture the context_json written by the INSERT so we can assert on
// isBusinessHours, and echo the row back so renderNodeById can proceed.
function wireDb() {
    let insertedContext = null;
    mockQuery.mockImplementation((sql, params) => {
        if (sql.includes('INSERT INTO call_flow_executions')) {
            insertedContext = JSON.parse(params[6]);
            return {
                rows: [{
                    id: 'cfe-1',
                    company_id: 'company-1',
                    call_sid: params[2],
                    group_id: 'ug-1',
                    flow_id: 'flow-1',
                    current_node_id: 'start',
                    status: 'active',
                    context_json: params[6],
                }],
            };
        }
        if (sql.includes('SELECT * FROM call_flow_executions')) {
            return {
                rows: [{
                    call_sid: 'CA_test',
                    company_id: 'company-1',
                    group_id: 'ug-1',
                    current_node_id: 'start',
                    status: 'active',
                    context_json: JSON.stringify(insertedContext),
                }],
            };
        }
        return { rows: [] };
    });
    return () => insertedContext;
}

describe('TELEPHONY-AUTONOMOUS-MODE-001 startExecution override', () => {
    beforeEach(() => jest.clearAllMocks());

    test('autonomous ON forces after-hours even during business hours', async () => {
        telephonyTenantService.getAutonomousMode.mockResolvedValue(true);
        groupRouting.isBusinessHours.mockResolvedValue(true); // real hours say OPEN
        const getContext = wireDb();

        const twiml = await startExecution({
            callSid: 'CA_test', fromNumber: '+15551112222', toNumber: '+16175006181',
            group, flow, baseUrl: 'https://example.test', traceId: 'test',
        });

        expect(telephonyTenantService.getAutonomousMode).toHaveBeenCalledWith('company-1');
        // Override wins: isBusinessHours persisted as false and the after-hours edge is taken.
        expect(getContext().isBusinessHours).toBe(false);
        expect(twiml).toContain('AFTERHOURS');
        expect(twiml).not.toContain('BUSINESS');
    });

    test('autonomous ON short-circuits the real hours check (never queries hours)', async () => {
        telephonyTenantService.getAutonomousMode.mockResolvedValue(true);
        groupRouting.isBusinessHours.mockResolvedValue(true);
        wireDb();

        await startExecution({
            callSid: 'CA_test', fromNumber: '+15551112222', toNumber: '+16175006181',
            group, flow, baseUrl: 'https://example.test', traceId: 'test',
        });

        // Short-circuit: `autonomous ? false : await isBusinessHours(group)` must not evaluate the RHS.
        expect(groupRouting.isBusinessHours).not.toHaveBeenCalled();
    });

    test('autonomous OFF (default) preserves real business-hours routing', async () => {
        telephonyTenantService.getAutonomousMode.mockResolvedValue(false);
        groupRouting.isBusinessHours.mockResolvedValue(true); // real hours say OPEN
        const getContext = wireDb();

        const twiml = await startExecution({
            callSid: 'CA_test', fromNumber: '+15551112222', toNumber: '+16175006181',
            group, flow, baseUrl: 'https://example.test', traceId: 'test',
        });

        expect(groupRouting.isBusinessHours).toHaveBeenCalledWith(group);
        expect(getContext().isBusinessHours).toBe(true);
        expect(twiml).toContain('BUSINESS');
        expect(twiml).not.toContain('AFTERHOURS');
    });

    test('autonomous OFF with real after-hours still routes after-hours (unchanged behavior)', async () => {
        telephonyTenantService.getAutonomousMode.mockResolvedValue(false);
        groupRouting.isBusinessHours.mockResolvedValue(false); // real hours say CLOSED
        const getContext = wireDb();

        const twiml = await startExecution({
            callSid: 'CA_test', fromNumber: '+15551112222', toNumber: '+16175006181',
            group, flow, baseUrl: 'https://example.test', traceId: 'test',
        });

        expect(getContext().isBusinessHours).toBe(false);
        expect(twiml).toContain('AFTERHOURS');
    });

    // The real system routes the hours fork via condExpr (chooseConditionalEdge
    // evaluates `isBusinessHours === false`), NOT the edgeRole/branchKey fallback
    // the other cases exercise. Prove the forced flag drives the condExpr edge too.
    test('autonomous ON drives the after_hours edge selected via condExpr', async () => {
        const condGraph = {
            states: [
                { id: 'start', name: 'Start', kind: 'start' },
                { id: 'hours', name: 'Hours Check', kind: 'branch' },
                { id: 'biz', name: 'Business', kind: 'greeting', config: { text: 'BUSINESS' } },
                { id: 'after', name: 'After Hours', kind: 'greeting', config: { text: 'AFTERHOURS' } },
            ],
            transitions: [
                { id: 'start-hours', from_state_id: 'start', to_state_id: 'hours', transitionMode: 'eventless' },
                {
                    id: 'b', from_state_id: 'hours', to_state_id: 'biz',
                    label: 'Business Hours', transitionMode: 'conditional',
                    condExpr: 'isBusinessHours === true',
                },
                {
                    id: 'a', from_state_id: 'hours', to_state_id: 'after',
                    label: 'After Hours', transitionMode: 'conditional',
                    condExpr: 'isBusinessHours === false',
                },
            ],
        };
        const condFlow = { id: 'flow-cond', graph: condGraph, updated_at: '2026-06-30T00:00:00Z' };

        telephonyTenantService.getAutonomousMode.mockResolvedValue(true);
        groupRouting.isBusinessHours.mockResolvedValue(true); // real hours say OPEN
        const getContext = wireDb();

        const twiml = await startExecution({
            callSid: 'CA_test', fromNumber: '+15551112222', toNumber: '+16175006181',
            group, flow: condFlow, baseUrl: 'https://example.test', traceId: 'test',
        });

        // Forced flag → condExpr `isBusinessHours === false` matches → after-hours edge.
        expect(getContext().isBusinessHours).toBe(false);
        expect(twiml).toContain('AFTERHOURS');
        expect(twiml).not.toContain('BUSINESS');
    });
});
