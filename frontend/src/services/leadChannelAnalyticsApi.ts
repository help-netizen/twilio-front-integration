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

    // GOOGLE-LSA-ATTRIBUTION-001 — Google is mostly phone calls (Local Services
    // Ads); LSA leads are phone-matched to CRM and attributed by job_id. Spend is
    // split so LSA ROAS pairs LSA revenue with LSA spend (search stays separate).
    google_lsa_ad_spend_cents: number;
    google_other_ad_spend_cents: number;
    google_lsa_windowed_revenue_cents: number;
    google_lsa_ltv_cents: number;
    google_lsa_roas: number | null;
    google_lsa_ltv_roas: number | null;
    // symmetric conversion/CPA lenses (UNIFY — for channel comparison)
    google_lsa_booked_conversions: number;
    google_lsa_completed_conversions: number;
    google_lsa_cpa_booked_cents: number | null;
    google_lsa_cpa_completed_cents: number | null;

    // ELOCAL-ATTRIBUTION-001 — pay-per-call network. Spend = BILLABLE only
    // (UNBILLABLE = refunded/free). CPA = billable spend / converted, two lenses.
    elocal_call_count: number;
    elocal_billable_call_count: number;
    elocal_unbillable_call_count: number;
    elocal_matched_call_count: number;
    elocal_billable_ad_spend_cents: number;
    elocal_booked_conversions: number;
    elocal_completed_conversions: number;
    elocal_windowed_revenue_cents: number;
    elocal_cpa_booked_cents: number | null;
    elocal_cpa_completed_cents: number | null;
    elocal_roas: number | null;
    elocal_ltv_cents: number;
    elocal_ltv_roas: number | null;
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

/* ── GEO-HEATMAP-001: per-ZIP performance for the Analytics map ──────────── */
export interface GeoChannelMetrics {
    converted_count: number;
    ad_spend_cents: number;
    revenue_net_cents: number;
    cpa_cents: number | null;
    avg_revenue_cents: number | null;
    roas: number | null;
    spend_is_modeled: boolean;
}
export interface GeoRow {
    zip: string;
    area: string | null;
    in_configured_area: boolean;
    geometry: {
        google_place_id: string | null;
        lat: number | null;
        lon: number | null;
        status: 'resolved' | 'centroid_only' | 'missing';
    };
    google_lsa: GeoChannelMetrics;
    elocal: GeoChannelMetrics;
}
export interface GeoZone { area: string; zip_count: number; }
export interface AnalyticsGeoQuality {
    unmapped_converted_count: number;
    unmapped_revenue_net_cents: number;
    unmapped_spend_cents: number;
    unallocated_google_lsa_spend_cents: number;
    centroid_only_zip_count: number;
    missing_geometry_zip_count: number;
}
export interface AnalyticsGeo {
    period: AnalyticsPeriod;
    zones: GeoZone[];
    rows: GeoRow[];
    quality: AnalyticsGeoQuality;
}

export function fetchAnalyticsGeo(params: PeriodParams): Promise<AnalyticsGeo> {
    return request<AnalyticsGeo>(`${API_BASE}/geo?${qs({ from: params.from, to: params.to })}`);
}
