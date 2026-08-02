'use strict';

const mockQuery = jest.fn();

jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));

const mcpQueries = require('../backend/src/db/chatgptMcpQueries');
const {
    generateSandboxFixtures,
    projectSandboxTool,
} = require('../apps-runtime/src/sandboxFixtures');

function estimateDbRow(estimate, total) {
    return {
        ...estimate,
        accepted_at: estimate.accepted_at ? new Date(estimate.accepted_at) : null,
        created_at: new Date(estimate.created_at),
        items_count: estimate.items.length,
        order_list_count: estimate.order_list.length,
        _total: total,
    };
}

describe('APP-DATA-001 Phase C production/sandbox projection parity', () => {
    beforeEach(() => jest.clearAllMocks());

    test('list_estimates and get_estimate return the same values and exact shapes', async () => {
        const fixtures = generateSandboxFixtures('estimate-projection-parity', '2026-08-01');
        const approved = fixtures.estimates.filter(estimate => estimate.status === 'approved');
        mockQuery.mockResolvedValueOnce({
            rows: approved.map(estimate => estimateDbRow(estimate, approved.length)),
        });

        const liveList = await mcpQueries.listEstimates(fixtures.company.id, {
            status: 'approved',
            companyTimezone: fixtures.company.timezone,
            limit: 100,
            offset: 0,
        });
        const sandboxList = projectSandboxTool(fixtures, 'svc.list_estimates', {
            status: 'approved',
            limit: 100,
            offset: 0,
        });
        expect(sandboxList).toEqual(liveList);

        const selected = fixtures.estimates[0];
        mockQuery.mockResolvedValueOnce({ rows: [estimateDbRow(selected, 1)] });
        const liveDetail = await mcpQueries.getEstimate(fixtures.company.id, selected.id);
        const sandboxDetail = projectSandboxTool(fixtures, 'svc.get_estimate', {
            estimate_id: selected.id,
        });
        expect(sandboxDetail).toEqual(liveDetail);
        expect(sandboxDetail.order_list).toEqual(expect.arrayContaining([
            expect.objectContaining({
                part_number: 'DA97-07603B',
                part_name: expect.any(String),
                quantity: 1,
            }),
        ]));
    });
});
