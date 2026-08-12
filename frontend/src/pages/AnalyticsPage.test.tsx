import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
    summary: {
        kpis: {
            leads: 24,
            converted: 17,
            visit_completed: 11,
            jobs_done: 8,
            revenue_net_cents: 1234567,
            call_cost_cents: 284567,
            ad_spend_cents: 0,
            roas: null,
            marketing_contribution_cents: 950000,
        },
        funnel: [
            { stage: 'leads', count: 24, conv_pct: 100 },
            { stage: 'converted', count: 17, conv_pct: 70.83 },
            { stage: 'visit_completed', count: 11, conv_pct: 45.83 },
            { stage: 'job_is_done', count: 8, conv_pct: 33.33 },
        ],
        period: {
            from: '2026-07-01',
            to: '2026-07-31',
            timezone: 'America/New_York',
        },
    },
    breakdown: {
        dimension: 'channel',
        rows: [
            {
                key: 'google_ads',
                label: 'Google Ads',
                leads: 14,
                jobs_done: 6,
                revenue_net_cents: 999999,
                ad_spend_cents: null,
                roas: null,
                marketing_contribution_cents: 975000,
                funnel_counts: {
                    leads: 14,
                    converted: 11,
                    visit_completed: 8,
                    jobs_done: 6,
                },
            },
            {
                key: 'paid_social',
                label: 'Paid Social',
                leads: 10,
                jobs_done: 2,
                revenue_net_cents: 234568,
                ad_spend_cents: null,
                roas: null,
                marketing_contribution_cents: -25000,
                funnel_counts: {
                    leads: 10,
                    converted: 6,
                    visit_completed: 3,
                    jobs_done: 2,
                },
            },
        ],
        totals: {
            leads: 24,
            jobs_done: 8,
            revenue_net_cents: 1234567,
            ad_spend_cents: 0,
            roas: null,
            marketing_contribution_cents: 950000,
            funnel_counts: {
                leads: 24,
                converted: 17,
                visit_completed: 11,
                jobs_done: 8,
            },
        },
    },
    quality: {
        attribution_coverage_pct: 87.5,
        unallocated_spend_cents: 0,
        tax_basis_unknown_cents: 1234,
        connected_sources: [],
    },
    geo: {
        period: {
            from: '2026-07-01',
            to: '2026-07-31',
            timezone: 'America/New_York',
        },
        zones: [
            { area: 'Boston Core', zip_count: 2 },
        ],
        rows: [
            {
                zip: '02118',
                area: 'Boston Core',
                in_configured_area: true,
                geometry: {
                    google_place_id: 'postal-place-02118',
                    lat: 42.337,
                    lon: -71.071,
                    status: 'resolved',
                },
                google_lsa: {
                    converted_count: 3,
                    ad_spend_cents: 90_000,
                    revenue_net_cents: 360_000,
                    cpa_cents: 30_000,
                    avg_revenue_cents: 120_000,
                    roas: 4,
                    spend_is_modeled: true,
                },
                elocal: {
                    converted_count: 2,
                    ad_spend_cents: 50_000,
                    revenue_net_cents: 140_000,
                    cpa_cents: 25_000,
                    avg_revenue_cents: 70_000,
                    roas: 2.8,
                    spend_is_modeled: false,
                },
            },
        ],
        quality: {
            unmapped_converted_count: 2,
            unmapped_revenue_net_cents: 10_000,
            unmapped_spend_cents: 2_000,
            unallocated_google_lsa_spend_cents: 0,
            centroid_only_zip_count: 0,
            missing_geometry_zip_count: 0,
        },
    },
}));

vi.mock('@tanstack/react-query', () => ({
    useQuery: ({ queryKey }: { queryKey: string[] }) => {
        const data = queryKey[0] === 'lca-summary'
            ? fixtures.summary
            : queryKey[0] === 'lca-breakdown'
                ? fixtures.breakdown
                : queryKey[0] === 'lca-geo'
                    ? fixtures.geo
                    : fixtures.quality;
        return { data, isLoading: false, isError: false, error: null };
    },
}));

vi.mock('react-router-dom', () => ({
    useNavigate: () => vi.fn(),
}));

import AnalyticsPage from './AnalyticsPage';

describe('AnalyticsPage', () => {
    it('renders loaded funnel and channel unit economics', () => {
        const markup = renderToStaticMarkup(<AnalyticsPage />);

        expect(markup).toContain('$12.3k');
        [
            'Leads',
            'Converted to job',
            'Visit completed',
            'Job is Done',
            'Net collected',
        ].forEach(label => expect(markup).toContain(label));
        expect(markup).toContain('Google Ads');
        expect(markup).toContain('Paid Social');
        expect(markup).toContain('−$250');
        expect(markup).toContain('Where booked jobs come from');
        expect(markup).toContain('Top ZIPs');
        expect(markup).toContain('02118');
        expect(markup).toContain('5 jobs');
        expect(markup).toContain('2 booked jobs are outside mapped ZIPs');
    });
});
