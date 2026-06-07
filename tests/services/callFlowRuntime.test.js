const mockQuery = jest.fn();
jest.mock('../../backend/src/db/connection', () => ({ query: mockQuery }));

const mockBroadcast = jest.fn();
const mockPublishCallUpdate = jest.fn();
jest.mock('../../backend/src/services/realtimeService', () => ({
    broadcast: (...args) => mockBroadcast(...args),
    publishCallUpdate: (...args) => mockPublishCallUpdate(...args),
}));

jest.mock('../../backend/src/services/groupRouting', () => ({
    availableAgentsForGroup: jest.fn(),
    isBusinessHours: jest.fn(),
}));

const { advance } = require('../../backend/src/services/callFlowRuntime');

const graph = {
    states: [
        { id: 'vm', name: 'Voicemail', kind: 'voicemail' },
        { id: 'done', name: 'Done', kind: 'final' },
    ],
    transitions: [
        {
            id: 'vm-done',
            from_state_id: 'vm',
            to_state_id: 'done',
            transitionMode: 'event',
            event_key: 'voicemail.recorded voicemail.completed',
        },
    ],
};

describe('F017 callFlowRuntime voicemail completion', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        const vmExecution = {
            call_sid: 'CA_vm',
            company_id: 'company-1',
            group_id: 'ug-1',
            current_node_id: 'vm',
            status: 'voicemail',
            context_json: JSON.stringify({
                graph,
                groupId: 'ug-1',
                callerNumber: '+15551112222',
                calledNumber: '+16175550100',
            }),
        };
        const finalExecution = {
            ...vmExecution,
            current_node_id: 'done',
            status: 'active',
        };
        const selectRows = [vmExecution, finalExecution];

        mockQuery.mockImplementation(sql => {
            if (sql.includes('SELECT * FROM call_flow_executions')) {
                return { rows: [selectRows.shift() || finalExecution] };
            }
            if (sql.includes('UPDATE call_flow_executions')) {
                return { rows: [finalExecution] };
            }
            if (sql.includes('UPDATE calls')) {
                return {
                    rows: [{
                        call_sid: 'CA_vm',
                        company_id: 'company-1',
                        status: 'voicemail_left',
                        is_final: true,
                    }],
                };
            }
            return { rows: [] };
        });
    });

    test('advances voicemail.recorded from voicemail status and finalizes the call', async () => {
        const twiml = await advance('CA_vm', 'voicemail.recorded', 'test');

        expect(twiml).toContain('<Hangup');
        expect(mockQuery).toHaveBeenCalledWith(
            expect.stringContaining("status = 'voicemail_left'"),
            ['CA_vm', 'company-1']
        );
        expect(mockBroadcast).toHaveBeenCalledWith('group.call.voicemail', expect.objectContaining({
            call_sid: 'CA_vm',
            group_id: 'ug-1',
        }));
        expect(mockPublishCallUpdate).toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'call.updated',
            call_sid: 'CA_vm',
            status: 'voicemail_left',
            is_final: true,
        }));
    });
});
