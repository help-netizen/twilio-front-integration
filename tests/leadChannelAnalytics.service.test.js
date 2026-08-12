'use strict';

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));
const mockResolveZipPlaceId = jest.fn(() => Promise.resolve(null));
const mockIsPlaceIdFresh = jest.fn(() => true);
jest.mock('../backend/src/services/territoryGeoService', () => ({
    resolveZipPlaceId: mockResolveZipPlaceId,
    isPlaceIdFresh: mockIsPlaceIdFresh,
}));

const analytics = require('../backend/src/services/leadChannelAnalyticsService');

const COMPANY_ID = '00000000-0000-4000-8000-000000000212';
const PERIOD = { from: '2026-07-01', to: '2026-07-31' };
const TECH_1 = '00000000-0000-4000-8000-000000000001';
const TECH_2 = '00000000-0000-4000-8000-000000000002';

function cohortFact(overrides = {}) {
    return {
        id: '1',
        lead_count: 1,
        converted_count: 1,
        channel_key: 'source_google',
        channel_label: 'Google Ads',
        channel_attributed: true,
        area_key: 'area_downtown',
        area_label: 'Downtown',
        visit_completed_count: 1,
        jobs_done_count: 1,
        revenue_net_cents: '10000',
        call_cost_cents: '124',
        google_lsa_windowed_revenue_cents: '0',
        elocal_windowed_revenue_cents: '0',
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
                        converted_count: 0,
                        visit_completed_count: 0,
                        jobs_done_count: 0,
                        revenue_net_cents: '0',
                        call_cost_cents: '0',
                        technicians: [],
                    }),
                ],
            })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({
                rows: [{
                    channel_id: null,
                    revenue_net_cents: '0',
                    booked_conversion_count: '0',
                    completed_conversion_count: '0',
                }],
            })
            .mockResolvedValueOnce({
                rows: [{
                    channel_id: null,
                    call_count: '0',
                    billable_call_count: '0',
                    unbillable_call_count: '0',
                    matched_call_count: '0',
                    billable_spend_cents: '0',
                    booked_conversion_count: '0',
                    completed_conversion_count: '0',
                    ltv_revenue_net_cents: '0',
                }],
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
                google_lsa_ad_spend_cents: 0,
                google_other_ad_spend_cents: 0,
                google_lsa_booked_conversions: 0,
                google_lsa_completed_conversions: 0,
                google_lsa_windowed_revenue_cents: 0,
                google_lsa_ltv_cents: 0,
                google_lsa_cpa_booked_cents: null,
                google_lsa_cpa_completed_cents: null,
                google_lsa_roas: null,
                google_lsa_ltv_roas: null,
                elocal_call_count: 0,
                elocal_billable_call_count: 0,
                elocal_unbillable_call_count: 0,
                elocal_matched_call_count: 0,
                elocal_billable_ad_spend_cents: 0,
                elocal_booked_conversions: 0,
                elocal_completed_conversions: 0,
                elocal_windowed_revenue_cents: 0,
                elocal_ltv_cents: 0,
                elocal_cpa_booked_cents: null,
                elocal_cpa_completed_cents: null,
                elocal_roas: null,
                elocal_ltv_roas: null,
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
        mockQuery
            .mockResolvedValueOnce({ rows: [cohortFact()] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({
                rows: [{
                    channel_id: null,
                    revenue_net_cents: '0',
                    booked_conversion_count: '0',
                    completed_conversion_count: '0',
                }],
            })
            .mockResolvedValueOnce({
                rows: [{
                    channel_id: null,
                    call_count: '0',
                    billable_call_count: '0',
                    unbillable_call_count: '0',
                    matched_call_count: '0',
                    billable_spend_cents: '0',
                    booked_conversion_count: '0',
                    completed_conversion_count: '0',
                    ltv_revenue_net_cents: '0',
                }],
            });

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

describe('leadChannelAnalyticsService geo performance', () => {
    test('returns symmetric ZIP metrics, reconciled modeled spend, zones, and quality', async () => {
        mockQuery
            .mockResolvedValueOnce({
                rows: [{ timezone: 'America/New_York' }],
            })
            .mockResolvedValueOnce({
                rows: [
                    {
                        zip: '02108',
                        area: 'Downtown',
                        in_configured_area: true,
                        lat: '42.357',
                        lon: '-71.063',
                        google_place_id: 'place-02108',
                        place_id_resolved_at: '2026-08-01T00:00:00Z',
                        google_lsa_converted_count: '1',
                        google_lsa_revenue_net_cents: '8000',
                        elocal_converted_count: '1',
                        elocal_revenue_net_cents: '7000',
                        elocal_spend_cents: '500',
                    },
                    {
                        zip: '02109',
                        area: null,
                        in_configured_area: false,
                        lat: '42.36',
                        lon: '-71.05',
                        google_place_id: null,
                        place_id_resolved_at: null,
                        google_lsa_converted_count: '1',
                        google_lsa_revenue_net_cents: '3000',
                        elocal_converted_count: '0',
                        elocal_revenue_net_cents: '0',
                        elocal_spend_cents: '900',
                    },
                    {
                        zip: null,
                        area: null,
                        in_configured_area: false,
                        lat: null,
                        lon: null,
                        google_place_id: null,
                        place_id_resolved_at: null,
                        google_lsa_converted_count: '1',
                        google_lsa_revenue_net_cents: '1000',
                        elocal_converted_count: '0',
                        elocal_revenue_net_cents: '0',
                        elocal_spend_cents: '111',
                    },
                ],
            })
            .mockResolvedValueOnce({ rows: [{ spend_cents: '1001' }] })
            .mockResolvedValueOnce({
                rows: [
                    { area: 'Downtown', zip_count: '2' },
                    { area: 'Empty zone', zip_count: '1' },
                ],
            });

        const result = await analytics.getGeoPerformance(COMPANY_ID, PERIOD);

        expect(result).toEqual({
            period: { ...PERIOD, timezone: 'America/New_York' },
            zones: [
                { area: 'Downtown', zip_count: 2 },
                { area: 'Empty zone', zip_count: 1 },
            ],
            rows: [
                {
                    zip: '02108',
                    area: 'Downtown',
                    in_configured_area: true,
                    geometry: {
                        google_place_id: 'place-02108',
                        lat: 42.357,
                        lon: -71.063,
                        status: 'resolved',
                    },
                    google_lsa: {
                        converted_count: 1,
                        ad_spend_cents: 334,
                        revenue_net_cents: 8000,
                        cpa_cents: 334,
                        avg_revenue_cents: 8000,
                        roas: 8000 / 334,
                        spend_is_modeled: true,
                    },
                    elocal: {
                        converted_count: 1,
                        ad_spend_cents: 500,
                        revenue_net_cents: 7000,
                        cpa_cents: 500,
                        avg_revenue_cents: 7000,
                        roas: 14,
                        spend_is_modeled: false,
                    },
                },
                {
                    zip: '02109',
                    area: null,
                    in_configured_area: false,
                    geometry: {
                        google_place_id: null,
                        lat: 42.36,
                        lon: -71.05,
                        status: 'centroid_only',
                    },
                    google_lsa: {
                        converted_count: 1,
                        ad_spend_cents: 334,
                        revenue_net_cents: 3000,
                        cpa_cents: 334,
                        avg_revenue_cents: 3000,
                        roas: 3000 / 334,
                        spend_is_modeled: true,
                    },
                    elocal: {
                        converted_count: 0,
                        ad_spend_cents: 900,
                        revenue_net_cents: 0,
                        cpa_cents: null,
                        avg_revenue_cents: null,
                        roas: 0,
                        spend_is_modeled: false,
                    },
                },
            ],
            quality: {
                unmapped_converted_count: 1,
                unmapped_revenue_net_cents: 1000,
                unmapped_spend_cents: 444,
                unallocated_google_lsa_spend_cents: 0,
                centroid_only_zip_count: 1,
                missing_geometry_zip_count: 0,
            },
        });
        expect(mockQuery.mock.calls.every(call => (
            call[1][0] === COMPANY_ID
        ))).toBe(true);
        expect(mockResolveZipPlaceId).not.toHaveBeenCalled();
        await new Promise(resolve => setImmediate(resolve));
        expect(mockResolveZipPlaceId).toHaveBeenCalledWith('02109');
    });

    test('caps lazy place-ID warming at ten and never waits for it', async () => {
        let releaseWarm;
        const warmPromise = new Promise(resolve => {
            releaseWarm = resolve;
        });
        mockResolveZipPlaceId.mockImplementation(() => warmPromise);
        const rows = Array.from({ length: 12 }, (_, index) => ({
            zip: `1${String(index).padStart(4, '0')}`,
            area: null,
            in_configured_area: false,
            lat: null,
            lon: null,
            google_place_id: null,
            place_id_resolved_at: null,
            google_lsa_converted_count: '0',
            google_lsa_revenue_net_cents: '0',
            elocal_converted_count: '0',
            elocal_revenue_net_cents: '0',
            elocal_spend_cents: '1',
        }));
        mockQuery
            .mockResolvedValueOnce({ rows: [{ timezone: 'UTC' }] })
            .mockResolvedValueOnce({ rows })
            .mockResolvedValueOnce({ rows: [{ spend_cents: '0' }] })
            .mockResolvedValueOnce({ rows: [] });

        const result = await analytics.getGeoPerformance(COMPANY_ID, PERIOD);

        expect(result.rows).toHaveLength(12);
        expect(mockResolveZipPlaceId).not.toHaveBeenCalled();
        await new Promise(resolve => setImmediate(resolve));
        expect(mockResolveZipPlaceId).toHaveBeenCalledTimes(10);
        releaseWarm(null);
    });

    test('surfaces all Google spend as unallocated when no eligible LSA job exists', () => {
        expect(analytics._allocateGeoGoogleSpend(777, [{
            zip: '02108',
            googleLsaConvertedCount: 0,
        }])).toEqual({
            allocations: [0],
            unallocated_cents: 777,
        });
    });
});
