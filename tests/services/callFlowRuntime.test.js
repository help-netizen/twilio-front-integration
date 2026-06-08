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
const groupRouting = require('../../backend/src/services/groupRouting');
const { buildSoftphoneIdentity } = require('../../backend/src/services/softphoneIdentity');

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

    test('dials selected phone-enabled company user for user transfer nodes', async () => {
        const targetUserId = 'agent-1';
        const transferGraph = {
            states: [
                { id: 'start', name: 'Start', kind: 'start' },
                {
                    id: 'transfer',
                    name: 'Transfer',
                    kind: 'transfer',
                    config: {
                        target_type: 'user',
                        target_user_id: targetUserId,
                        timeout_sec: 20,
                        caller_id_policy: 'preserve_called_number',
                    },
                },
            ],
            transitions: [
                { id: 'start-transfer', from_state_id: 'start', to_state_id: 'transfer', transitionMode: 'eventless' },
            ],
        };
        const startExecution = {
            call_sid: 'CA_user_transfer',
            company_id: 'company-1',
            group_id: 'ug-1',
            current_node_id: 'start',
            status: 'active',
            context_json: JSON.stringify({
                graph: transferGraph,
                groupId: 'ug-1',
                callerNumber: '+15551112222',
                calledNumber: '+16175006181',
                baseUrl: 'https://example.test',
            }),
        };
        const transferExecution = { ...startExecution, current_node_id: 'transfer' };
        const selectRows = [startExecution, transferExecution];

        mockQuery.mockImplementation(sql => {
            if (sql.includes('SELECT * FROM call_flow_executions')) {
                return { rows: [selectRows.shift() || transferExecution] };
            }
            if (sql.includes('FROM company_memberships cm')) {
                return { rows: [{ id: targetUserId, name: 'Agent One', phone_calls_allowed: true }] };
            }
            if (sql.includes('UPDATE call_flow_executions')) {
                return { rows: [transferExecution] };
            }
            return { rows: [] };
        });

        const twiml = await advance('CA_user_transfer', 'node.completed', 'test');

        expect(twiml).toContain('<Dial timeout="20"');
        expect(twiml).toContain(`<Client>${buildSoftphoneIdentity('company-1', targetUserId)}</Client>`);
    });

    test('routes group transfer failures through the outgoing edge', async () => {
        groupRouting.availableAgentsForGroup.mockResolvedValue([]);
        const transferGraph = {
            states: [
                { id: 'start', name: 'Start', kind: 'start' },
                {
                    id: 'transfer',
                    name: 'Transfer',
                    kind: 'transfer',
                    config: {
                        target_type: 'phone_number_group',
                        target_group_id: 'ug-target',
                        timeout_sec: 20,
                        caller_id_policy: 'preserve_called_number',
                    },
                },
                { id: 'vm', name: 'Voicemail', kind: 'voicemail' },
            ],
            transitions: [
                { id: 'start-transfer', from_state_id: 'start', to_state_id: 'transfer', transitionMode: 'eventless' },
                { id: 'transfer-vm', from_state_id: 'transfer', to_state_id: 'vm', transitionMode: 'eventless', label: 'next' },
            ],
        };
        const startExecution = {
            call_sid: 'CA_group_transfer',
            company_id: 'company-1',
            group_id: 'ug-1',
            current_node_id: 'start',
            status: 'active',
            context_json: JSON.stringify({
                graph: transferGraph,
                groupId: 'ug-1',
                groupName: 'Dispatch Team',
                callerNumber: '+15551112222',
                calledNumber: '+16175006181',
                baseUrl: 'https://example.test',
            }),
        };
        const transferExecution = { ...startExecution, current_node_id: 'transfer' };
        const voicemailExecution = {
            ...startExecution,
            current_node_id: 'vm',
            context_json: JSON.stringify({
                ...JSON.parse(startExecution.context_json),
                groupId: 'ug-target',
                groupName: 'After Hours Team',
            }),
        };
        const selectRows = [startExecution, transferExecution, voicemailExecution];

        mockQuery.mockImplementation(sql => {
            if (sql.includes('SELECT * FROM call_flow_executions')) {
                return { rows: [selectRows.shift() || voicemailExecution] };
            }
            if (sql.includes('FROM user_groups')) {
                return { rows: [{ id: 'ug-target', name: 'After Hours Team', company_id: 'company-1' }] };
            }
            if (sql.includes('UPDATE call_flow_executions')) {
                return { rows: [voicemailExecution] };
            }
            return { rows: [] };
        });

        const twiml = await advance('CA_group_transfer', 'node.completed', 'test');

        expect(groupRouting.availableAgentsForGroup).toHaveBeenCalledWith('ug-target', 'company-1', 'test');
        expect(twiml).toContain('<Record');
        expect(twiml).toContain('voicemail.recorded');
    });

    test('resolves VAPI SIP URI from active tenant resource settings', async () => {
        const vapiGraph = {
            states: [
                { id: 'start', name: 'Start', kind: 'start' },
                {
                    id: 'vapi',
                    name: 'VAPI AI Agent',
                    kind: 'vapi_agent',
                    config: { timeout_sec: 45 },
                },
            ],
            transitions: [
                { id: 'start-vapi', from_state_id: 'start', to_state_id: 'vapi', transitionMode: 'eventless' },
            ],
        };
        const startExecution = {
            call_sid: 'CA_vapi',
            company_id: 'company-1',
            group_id: 'ug-1',
            current_node_id: 'start',
            status: 'active',
            context_json: JSON.stringify({
                graph: vapiGraph,
                groupId: 'ug-1',
                callerNumber: '+15551112222',
                calledNumber: '+16175006181',
                baseUrl: 'https://example.test',
                companyId: 'company-1',
            }),
        };
        const vapiExecution = { ...startExecution, current_node_id: 'vapi' };
        const selectRows = [startExecution, vapiExecution];

        mockQuery.mockImplementation(sql => {
            if (sql.includes('SELECT * FROM call_flow_executions')) {
                return { rows: [selectRows.shift() || vapiExecution] };
            }
            if (sql.includes('FROM vapi_tenant_resources r')) {
                return { rows: [{ sip_uri: 'sip:assistant@sip.vapi.ai' }] };
            }
            if (sql.includes('UPDATE call_flow_executions')) {
                return { rows: [vapiExecution] };
            }
            return { rows: [] };
        });

        const twiml = await advance('CA_vapi', 'node.completed', 'test');

        // vapiNode=1 marks the dial action so the handler maps the real
        // DialCallStatus to a vapi.* event (completed → end, failure → edge).
        expect(twiml).toContain('<Dial action="https://example.test/webhooks/twilio/voice-dial-action?vapiNode=1"');
        expect(twiml).toContain('timeLimit="900"');
        expect(twiml).toContain('<Sip>sip:assistant@sip.vapi.ai?');
        expect(twiml).toContain('x-blanc-company-id=company-1');
        expect(twiml).toContain('x-blanc-group-id=ug-1');
    });

    test('routes unconfigured VAPI node through its outgoing edge before audible failure', async () => {
        const vapiGraph = {
            states: [
                { id: 'start', name: 'Start', kind: 'start' },
                { id: 'vapi', name: 'VAPI AI Agent', kind: 'vapi_agent', config: {} },
                { id: 'vm', name: 'Voicemail', kind: 'voicemail' },
            ],
            transitions: [
                { id: 'start-vapi', from_state_id: 'start', to_state_id: 'vapi', transitionMode: 'eventless' },
                {
                    id: 'vapi-vm',
                    from_state_id: 'vapi',
                    to_state_id: 'vm',
                    transitionMode: 'event',
                    event_key: 'vapi.completed vapi.no_target vapi.failed vapi.timeout',
                },
            ],
        };
        const startExecution = {
            call_sid: 'CA_vapi_missing',
            company_id: 'company-1',
            group_id: 'ug-1',
            current_node_id: 'start',
            status: 'active',
            context_json: JSON.stringify({
                graph: vapiGraph,
                groupId: 'ug-1',
                callerNumber: '+15551112222',
                calledNumber: '+16175006181',
                baseUrl: 'https://example.test',
                companyId: 'company-1',
            }),
        };
        const vapiExecution = { ...startExecution, current_node_id: 'vapi' };
        const voicemailExecution = { ...startExecution, current_node_id: 'vm' };
        const selectRows = [startExecution, vapiExecution, voicemailExecution];

        mockQuery.mockImplementation(sql => {
            if (sql.includes('SELECT * FROM call_flow_executions')) {
                return { rows: [selectRows.shift() || voicemailExecution] };
            }
            if (sql.includes('FROM vapi_tenant_resources r')) {
                return { rows: [] };
            }
            if (sql.includes('UPDATE call_flow_executions')) {
                return { rows: [voicemailExecution] };
            }
            return { rows: [] };
        });

        const twiml = await advance('CA_vapi_missing', 'node.completed', 'test');

        expect(twiml).toContain('<Record');
        expect(twiml).not.toContain('AI agent is not configured');
    });
});
