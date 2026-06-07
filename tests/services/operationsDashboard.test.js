const mockQuery = jest.fn();
jest.mock('../../backend/src/db/connection', () => ({ query: mockQuery }));

const mockGetPresenceSnapshot = jest.fn();
jest.mock('../../backend/src/services/agentPresence', () => ({
    getPresenceSnapshot: (...args) => mockGetPresenceSnapshot(...args),
}));

const { getOperationsDashboard, flowPathFromContext } = require('../../backend/src/services/operationsDashboard');

const graph = {
    states: [
        { id: 'start', name: 'Start', kind: 'start', isInitial: true },
        { id: 'hours', name: 'Hours Check', kind: 'branch' },
        { id: 'queue', name: 'Queue', kind: 'queue' },
        { id: 'vm', name: 'Voicemail', kind: 'voicemail' },
    ],
    transitions: [
        { from_state_id: 'start', to_state_id: 'hours' },
        { from_state_id: 'hours', to_state_id: 'queue' },
        { from_state_id: 'queue', to_state_id: 'vm' },
    ],
};

describe('F017 operationsDashboard', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetPresenceSnapshot.mockResolvedValue(new Map([
            ['agent-available', 'available'],
            ['agent-offline', 'offline'],
            ['agent-on-call', 'on_call'],
        ]));

        mockQuery.mockImplementation(sql => {
            if (sql.includes('FROM user_groups ug') && sql.includes('user_group_members')) {
                return {
                    rows: [
                        { group_id: 'ug-1', group_name: 'Dispatch', user_id: 'agent-available', user_name: 'Available Agent', phone_calls_allowed: true },
                        { group_id: 'ug-1', group_name: 'Dispatch', user_id: 'agent-offline', user_name: 'Offline Agent', phone_calls_allowed: true },
                        { group_id: 'ug-2', group_name: 'Support', user_id: 'agent-on-call', user_name: 'On Call Agent', phone_calls_allowed: true },
                    ],
                };
            }
            if (sql.includes('FROM call_flow_executions cfe')) {
                return {
                    rows: [
                        {
                            call_sid: 'CA_queued',
                            group_id: 'ug-1',
                            group_name: 'Dispatch',
                            current_node_id: 'queue',
                            context_json: JSON.stringify({ graph, callerNumber: '+15550001', calledNumber: '+16170001' }),
                            execution_status: 'active',
                            execution_created_at: new Date(Date.now() - 10_000).toISOString(),
                            from_number: '+15550001',
                            to_number: '+16170001',
                            status: 'ringing',
                            is_final: false,
                            started_at: new Date(Date.now() - 10_000).toISOString(),
                            answered_at: null,
                        },
                        {
                            call_sid: 'CA_live',
                            group_id: 'ug-1',
                            group_name: 'Dispatch',
                            current_node_id: 'queue',
                            context_json: JSON.stringify({ graph, callerNumber: '+15550002', calledNumber: '+16170001' }),
                            execution_status: 'active',
                            execution_created_at: new Date(Date.now() - 30_000).toISOString(),
                            from_number: '+15550002',
                            to_number: '+16170001',
                            status: 'in-progress',
                            is_final: false,
                            started_at: new Date(Date.now() - 30_000).toISOString(),
                            answered_at: new Date(Date.now() - 20_000).toISOString(),
                        },
                    ],
                };
            }
            return { rows: [] };
        });
    });

    test('groups active calls and queued calls by user group with reachability', async () => {
        const data = await getOperationsDashboard('company-1');

        const dispatch = data.groups.find(group => group.id === 'ug-1');
        const support = data.groups.find(group => group.id === 'ug-2');

        expect(dispatch.reachable).toBe(true);
        expect(dispatch.active_calls).toHaveLength(1);
        expect(dispatch.queued_calls).toHaveLength(1);
        expect(dispatch.queued_calls[0].flow_path).toEqual(['Start', 'Hours Check', 'Queue']);
        expect(support.reachable).toBe(false);
        expect(data.queue[0]).toEqual(expect.objectContaining({
            call_sid: 'CA_queued',
            group_id: 'ug-1',
            queue_name: 'Dispatch',
            priority: 'normal',
        }));
        expect(mockGetPresenceSnapshot).toHaveBeenCalledWith(
            ['agent-available', 'agent-offline', 'agent-on-call'],
            'company-1'
        );
    });

    test('flowPathFromContext returns a readable path to current node', () => {
        expect(flowPathFromContext({ graph }, 'vm', 'active')).toEqual(['Start', 'Hours Check', 'Queue', 'Voicemail']);
    });
});
