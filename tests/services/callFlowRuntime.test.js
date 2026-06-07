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

describe('F017 callFlowRuntime branch insertion metadata recovery', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('routes after-hours branch to inserted transfer edge even when edge metadata was lost', async () => {
        const branchGraph = {
            states: [
                { id: 'hours', name: 'Hours Check', kind: 'branch' },
                { id: 'queue', name: 'Queue', kind: 'queue' },
                {
                    id: 'transfer',
                    name: 'Transfer',
                    kind: 'transfer',
                    config: {
                        target_type: 'external_number',
                        target_external_number: '7743831412',
                        timeout_sec: 20,
                        caller_id_policy: 'preserve_called_number',
                    },
                },
                { id: 'vm-after', name: 'Voicemail', kind: 'voicemail' },
            ],
            transitions: [
                {
                    id: 'business',
                    from_state_id: 'hours',
                    to_state_id: 'queue',
                    label: 'Business Hours',
                    transitionMode: 'conditional',
                    condExpr: 'isBusinessHours === true',
                },
                {
                    id: 'after',
                    from_state_id: 'hours',
                    to_state_id: 'transfer',
                    label: 'After Hours',
                },
                {
                    id: 'transfer-next',
                    from_state_id: 'transfer',
                    to_state_id: 'vm-after',
                    label: 'next',
                },
            ],
        };
        const branchExecution = {
            call_sid: 'CA_after_hours',
            company_id: 'company-1',
            group_id: 'ug-1',
            current_node_id: 'hours',
            status: 'active',
            context_json: JSON.stringify({
                graph: branchGraph,
                isBusinessHours: false,
                groupId: 'ug-1',
                callerNumber: '+15551112222',
                calledNumber: '+16175006181',
                baseUrl: 'https://example.test',
            }),
        };
        const transferExecution = {
            ...branchExecution,
            current_node_id: 'transfer',
        };
        const selectRows = [branchExecution, transferExecution];

        mockQuery.mockImplementation(sql => {
            if (sql.includes('SELECT * FROM call_flow_executions')) {
                return { rows: [selectRows.shift() || transferExecution] };
            }
            if (sql.includes('UPDATE call_flow_executions')) {
                return { rows: [transferExecution] };
            }
            return { rows: [] };
        });

        const twiml = await advance('CA_after_hours', 'node.completed', 'test');

        expect(twiml).toContain('<Dial timeout="20"');
        expect(twiml).toContain('callerId="+16175006181"');
        expect(twiml).toContain('<Number>+17743831412</Number>');
    });
});
