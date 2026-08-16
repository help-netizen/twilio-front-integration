import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import {
    fetchAnalyticsGeo,
    type AnalyticsGeo,
    type GeoRow,
} from '../../services/leadChannelAnalyticsApi';
import { GeoPostalCodeMap } from './GeoPostalCodeMap';
import {
    GEO_METRIC_META,
    GREEN_HEAT_RAMP,
    WARM_HEAT_RAMP,
    heatColor,
    metricsForGeoRow,
    qualityForChannel,
    valueForGeoMetric,
    type GeoChannelSelection,
    type GeoMetricMode,
} from './geoPerformanceModel';
import './geoPerformanceHeatmap.css';

interface GeoPerformanceHeatmapProps {
    from: string;
    to: string;
}

const CHANNELS: { value: GeoChannelSelection; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'google', label: 'Google (Local Services)' },
    { value: 'elocal', label: 'eLocal' },
];

const MODES: { value: GeoMetricMode; label: string }[] = [
    { value: 'count', label: 'Count' },
    { value: 'cpa', label: 'Avg acquisition' },
    { value: 'avg', label: 'Avg revenue' },
    { value: 'roas', label: 'Efficiency' },
];

const MIN_COUNTS = [1, 3, 5, 10] as const;

function formatMoney(cents: number | null): string {
    if (cents === null) return '—';
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0,
    }).format(cents / 100);
}

function formatCount(value: number): string {
    return Number.isInteger(value) ? value.toLocaleString('en-US') : value.toFixed(1);
}

function formatMetric(value: number | null, mode: GeoMetricMode): string {
    if (value === null) return '—';
    if (mode === 'count') return `${formatCount(value)} jobs`;
    if (mode === 'roas') return `${value.toFixed(1)}×`;
    return formatMoney(value);
}

function inclusiveDayCount(from: string, to: string): number | null {
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
    return Math.round((end - start) / 86_400_000) + 1;
}

function channelLabel(channel: GeoChannelSelection): string {
    return CHANNELS.find(item => item.value === channel)?.label ?? 'All channels';
}

function scopeLabel(channel: GeoChannelSelection, from: string, to: string): string {
    const days = inclusiveDayCount(from, to);
    const channelScope = channel === 'all' ? 'All channels' : channelLabel(channel);
    return `${channelScope} · ${days === null ? `${from} – ${to}` : `${days} days`}`;
}

function selectedRowOrFirst(rows: readonly GeoRow[], selectedZip: string | null): GeoRow | null {
    return rows.find(row => row.zip === selectedZip) ?? rows[0] ?? null;
}

export function GeoPerformanceHeatmap({ from, to }: GeoPerformanceHeatmapProps) {
    const geoQuery = useQuery({
        queryKey: ['lca-geo', from, to],
        queryFn: () => fetchAnalyticsGeo({ from, to }),
        staleTime: Infinity,
        refetchOnMount: false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
    });

    return (
        <section className="geo-heatmap" aria-labelledby="geo-performance-title">
            {geoQuery.isError ? (
                <GeoFrameHeader>
                    <div className="geo-heatmap__state" role="alert">
                        {(geoQuery.error as Error)?.message || 'Failed to load geographic performance.'}
                    </div>
                </GeoFrameHeader>
            ) : geoQuery.isLoading || !geoQuery.data ? (
                <GeoFrameHeader>
                    <div className="geo-heatmap__state">Loading geographic performance…</div>
                </GeoFrameHeader>
            ) : (
                <GeoPerformanceContent key={`${from}:${to}`} geo={geoQuery.data} from={from} to={to} />
            )}
        </section>
    );
}

function GeoFrameHeader({ children }: { children: ReactNode }) {
    return (
        <>
            <header className="geo-heatmap__header">
                <div>
                    <div className="blanc-eyebrow">Geographic performance</div>
                    <h2 id="geo-performance-title">Where booked jobs come from</h2>
                    <p>Each ZIP is colored by the selected metric. Select a ZIP for details.</p>
                </div>
            </header>
            {children}
        </>
    );
}

function GeoPerformanceContent({ geo, from, to }: {
    geo: AnalyticsGeo;
    from: string;
    to: string;
}) {
    const [channel, setChannel] = useState<GeoChannelSelection>('all');
    const [mode, setMode] = useState<GeoMetricMode>('count');
    const [minCount, setMinCount] = useState<number>(1);
    const [selectedZones, setSelectedZones] = useState<string[] | null>(null);
    const [selectedZip, setSelectedZip] = useState<string | null>(null);

    const zoneNames = useMemo(() => geo.zones.map(zone => zone.area), [geo.zones]);
    const activeZoneNames = selectedZones ?? zoneNames;
    const activeZones = useMemo(() => new Set(activeZoneNames), [activeZoneNames]);
    const rowsWithMetrics = useMemo(() => geo.rows.map(row => ({
        row,
        metrics: metricsForGeoRow(row, channel),
    })), [channel, geo.rows]);
    const visible = useMemo(() => rowsWithMetrics.filter(({ row, metrics }) => (
        metrics.count >= minCount
        && row.area !== null
        && activeZones.has(row.area)
    )), [activeZones, minCount, rowsWithMetrics]);
    const visibleRows = useMemo(() => visible.map(item => item.row), [visible]);

    const selected = selectedRowOrFirst(visibleRows, selectedZip);
    const effectiveSelectedZip = selected?.zip ?? null;
    const selectedMetrics = selected ? metricsForGeoRow(selected, channel) : null;
    const metricMeta = GEO_METRIC_META[mode];
    const palette = metricMeta.palette === 'warm' ? WARM_HEAT_RAMP : GREEN_HEAT_RAMP;
    const visibleValues = visible
        .map(({ metrics }) => valueForGeoMetric(metrics, mode))
        .filter((value): value is number => value !== null && Number.isFinite(value));
    const colorsByZip = useMemo(() => new Map(visible.map(({ row, metrics }) => [
        row.zip,
        heatColor(valueForGeoMetric(metrics, mode), visibleValues, palette),
    ])), [mode, palette, visible, visibleValues]);
    const ranked = useMemo(() => [...visible].sort((left, right) => {
        const leftValue = valueForGeoMetric(left.metrics, mode) ?? Number.NEGATIVE_INFINITY;
        const rightValue = valueForGeoMetric(right.metrics, mode) ?? Number.NEGATIVE_INFINITY;
        return rightValue - leftValue || left.row.zip.localeCompare(right.row.zip);
    }), [mode, visible]);
    const bookedJobs = visible.reduce((total, item) => total + item.metrics.count, 0);
    const quality = qualityForChannel(channel);

    const selectZip = useCallback((zip: string) => {
        setSelectedZip(zip);
    }, []);

    const toggleZone = (area: string) => {
        setSelectedZones(currentSelection => {
            const current = currentSelection ?? zoneNames;
            if (current.includes(area)) {
                return current.length === 1 ? current : current.filter(item => item !== area);
            }
            return [...current, area];
        });
    };

    return (
        <>
            <header className="geo-heatmap__header">
                <div>
                    <div className="blanc-eyebrow">Geographic performance</div>
                    <h2 id="geo-performance-title">Where booked jobs come from</h2>
                    <p>Each ZIP is colored by the selected metric. Select a ZIP for details. A conversion is a lead that became a scheduled, non-canceled job.</p>
                </div>
                <div className="geo-heatmap__total">
                    <b>{formatCount(bookedJobs)}</b>
                    <span>booked jobs · visible ZIPs</span>
                </div>
            </header>

            <div className="geo-heatmap__grid">
                <div className="geo-heatmap__map-wrap">
                    <GeoPostalCodeMap
                        rows={visibleRows}
                        colorsByZip={colorsByZip}
                        selectedZip={effectiveSelectedZip}
                        onSelectZip={selectZip}
                    />
                    {visibleRows.length === 0 && (
                        <div className="geo-heatmap__map-note">
                            {geo.rows.length === 0
                                ? 'No booked jobs from ad channels in this period.'
                                : `No ZIPs with ${minCount}+ booked jobs — lower ‘Min volume’ or adjust zones/period.`}
                        </div>
                    )}
                    <div className="geo-heatmap__badge">
                        <span aria-hidden />
                        {scopeLabel(channel, from, to)}
                    </div>
                    {selected && selectedMetrics && (
                        <aside className="geo-heatmap__detail" aria-label={`Details for ZIP ${selected.zip}`}>
                            <div className="geo-heatmap__detail-head">
                                <div>
                                    <h3>{selected.zip}</h3>
                                    <div className="geo-heatmap__detail-area">
                                        {selected.area ?? 'Outside configured zones'} · {selected.in_configured_area ? 'Configured service zone' : 'Outside service zones'}
                                    </div>
                                </div>
                                <span className={`geo-heatmap__quality geo-heatmap__quality--${quality.className}`}>
                                    {quality.tag}
                                </span>
                            </div>
                            <div className="geo-heatmap__detail-metrics">
                                <DetailMetric label="Booked jobs" value={formatCount(selectedMetrics.count)} />
                                <DetailMetric label="Avg acquisition" value={formatMoney(selectedMetrics.cpa)} />
                                <DetailMetric label="Avg revenue" value={formatMoney(selectedMetrics.avg)} />
                                <DetailMetric label="Efficiency" value={selectedMetrics.roas === null ? '—' : `${selectedMetrics.roas.toFixed(1)}×`} />
                                <DetailMetric label="Total revenue" value={formatMoney(selectedMetrics.revenue)} />
                                <DetailMetric label="Ad spend" value={formatMoney(selectedMetrics.spend)} />
                            </div>
                        </aside>
                    )}
                    <div className="geo-heatmap__legend" aria-label={`${metricMeta.title} color scale`}>
                        <div className="geo-heatmap__legend-head">
                            <span>{metricMeta.title}</span>
                            <span>{mode === 'count' || mode === 'avg' ? 'Job-keyed' : quality.label}</span>
                        </div>
                        <div className="geo-heatmap__legend-ramp">
                            {palette.map(color => <i key={color} style={{ background: color }} />)}
                        </div>
                        <div className="geo-heatmap__legend-scale">
                            <span>{visibleValues.length > 0 ? formatMetric(Math.min(...visibleValues), mode) : '—'}</span>
                            <span>{visibleValues.length > 0 ? formatMetric(Math.max(...visibleValues), mode) : '—'}</span>
                        </div>
                    </div>
                </div>

                <aside className="geo-heatmap__ranking">
                    <div className="geo-heatmap__ranking-head">
                        <h3>Top ZIPs</h3>
                        <span>{metricMeta.ranking}</span>
                    </div>
                    <div className="geo-heatmap__ranking-list">
                        {ranked.slice(0, 5).map(({ row, metrics }, index) => (
                            <button
                                key={row.zip}
                                type="button"
                                className={row.zip === effectiveSelectedZip ? 'is-selected' : undefined}
                                onClick={() => selectZip(row.zip)}
                            >
                                <span className="geo-heatmap__rank-number">{index + 1}</span>
                                <span className="geo-heatmap__rank-place">
                                    <b>{row.zip}</b>
                                    <small>{row.area ?? 'Outside configured zones'}</small>
                                </span>
                                <span className="geo-heatmap__rank-value">
                                    {formatMetric(valueForGeoMetric(metrics, mode), mode)}
                                </span>
                            </button>
                        ))}
                        {ranked.length === 0 && (
                            <p className="geo-heatmap__ranking-empty">No ZIPs meet this threshold.</p>
                        )}
                    </div>
                    <p className="geo-heatmap__ranking-foot">Visible ZIPs only. Select a row to highlight it on the map.</p>
                </aside>
            </div>

            <div className="geo-heatmap__controls">
                <SegmentedControl
                    label="Channel"
                    value={channel}
                    options={CHANNELS}
                    onChange={setChannel}
                />
                <SegmentedControl
                    className="geo-heatmap__mode-control"
                    label="Color by"
                    value={mode}
                    options={MODES}
                    onChange={setMode}
                />
                <label className="geo-heatmap__control">
                    <span className="geo-heatmap__control-label">Min volume</span>
                    <select value={minCount} onChange={event => setMinCount(Number(event.target.value))}>
                        {MIN_COUNTS.map(value => <option key={value} value={value}>{value}+</option>)}
                    </select>
                </label>
                <div className="geo-heatmap__control geo-heatmap__zones-control">
                    <span className="geo-heatmap__control-label">Service zones</span>
                    <div className="geo-heatmap__segments geo-heatmap__zones" role="group" aria-label="Service zones">
                        {geo.zones.map(zone => (
                            <button
                                key={zone.area}
                                type="button"
                                aria-pressed={activeZones.has(zone.area)}
                                title={`${zone.zip_count} configured ZIP${zone.zip_count === 1 ? '' : 's'}`}
                                onClick={() => toggleZone(zone.area)}
                            >
                                {zone.area}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            <details className="geo-heatmap__method">
                <summary>
                    How these numbers work
                    <ChevronDown size={15} aria-hidden />
                </summary>
                <div className="geo-heatmap__method-body">
                    <div className="geo-heatmap__method-item">
                        <b>Converted job</b> — a lead from this channel that became a job, was <b>scheduled</b>, and was <b>not canceled</b>. Attribution is phone-matched to the ad call in the selected period.
                    </div>
                    <div className="geo-heatmap__method-grid">
                        <MethodItem title="Count" description="number of converted jobs in the ZIP" formula="count" />
                        <MethodItem title="Avg acquisition cost" description="ad spend in the ZIP ÷ converted jobs" formula="spend ÷ count" />
                        <MethodItem title="Avg revenue" description="net collected (payments − refunds) ÷ converted jobs" formula="net revenue ÷ count" />
                        <MethodItem title="Efficiency (ROAS)" description="collected revenue ÷ ad spend" formula="revenue ÷ spend" />
                    </div>
                    <div className="geo-heatmap__method-item">
                        <b>Spend accuracy</b> — <span className="geo-heatmap__exact-text">eLocal</span> spend is exact per call by service ZIP. <span className="geo-heatmap__modeled-text">Google</span> spend is <b>modeled</b>: the channel total is split across ZIPs by job count, so Google cost and efficiency per ZIP are approximate and marked <b>EST</b>.
                    </div>
                    <div className="geo-heatmap__method-item">
                        <b>Color scale</b> — lighter ZIPs are lower and darker ZIPs are higher among the currently visible values. Avg acquisition uses the warm scale because higher cost is worse; the other modes use the green scale.
                    </div>
                </div>
            </details>

            <QualityFooter channel={channel} />
            {geo.quality.unmapped_converted_count > 0 && (
                <p className="geo-heatmap__unmapped-note">
                    {formatCount(geo.quality.unmapped_converted_count)} booked jobs are outside mapped ZIPs (no ZIP on the lead) and aren&apos;t shown on the map.
                </p>
            )}
        </>
    );
}

function DetailMetric({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <span>{label}</span>
            <b>{value}</b>
        </div>
    );
}

function SegmentedControl<T extends string>({
    label,
    value,
    options,
    onChange,
    className,
}: {
    label: string;
    value: T;
    options: readonly { value: T; label: string }[];
    onChange: (value: T) => void;
    className?: string;
}) {
    return (
        <div className={`geo-heatmap__control${className ? ` ${className}` : ''}`}>
            <span className="geo-heatmap__control-label">{label}</span>
            <div className="geo-heatmap__segments" role="group" aria-label={label}>
                {options.map(option => (
                    <button
                        key={option.value}
                        type="button"
                        aria-pressed={option.value === value}
                        onClick={() => onChange(option.value)}
                    >
                        {option.label}
                    </button>
                ))}
            </div>
        </div>
    );
}

function MethodItem({ title, description, formula }: {
    title: string;
    description: string;
    formula: string;
}) {
    return (
        <div className="geo-heatmap__method-item">
            <b>{title}</b> — {description}. <span>{formula}</span>
        </div>
    );
}

function QualityFooter({ channel }: { channel: GeoChannelSelection }) {
    if (channel === 'google') {
        return <p className="geo-heatmap__footer"><b>Modeled spend:</b> Google spend is allocated across ZIPs in proportion to booked jobs. Count and revenue are job-keyed.</p>;
    }
    if (channel === 'elocal') {
        return <p className="geo-heatmap__footer"><b>Exact spend:</b> eLocal cost is assigned by the call&apos;s service ZIP. Count and revenue are job-keyed.</p>;
    }
    return <p className="geo-heatmap__footer"><b>Mixed spend:</b> eLocal is exact by ZIP; Google is modeled. Count and revenue are job-keyed.</p>;
}
