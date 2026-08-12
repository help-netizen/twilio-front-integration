import type { GeoRow } from '../../services/leadChannelAnalyticsApi';

export type GeoChannelSelection = 'all' | 'google' | 'elocal';
export type GeoMetricMode = 'count' | 'cpa' | 'avg' | 'roas';
export type GeoPalette = 'green' | 'warm';

export interface ClientGeoMetrics {
    count: number;
    spend: number;
    revenue: number;
    cpa: number | null;
    avg: number | null;
    roas: number | null;
}

export const GREEN_HEAT_RAMP = ['#e7f1ec', '#c3e0cf', '#8fc4a6', '#4c9b74', '#1b7a51'] as const;
export const WARM_HEAT_RAMP = ['#f7ede1', '#f0d3ad', '#e3a765', '#cf7a33', '#a8501a'] as const;
export const NEUTRAL_HEAT = '#eceee9';

export const GEO_METRIC_META: Record<GeoMetricMode, {
    title: string;
    ranking: string;
    palette: GeoPalette;
}> = {
    count: { title: 'Booked jobs', ranking: 'by booked jobs', palette: 'green' },
    cpa: { title: 'Avg acquisition', ranking: 'by highest cost', palette: 'warm' },
    avg: { title: 'Avg revenue', ranking: 'by average revenue', palette: 'green' },
    roas: { title: 'Efficiency', ranking: 'by efficiency', palette: 'green' },
};

export function metricsForGeoRow(row: GeoRow, channel: GeoChannelSelection): ClientGeoMetrics {
    const source = channel === 'google'
        ? row.google_lsa
        : channel === 'elocal'
            ? row.elocal
            : {
                converted_count: row.google_lsa.converted_count + row.elocal.converted_count,
                ad_spend_cents: row.google_lsa.ad_spend_cents + row.elocal.ad_spend_cents,
                revenue_net_cents: row.google_lsa.revenue_net_cents + row.elocal.revenue_net_cents,
            };
    const count = source.converted_count;
    const spend = source.ad_spend_cents;
    const revenue = source.revenue_net_cents;

    return {
        count,
        spend,
        revenue,
        cpa: count > 0 ? spend / count : null,
        avg: count > 0 ? revenue / count : null,
        roas: spend > 0 ? revenue / spend : null,
    };
}

export function valueForGeoMetric(metrics: ClientGeoMetrics, mode: GeoMetricMode): number | null {
    return metrics[mode];
}

export function heatColor(
    value: number | null,
    visibleValues: readonly number[],
    palette: readonly string[],
): string {
    if (value === null || !Number.isFinite(value) || visibleValues.length === 0) return NEUTRAL_HEAT;
    const min = Math.min(...visibleValues);
    const max = Math.max(...visibleValues);
    const normalized = max === min ? 1 : (value - min) / (max - min);
    const bucket = Math.max(1, Math.min(5, Math.ceil(normalized * 5)));
    return palette[bucket - 1] ?? NEUTRAL_HEAT;
}

export function qualityForChannel(channel: GeoChannelSelection): {
    tag: 'EST' | 'Exact' | 'Mixed';
    className: 'modeled' | 'exact' | 'mixed';
    label: 'Modeled spend' | 'Exact spend' | 'Mixed spend';
} {
    if (channel === 'google') return { tag: 'EST', className: 'modeled', label: 'Modeled spend' };
    if (channel === 'elocal') return { tag: 'Exact', className: 'exact', label: 'Exact spend' };
    return { tag: 'Mixed', className: 'mixed', label: 'Mixed spend' };
}
