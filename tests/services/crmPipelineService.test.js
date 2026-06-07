jest.mock('../../backend/src/db/crmDealsQueries', () => ({
    getPipelineDeals: jest.fn(),
    getDealHistorySince: jest.fn(),
    getPipelineStages: jest.fn(),
    getForecastCategories: jest.fn(),
    getLatestPipelineSnapshotBefore: jest.fn(),
}));

const dealsQueries = require('../../backend/src/db/crmDealsQueries');
const pipelineService = require('../../backend/src/services/crmPipelineService');

describe('crmPipelineService', () => {
    beforeEach(() => jest.clearAllMocks());

    test('calculateTotals computes total and weighted pipeline', () => {
        const totals = pipelineService.calculateTotals([
            { amount: '1000', probability: 50, forecast_category: 'commit' },
            { amount: '500', probability: 20, forecast_category: 'best_case' },
            { amount: null, probability: 90, forecast_category: 'pipeline' },
        ]);

        expect(totals).toEqual({
            count: 3,
            pipeline: 1500,
            weighted_pipeline: 600,
            commit: 1000,
            best_case: 500,
            forecast_pipeline: 0,
            omitted: 0,
            forecast_categories: {
                commit: 1000,
                best_case: 500,
                pipeline: 0,
                omitted: 0,
            },
        });
    });

    test('calculateTotals separates total pipeline from forecast pipeline category', () => {
        const totals = pipelineService.calculateTotals([
            { amount: '1000', probability: 50, forecast_category: 'pipeline' },
            { amount: '200', probability: 10, forecast_category: 'omitted' },
        ]);

        expect(totals.pipeline).toBe(1200);
        expect(totals.forecast_pipeline).toBe(1000);
        expect(totals.omitted).toBe(200);
        expect(totals.forecast_categories.pipeline).toBe(1000);
    });

    test('summarizeSlippage detects pushed close date, decreased amount, and stage changes', () => {
        const slippage = pipelineService.summarizeSlippage([
            { deal_id: 1, deal_name: 'A', field_name: 'close_date', old_value: '2026-06-01', new_value: '2026-07-01' },
            { deal_id: 1, deal_name: 'A', field_name: 'amount', old_value: '1000', new_value: '800' },
            { deal_id: 2, deal_name: 'B', field_name: 'stage', old_value: 'proposal', new_value: 'discovery' },
            { deal_id: 3, deal_name: 'C', field_name: 'stage', old_value: 'discovery', new_value: 'proposal' },
        ], { discovery: 20, proposal: 30 });

        expect(slippage).toHaveLength(2);
        expect(slippage[0]).toMatchObject({ deal_id: 1, close_date_pushed: true, amount_decreased: true });
        expect(slippage[1]).toMatchObject({ deal_id: 2, stage_regressed: true });
        expect(slippage.find(item => item.deal_id === 3)).toBeUndefined();
    });

    test('summarizeChanges reports last-week pipeline deltas', () => {
        const summary = pipelineService.summarizeChanges([
            { field_name: 'amount', old_value: '1000', new_value: '800' },
            { field_name: 'amount', old_value: '100', new_value: '150' },
            { field_name: 'close_date', old_value: '2026-06-01', new_value: '2026-07-01' },
            { field_name: 'stage', old_value: 'discovery', new_value: 'proposal' },
        ]);

        expect(summary).toMatchObject({
            event_count: 4,
            amount_delta: -150,
            close_date_pushes: 1,
            amount_decreases: 1,
            stage_changes: 1,
        });
    });

    test('getPipeline groups by stage and forecast category', async () => {
        dealsQueries.getPipelineDeals.mockResolvedValue([
            { id: 1, amount: 100, probability: 50, stage: 'proposal', stage_order: 30, forecast_category: 'commit', currency: 'USD' },
            { id: 2, amount: 200, probability: 25, stage: 'proposal', stage_order: 30, forecast_category: 'pipeline', currency: 'USD', risk_summary: 'No champion' },
        ]);
        dealsQueries.getDealHistorySince.mockResolvedValue([
            { deal_id: 1, field_name: 'amount', old_value: '100', new_value: '80' },
        ]);
        dealsQueries.getPipelineStages.mockResolvedValue([
            { stage_key: 'proposal', display_order: 30 },
        ]);
        dealsQueries.getForecastCategories.mockResolvedValue([
            { category_key: 'commit', display_order: 10 },
            { category_key: 'pipeline', display_order: 30 },
        ]);
        dealsQueries.getLatestPipelineSnapshotBefore.mockResolvedValue({
            id: 5,
            snapshot_week_start: '2026-05-25',
            totals: { pipeline: 250, weighted_pipeline: 100, commit: 50, best_case: 0, forecast_pipeline: 200, omitted: 0 },
        });

        const result = await pipelineService.getPipeline('company-1', { period_start: '2026-06-01' });

        expect(result.totals.pipeline).toBe(300);
        expect(result.totals.forecast_pipeline).toBe(200);
        expect(result.by_stage[0]).toMatchObject({ key: 'proposal', count: 2, amount: 300 });
        expect(result.by_forecast_category.map(g => g.key)).toEqual(['commit', 'pipeline']);
        expect(result.risky_deals).toHaveLength(1);
        expect(result.change_summary.amount_delta).toBe(-20);
        expect(dealsQueries.getPipelineDeals).toHaveBeenCalledWith('company-1', { period_start: '2026-06-01' });
        expect(dealsQueries.getDealHistorySince).toHaveBeenCalledWith(
            'company-1',
            expect.any(String),
            { period_start: '2026-06-01' }
        );
        expect(result.snapshot_comparison.deltas.pipeline).toBe(50);
        expect(result.snapshot_comparison.deltas.forecast_pipeline).toBe(0);
    });

    test('pipeline analytic views return focused response shapes', async () => {
        dealsQueries.getPipelineDeals.mockResolvedValue([
            { id: 1, amount: 100, probability: 50, stage: 'proposal', forecast_category: 'commit', currency: 'USD', blocker_summary: 'Security' },
        ]);
        dealsQueries.getDealHistorySince.mockResolvedValue([
            { deal_id: 1, deal_name: 'A', field_name: 'close_date', old_value: '2026-06-01', new_value: '2026-07-01' },
        ]);
        dealsQueries.getPipelineStages.mockResolvedValue([{ stage_key: 'proposal', display_order: 30 }]);
        dealsQueries.getForecastCategories.mockResolvedValue([{ category_key: 'commit', display_order: 10 }]);
        dealsQueries.getLatestPipelineSnapshotBefore.mockResolvedValue(null);

        await expect(pipelineService.getPipelineStageGroups('company-1', { owner_user_id: 'user-1' }))
            .resolves.toMatchObject({ by_stage: [expect.objectContaining({ key: 'proposal' })] });
        await expect(pipelineService.getPipelineForecastGroups('company-1', { owner_user_id: 'user-1' }))
            .resolves.toMatchObject({ by_forecast_category: [expect.objectContaining({ key: 'commit' })] });
        await expect(pipelineService.getForecastTotals('company-1', { owner_user_id: 'user-1' }))
            .resolves.toMatchObject({ totals: expect.objectContaining({ commit: 100 }) });
        await expect(pipelineService.getPipelineChanges('company-1', { owner_user_id: 'user-1' }))
            .resolves.toMatchObject({ change_summary: expect.objectContaining({ close_date_pushes: 1 }) });
        await expect(pipelineService.getPipelineRiskyDeals('company-1', { owner_user_id: 'user-1' }))
            .resolves.toMatchObject({ risky_deals: [expect.objectContaining({ id: 1 })] });
        await expect(pipelineService.getPipelineSlippage('company-1', { owner_user_id: 'user-1' }))
            .resolves.toMatchObject({ slippage: [expect.objectContaining({ close_date_pushed: true })] });
    });

    test('forecast category groups follow metadata order', async () => {
        dealsQueries.getPipelineDeals.mockResolvedValue([
            { id: 1, amount: 100, probability: 50, stage: 'proposal', forecast_category: 'pipeline', currency: 'USD' },
            { id: 2, amount: 100, probability: 50, stage: 'proposal', forecast_category: 'commit', currency: 'USD' },
            { id: 3, amount: 100, probability: 50, stage: 'proposal', forecast_category: 'best_case', currency: 'USD' },
        ]);
        dealsQueries.getDealHistorySince.mockResolvedValue([]);
        dealsQueries.getPipelineStages.mockResolvedValue([{ stage_key: 'proposal', display_order: 30 }]);
        dealsQueries.getForecastCategories.mockResolvedValue([
            { category_key: 'commit', display_order: 10 },
            { category_key: 'best_case', display_order: 20 },
            { category_key: 'pipeline', display_order: 30 },
        ]);
        dealsQueries.getLatestPipelineSnapshotBefore.mockResolvedValue(null);

        const result = await pipelineService.getPipelineForecastGroups('company-1');

        expect(result.by_forecast_category.map(group => group.key)).toEqual(['commit', 'best_case', 'pipeline']);
    });
});
