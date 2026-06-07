const mockClient = {
    query: jest.fn(),
    release: jest.fn(),
};

jest.mock('../../backend/src/db/connection', () => ({
    pool: {
        connect: jest.fn(() => Promise.resolve(mockClient)),
    },
}));

jest.mock('../../backend/src/db/crmDealsQueries', () => ({
    getDealById: jest.fn(),
    getDealHistory: jest.fn(),
    updateDealField: jest.fn(),
    getDealsWithoutNextStep: jest.fn(),
    getOverdueCloseDateDeals: jest.fn(),
    getDealsWithoutActivity: jest.fn(),
    getDealsClosingBetween: jest.fn(),
}));

jest.mock('../../backend/src/services/crmMetadataService', () => ({
    getMetadata: jest.fn(),
}));

jest.mock('../../backend/src/services/crmWriteAuditService', () => ({
    logFieldUpdate: jest.fn(),
}));

const dealsQueries = require('../../backend/src/db/crmDealsQueries');
const metadataService = require('../../backend/src/services/crmMetadataService');
const writeAuditService = require('../../backend/src/services/crmWriteAuditService');
const dealsService = require('../../backend/src/services/crmDealsService');

describe('crmDealsService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockClient.query.mockResolvedValue({ rows: [] });
        mockClient.release.mockReset();
        metadataService.getMetadata.mockResolvedValue({
            pipeline_stages: [{ stage_key: 'proposal' }],
            forecast_categories: [{ category_key: 'commit' }],
        });
    });

    test('rejects disallowed fields before opening a transaction', async () => {
        await expect(dealsService.updateDeal('company-1', 7, { owner_user_id: 'user-2' }))
            .rejects.toMatchObject({ code: 'BAD_REQUEST' });

        expect(dealsQueries.updateDealField).not.toHaveBeenCalled();
    });

    test('requires exactly one allowed field per update', async () => {
        await expect(dealsService.updateDeal('company-1', 7, { next_step: 'A', amount: 100 }))
            .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    test('updates allowed field with before/after and audit in transaction', async () => {
        dealsQueries.updateDealField.mockResolvedValue({
            row: { id: 7, next_step: 'New' },
            before: 'Old',
            after: 'New',
        });

        const result = await dealsService.updateDeal(
            'company-1',
            7,
            { next_step: 'New' },
            {
                actorId: 'user-1',
                actorEmail: 'seller@test.local',
                requestId: 'req-1',
                confirmation: { confirmationId: 'confirm-1', reason: 'Forecast review' },
            }
        );

        expect(result).toMatchObject({ field: 'next_step', before: 'Old', after: 'New' });
        expect(mockClient.query.mock.calls[0][0]).toBe('BEGIN');
        expect(dealsQueries.updateDealField).toHaveBeenCalledWith(
            'company-1',
            7,
            'next_step',
            'New',
            'user-1',
            'Codex/Sales MCP',
            'req-1',
            mockClient
        );
        expect(writeAuditService.logFieldUpdate).toHaveBeenCalledWith(expect.objectContaining({
            companyId: 'company-1',
            entityType: 'deal',
            entityId: 7,
            field: 'deal.next_step',
            before: 'Old',
            after: 'New',
            confirmation: { confirmationId: 'confirm-1', reason: 'Forecast review' },
            client: mockClient,
        }));
        expect(mockClient.query.mock.calls.at(-1)[0]).toBe('COMMIT');
    });

    test('invalid forecast category is rejected', async () => {
        await expect(dealsService.updateDeal('company-1', 7, { forecast_category: 'unknown' }))
            .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    test('empty forecast category clears the field instead of storing an empty value', async () => {
        dealsQueries.updateDealField.mockResolvedValue({
            row: { id: 7, forecast_category: null },
            before: 'best_case',
            after: null,
        });

        const result = await dealsService.updateDeal('company-1', 7, { forecast_category: '' });

        expect(result).toMatchObject({ field: 'forecast_category', before: 'best_case', after: null });
        expect(dealsQueries.updateDealField).toHaveBeenCalledWith(
            'company-1',
            7,
            'forecast_category',
            null,
            undefined,
            'Codex/Sales MCP',
            undefined,
            mockClient
        );
    });

    test('invalid close date is rejected before SQL update', async () => {
        await expect(dealsService.updateDeal('company-1', 7, { close_date: '2026-06-31' }))
            .rejects.toMatchObject({ code: 'BAD_REQUEST' });

        expect(dealsQueries.updateDealField).not.toHaveBeenCalled();
    });

    test('getDealHistory validates deal exists before returning history', async () => {
        dealsQueries.getDealById.mockResolvedValue({ id: 7 });
        dealsQueries.getDealHistory.mockResolvedValue([{ field_name: 'stage' }]);

        const result = await dealsService.getDealHistory('company-1', 7);

        expect(result).toEqual([{ field_name: 'stage' }]);
        expect(dealsQueries.getDealById).toHaveBeenCalledWith('company-1', 7);
        expect(dealsQueries.getDealHistory).toHaveBeenCalledWith('company-1', 7);
    });

    test('getAttentionDeals includes this-week closing deals and uses a 7-day activity window', async () => {
        dealsQueries.getDealsWithoutNextStep.mockResolvedValue([{ id: 1 }]);
        dealsQueries.getOverdueCloseDateDeals.mockResolvedValue([{ id: 2 }]);
        dealsQueries.getDealsWithoutActivity.mockResolvedValue([{ id: 3 }]);
        dealsQueries.getDealsClosingBetween.mockResolvedValue([{ id: 4 }]);

        const result = await dealsService.getAttentionDeals('company-1');

        expect(result.week_start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(result.week_end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(result.closing_this_week).toEqual([{ id: 4 }]);
        expect(dealsQueries.getDealsWithoutActivity).toHaveBeenCalledWith('company-1', 7);
        expect(dealsQueries.getDealsClosingBetween).toHaveBeenCalledWith(
            'company-1',
            result.week_start,
            result.week_end
        );
    });
});
