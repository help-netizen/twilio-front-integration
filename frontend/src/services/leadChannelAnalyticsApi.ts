import { authedFetch } from './apiClient';

/**
 * LEAD-CHANNEL-ANALYTICS-001 — client for the tenant-safe lead-channel
 * analytics endpoints (chunk 1a). Money is always integer cents; the UI formats.
 * ad_spend/roas are null/0 until a cost source (Google Ads) is connected (1b).
 */

const API_BASE = '/api/lead-channel-analytics';

export type BreakdownDimension = 'channel' | 'area' | 'technician';

export interface AnalyticsPeriod {
    from: string;
    to: string;
    timezone: string;
}

export interface AnalyticsKpis {
    leads: number;
    converted: number;
    visit_completed: number;
    jobs_done: number;
    revenue_net_cents: number;
    call_cost_cents: number;
    ad_spend_cents: number;
    roas: number | null;
    marketing_contribution_cents: number;
}

export interface FunnelStage {
    stage: string;
    count: number;
    conv_pct: number;
}

export interface AnalyticsSummary {
    kpis: AnalyticsKpis;
    funnel: FunnelStage[];
    period: AnalyticsPeriod;
}

export interface FunnelCounts {
    leads: number;
    converted: number;
    visit_completed: number;
    jobs_done: number;
}

export interface BreakdownRow {
    key: string;
    label: string;
    leads: number;
    jobs_done: number;
    revenue_net_cents: number;
    ad_spend_cents: number | null;
    roas: number | null;
    marketing_contribution_cents: number;
    funnel_counts: FunnelCounts;
}

export interface BreakdownTotals {
    leads: number;
    jobs_done: number;
    revenue_net_cents: number;
    ad_spend_cents: number;
    roas: number | null;
    marketing_contribution_cents: number;
    funnel_counts: FunnelCounts;
}

export interface AnalyticsBreakdown {
    dimension: BreakdownDimension;
    rows: BreakdownRow[];
    totals: BreakdownTotals;
}

/** Shape firms up in chunk 1b (the Google Ads connector). Empty in 1a. */
export interface ConnectedSource {
    key?: string;
    label?: string;
    status?: string;
    synced_at?: string | null;
    [extra: string]: unknown;
}

export interface AnalyticsDataQuality {
    attribution_coverage_pct: number;
    unallocated_spend_cents: number;
    tax_basis_unknown_cents: number;
    connected_sources: ConnectedSource[];
}

export interface PeriodParams {
    from: string;
    to: string;
}

async function request<T>(url: string): Promise<T> {
    const res = await authedFetch(url, { headers: { 'Content-Type': 'application/json' } });
    if (!res.ok) {
        const body = await res.json().catch(() => ({} as Record<string, unknown>));
        const err = body as { error?: { message?: string }; message?: string };
        throw new Error(err.error?.message || err.message || `Request failed: ${res.status}`);
    }
    return res.json() as Promise<T>;
}

const qs = (params: Record<string, string>) => new URLSearchParams(params).toString();

export function fetchAnalyticsSummary(params: PeriodParams): Promise<AnalyticsSummary> {
    return request<AnalyticsSummary>(`${API_BASE}/summary?${qs({ from: params.from, to: params.to })}`);
}

export function fetchAnalyticsBreakdown(
    params: PeriodParams & { dimension: BreakdownDimension },
): Promise<AnalyticsBreakdown> {
    return request<AnalyticsBreakdown>(
        `${API_BASE}/breakdown?${qs({ from: params.from, to: params.to, dimension: params.dimension })}`,
    );
}

export function fetchAnalyticsDataQuality(params: PeriodParams): Promise<AnalyticsDataQuality> {
    return request<AnalyticsDataQuality>(`${API_BASE}/data-quality?${qs({ from: params.from, to: params.to })}`);
}
