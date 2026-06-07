const mockQuery = jest.fn();
jest.mock('../../backend/src/db/connection', () => ({ query: mockQuery }));

const { getCalls } = require('../../backend/src/db/callsQueries');

describe('F017 callsQueries routing log enrichment', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockQuery.mockResolvedValue({ rows: [] });
    });

    test('getCalls joins call_flow_executions and filters by group_id', async () => {
        await getCalls({ companyId: 'company-1', groupId: 'ug-1', rootOnly: true, limit: 25 });

        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toContain('call_flow_executions');
        expect(sql).toContain('cfe.group_id');
        expect(sql).toContain('routing_group_name');
        expect(params).toContain('company-1');
        expect(params).toContain('ug-1');
    });
});
