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
}));

vi.mock('@tanstack/react-query', () => ({
    useQuery: ({ queryKey }: { queryKey: string[] }) => {
        const data = queryKey[0] === 'lca-summary'
            ? fixtures.summary
            : queryKey[0] === 'lca-breakdown'
                ? fixtures.breakdown
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
    });
});
