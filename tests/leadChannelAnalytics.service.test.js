'use strict';

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));

const analytics = require('../backend/src/services/leadChannelAnalyticsService');

const COMPANY_ID = '00000000-0000-4000-8000-000000000212';
const PERIOD = { from: '2026-07-01', to: '2026-07-31' };
const TECH_1 = '00000000-0000-4000-8000-000000000001';
const TECH_2 = '00000000-0000-4000-8000-000000000002';

function cohortFact(overrides = {}) {
    return {
        id: '1',
        converted: true,
        channel_key: 'source_google',
        channel_label: 'Google Ads',
        channel_attributed: true,
        area_key: 'area_downtown',
        area_label: 'Downtown',
        visit_completed: true,
        job_done: true,
        revenue_net_cents: '10000',
        call_cost_cents: '124',
        technicians: [
            { key: TECH_1, label: 'Ada Technician' },
            { key: TECH_2, label: 'Grace Technician' },
            { key: TECH_1, label: 'Ada Technician' },
        ],
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('leadChannelAnalyticsService period validation', () => {
    test.each([
        [{ from: '', to: '2026-07-31' }, 'INVALID_PERIOD'],
        [{ from: '2026-02-30', to: '2026-07-31' }, 'INVALID_PERIOD'],
        [{ from: '2026-08-01', to: '2026-07-31' }, 'INVALID_PERIOD'],
    ])('rejects invalid period %#', (period, code) => {
        expect(() => analytics._parsePeriod(period.from, period.to))
            .toThrow(expect.objectContaining({ code }));
    });

    test('accepts inclusive valid calendar dates', () => {
        expect(analytics._parsePeriod(PERIOD.from, PERIOD.to)).toEqual(PERIOD);
    });

    test('caps the inclusive date range at 731 days', () => {
        const accepted = { from: '2024-01-01', to: '2025-12-31' };
        expect(analytics._parsePeriod(accepted.from, accepted.to))
            .toEqual(accepted);
        expect(() => analytics._parsePeriod('2024-01-01', '2026-01-01'))
            .toThrow(expect.objectContaining({
                code: 'RANGE_TOO_WIDE',
                httpStatus: 400,
            }));
    });
});

describe('leadChannelAnalyticsService response math', () => {
    test('summary returns integer cents and lead-cohort conversion percentages', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ timezone: 'America/New_York' }] })
            .mockResolvedValueOnce({
                rows: [
                    cohortFact(),
                    cohortFact({
                        id: '2',
                        converted: false,
                        visit_completed: false,
                        job_done: false,
                        revenue_net_cents: '0',
                        call_cost_cents: '0',
                        technicians: [],
                    }),
                ],
            });

        const result = await analytics.getSummary(COMPANY_ID, PERIOD);

        expect(result).toEqual({
            kpis: {
                leads: 2,
                converted: 1,
                visit_completed: 1,
                jobs_done: 1,
                revenue_net_cents: 10000,
                call_cost_cents: 124,
                ad_spend_cents: 0,
                roas: null,
                marketing_contribution_cents: 9876,
            },
            funnel: [
                { stage: 'leads', count: 2, conv_pct: 100 },
                { stage: 'converted', count: 1, conv_pct: 50 },
                { stage: 'visit_completed', count: 1, conv_pct: 50 },
                { stage: 'job_is_done', count: 1, conv_pct: 50 },
            ],
            period: {
                ...PERIOD,
                timezone: 'America/New_York',
            },
        });
        expect(mockQuery.mock.calls[0][1][0]).toBe(COMPANY_ID);
        expect(mockQuery.mock.calls[1][1][0]).toBe(COMPANY_ID);
    });

    test('technician split de-duplicates assignees and reconciles exactly', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [cohortFact()] });

        const result = await analytics.getBreakdown(COMPANY_ID, {
            ...PERIOD,
            dimension: 'technician',
        });

        expect(result.rows).toHaveLength(2);
        expect(result.rows.map(row => row.leads)).toEqual([0.5, 0.5]);
        expect(result.rows.map(row => row.jobs_done)).toEqual([0.5, 0.5]);
        expect(result.rows.map(row => row.revenue_net_cents)).toEqual([5000, 5000]);
        expect(result.rows.map(
            row => row.marketing_contribution_cents
        )).toEqual([4938, 4938]);
        expect(result.totals).toMatchObject({
            leads: 1,
            jobs_done: 1,
            revenue_net_cents: 10000,
            marketing_contribution_cents: 9876,
        });
    });

    test('data quality reports mapped coverage and standalone unknown basis', async () => {
        mockQuery
            .mockResolvedValueOnce({
                rows: [
                    cohortFact(),
                    cohortFact({
                        id: '2',
                        channel_key: 'unattributed',
                        channel_label: 'Unattributed',
                        channel_attributed: false,
                    }),
                ],
            })
            .mockResolvedValueOnce({
                rows: [{ tax_basis_unknown_cents: '1234' }],
            });

        await expect(
            analytics.getDataQuality(COMPANY_ID, PERIOD)
        ).resolves.toEqual({
            attribution_coverage_pct: 50,
            unallocated_spend_cents: 0,
            tax_basis_unknown_cents: 1234,
            connected_sources: [],
        });
        expect(mockQuery.mock.calls[0][1][0]).toBe(COMPANY_ID);
        expect(mockQuery.mock.calls[1][1][0]).toBe(COMPANY_ID);
    });
});
