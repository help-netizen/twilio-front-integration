import { useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TriangleAlert, Plug } from 'lucide-react';
import { SettingsPageShell } from '../components/settings/SettingsPageShell';
import {
    fetchAnalyticsSummary,
    fetchAnalyticsBreakdown,
    fetchAnalyticsDataQuality,
    type AnalyticsSummary,
    type AnalyticsBreakdown,
    type BreakdownDimension,
    type BreakdownRow,
    type FunnelStage,
    type PeriodParams,
    type AnalyticsDataQuality,
} from '../services/leadChannelAnalyticsApi';

/* ── tokens ─────────────────────────────────────────────────────────────── */
const OK = 'var(--blanc-success)';
const DANGER = 'var(--blanc-danger)';
const INK1 = 'var(--blanc-ink-1)';
const INK2 = 'var(--blanc-ink-2)';
const INK3 = 'var(--blanc-ink-3)';
const LINE = 'var(--blanc-line)';
const FIELD = 'var(--blanc-field)';
const SURFACE = 'var(--blanc-surface-strong)';
const HEAD_FONT = 'var(--blanc-font-heading, inherit)';

const DIMENSIONS: { id: BreakdownDimension; label: string }[] = [
    { id: 'channel', label: 'Channel' },
    { id: 'area', label: 'Area' },
    { id: 'technician', label: 'Technician' },
];

const PRESETS: { label: string; days: number }[] = [
    { label: '7d', days: 7 },
    { label: '30d', days: 30 },
    { label: '90d', days: 90 },
];

/** Deterministic dot colour per breakdown row (channels/areas/techs). */
const DOT_PALETTE = ['#2f63d8', '#d32323', '#7F42E1', '#c98a2b', '#1b8b63', '#8a8a8a', '#b26a1d', '#0891b2'];

const FUNNEL_LABELS: Record<string, string> = {
    leads: 'Leads',
    converted: 'Converted to job',
    visit_completed: 'Visit completed',
    job_is_done: 'Job is Done',
};
const FUNNEL_COLORS: Record<string, string> = {
    leads: 'var(--blanc-lead, #b26a1d)',
    converted: '#9a6bd6',
    visit_completed: 'var(--blanc-job, #2f63d8)',
    job_is_done: OK,
};

/* ── formatters ─────────────────────────────────────────────────────────── */
const dollars = (cents: number) => cents / 100;

function fmtMoneyCompact(cents: number): string {
    const v = dollars(cents);
    const abs = Math.abs(v);
    const sign = v < 0 ? '−' : '';
    if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
    return `${sign}$${abs.toFixed(0)}`;
}
function fmtMoney(cents: number): string {
    const v = dollars(cents);
    return `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}
function fmtSignedMoney(cents: number): string {
    const v = dollars(cents);
    return `${v < 0 ? '−' : '+'}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}
function fmtCount(n: number): string {
    return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(1);
}
function fmtPct(n: number): string {
    return `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
}

function isoDate(d: Date): string {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
}
function rangeForDays(days: number): PeriodParams {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - (days - 1));
    return { from: isoDate(from), to: isoDate(to) };
}

/* ── page ───────────────────────────────────────────────────────────────── */
export default function AnalyticsPage() {
    const [presetDays, setPresetDays] = useState(30);
    const [dimension, setDimension] = useState<BreakdownDimension>('channel');
    const range = useMemo(() => rangeForDays(presetDays), [presetDays]);

    const summaryQ = useQuery({
        queryKey: ['lca-summary', range.from, range.to],
        queryFn: () => fetchAnalyticsSummary(range),
    });
    const breakdownQ = useQuery({
        queryKey: ['lca-breakdown', dimension, range.from, range.to],
        queryFn: () => fetchAnalyticsBreakdown({ ...range, dimension }),
    });
    const qualityQ = useQuery({
        queryKey: ['lca-quality', range.from, range.to],
        queryFn: () => fetchAnalyticsDataQuality(range),
    });

    return (
        <SettingsPageShell
            eyebrow="Marketing & channels"
            title="Analytics"
            description="Every lead source, end to end — from request to completed repair to money collected — and whether each channel, area, and technician earns or loses."
            actions={<PeriodPills value={presetDays} onChange={setPresetDays} />}
        >
            {summaryQ.isError ? (
                <ErrorBlock message={(summaryQ.error as Error)?.message} />
            ) : summaryQ.isLoading || !summaryQ.data ? (
                <LoadingBlock />
            ) : (
                <>
                    <KpiRow data={summaryQ.data} />
                    <FunnelCard data={summaryQ.data} />
                </>
            )}

            <BreakdownCard
                dimension={dimension}
                onDimension={setDimension}
                data={breakdownQ.data}
                loading={breakdownQ.isLoading}
                error={breakdownQ.isError ? (breakdownQ.error as Error)?.message : null}
            />

            <DataQualityCard
                data={qualityQ.data}
                loading={qualityQ.isLoading}
                error={qualityQ.isError ? (qualityQ.error as Error)?.message : null}
            />
        </SettingsPageShell>
    );
}

/* ── period pills ───────────────────────────────────────────────────────── */
function PeriodPills({ value, onChange }: { value: number; onChange: (days: number) => void }) {
    return (
        <div
            style={{ display: 'inline-flex', background: SURFACE, border: `1px solid ${LINE}`, borderRadius: 999, padding: 3 }}
        >
            {PRESETS.map(p => {
                const on = p.days === value;
                return (
                    <button
                        key={p.days}
                        type="button"
                        onClick={() => onChange(p.days)}
                        style={{
                            border: 'none', background: on ? INK1 : 'transparent', color: on ? '#fff' : INK2,
                            font: 'inherit', fontSize: 13, fontWeight: 600, padding: '5px 14px', borderRadius: 999, cursor: 'pointer',
                        }}
                    >
                        {p.label}
                    </button>
                );
            })}
        </div>
    );
}

/* ── KPI tiles ──────────────────────────────────────────────────────────── */
const TILE = 'rounded-2xl px-4 py-3.5';
const tileStyle: CSSProperties = { background: 'rgba(25,25,25,0.03)' };

function KpiTile({ label, value, sub, valueColor }: { label: string; value: string; sub?: string; valueColor?: string }) {
    return (
        <div className={TILE} style={tileStyle}>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: INK3 }}>{label}</div>
            <div className="mono" style={{ fontSize: 22, fontWeight: 700, marginTop: 5, fontFamily: HEAD_FONT, color: valueColor || INK1 }}>{value}</div>
            {sub && <div style={{ fontSize: 12, marginTop: 3, color: INK3 }}>{sub}</div>}
        </div>
    );
}

function KpiRow({ data }: { data: AnalyticsSummary }) {
    const k = data.kpis;
    const spendConnected = k.ad_spend_cents > 0 || k.roas !== null;
    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <KpiTile label="Leads" value={fmtCount(k.leads)} />
            <KpiTile label="Jobs done" value={fmtCount(k.jobs_done)} />
            <KpiTile label="Revenue" value={fmtMoneyCompact(k.revenue_net_cents)} sub="net collected" />
            <KpiTile
                label="Ad spend"
                value={spendConnected ? fmtMoneyCompact(k.ad_spend_cents) : '—'}
                sub={spendConnected ? 'Google Ads' : 'no source connected'}
            />
            <KpiTile
                label="ROAS"
                value={k.roas !== null ? `${k.roas.toFixed(1)}×` : '—'}
                sub={k.roas !== null ? 'rev ÷ spend' : 'connect a cost source'}
                valueColor={k.roas !== null && k.roas >= 1 ? OK : k.roas !== null ? DANGER : undefined}
            />
            <KpiTile
                label="Mktg contribution"
                value={fmtSignedMoney(k.marketing_contribution_cents)}
                sub="revenue − ad spend − calls"
                valueColor={k.marketing_contribution_cents >= 0 ? OK : DANGER}
            />
        </div>
    );
}

/* ── card shell ─────────────────────────────────────────────────────────── */
function Card({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
    return (
        <div style={{ background: SURFACE, border: `1px solid ${LINE}`, borderRadius: 22, padding: '18px 20px' }}>
            <div className="flex items-center justify-between gap-3" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
                <h2 style={{ fontFamily: HEAD_FONT, fontSize: 16, fontWeight: 700, margin: 0, color: INK1 }}>{title}</h2>
                {right}
            </div>
            {children}
        </div>
    );
}

/* ── funnel ─────────────────────────────────────────────────────────────── */
function FunnelCard({ data }: { data: AnalyticsSummary }) {
    const stages = data.funnel;
    const leadCount = stages[0]?.count ?? 0;
    const jobsDone = data.kpis.jobs_done;
    const revenue = data.kpis.revenue_net_cents;
    const doneStage = stages.find(s => s.stage === 'job_is_done');
    const netWidth = doneStage?.conv_pct ?? 0;

    return (
        <Card title="Funnel — request → repair → paid" right={<span style={{ fontSize: 12, color: INK3 }}>acquisition cohort · leads created in period</span>}>
            {leadCount === 0 ? (
                <EmptyLine text="No leads in this period." />
            ) : (
                <div className="flex flex-col gap-2.5">
                    {stages.map((s, i) => (
                        <FunnelRow key={s.stage} stage={s} prev={i > 0 ? stages[i - 1] : null} />
                    ))}
                    <div className="flex items-center gap-3.5">
                        <div className="shrink-0" style={{ width: 140, fontSize: 13, fontWeight: 600, color: INK1 }}>Net collected</div>
                        <div className="flex-1" style={{ height: 34, position: 'relative' }}>
                            <div
                                className="mono"
                                style={{
                                    height: '100%', width: `${Math.max(netWidth, 8)}%`, minWidth: 90,
                                    borderRadius: 8, background: 'linear-gradient(90deg,#1b8b63,#25a878)',
                                    display: 'flex', alignItems: 'center', padding: '0 12px', color: '#fff', fontWeight: 700, fontSize: 13,
                                }}
                            >
                                {fmtMoney(revenue)}
                            </div>
                        </div>
                        <div className="shrink-0 hidden sm:block" style={{ width: 160, textAlign: 'right', fontSize: 12, color: INK2 }}>
                            <b style={{ color: INK1 }}>{jobsDone > 0 ? fmtMoney(Math.round(revenue / jobsDone)) : '—'}</b> avg / done job
                        </div>
                    </div>
                </div>
            )}
        </Card>
    );
}

function FunnelRow({ stage, prev }: { stage: FunnelStage; prev: FunnelStage | null }) {
    const width = Math.max(stage.conv_pct, stage.count > 0 ? 6 : 0);
    const relPct = prev && prev.count > 0 ? (stage.count / prev.count) * 100 : null;
    const dropPct = relPct !== null ? 100 - relPct : null;
    return (
        <div className="flex items-center gap-3.5">
            <div className="shrink-0" style={{ width: 140, fontSize: 13, fontWeight: 600, color: INK1 }}>{FUNNEL_LABELS[stage.stage] || stage.stage}</div>
            <div className="flex-1" style={{ height: 34, background: FIELD, borderRadius: 8, overflow: 'hidden' }}>
                <div
                    className="mono"
                    style={{
                        height: '100%', width: `${width}%`, borderRadius: 8, background: FUNNEL_COLORS[stage.stage] || INK3,
                        display: 'flex', alignItems: 'center', padding: '0 12px', color: '#fff', fontWeight: 700, fontSize: 13,
                    }}
                >
                    {fmtCount(stage.count)}
                </div>
            </div>
            <div className="shrink-0 hidden sm:block" style={{ width: 160, textAlign: 'right', fontSize: 12, color: INK2 }}>
                {prev === null ? (
                    <span style={{ color: INK3 }}>{fmtPct(stage.conv_pct)} of leads</span>
                ) : (
                    <>
                        <b style={{ color: INK1 }}>{relPct !== null ? fmtPct(relPct) : '—'}</b> of {FUNNEL_LABELS[prev.stage]?.toLowerCase() ?? 'prev'}
                        {dropPct !== null && dropPct > 0 && <span style={{ color: DANGER, fontWeight: 600 }}> · {fmtPct(dropPct)} dropped</span>}
                    </>
                )}
            </div>
        </div>
    );
}

/* ── breakdown ──────────────────────────────────────────────────────────── */
const DIM_HEADER: Record<BreakdownDimension, string> = { channel: 'Source', area: 'Area', technician: 'Technician' };

function BreakdownCard({
    dimension, onDimension, data, loading, error,
}: {
    dimension: BreakdownDimension;
    onDimension: (d: BreakdownDimension) => void;
    data?: AnalyticsBreakdown;
    loading: boolean;
    error: string | null;
}) {
    const maxAbs = useMemo(() => {
        if (!data) return 1;
        return Math.max(1, ...data.rows.map(r => Math.abs(r.marketing_contribution_cents)));
    }, [data]);

    return (
        <Card
            title={`By ${dimension}`}
            right={<DimensionToggle value={dimension} onChange={onDimension} />}
        >
            {error ? (
                <ErrorBlock message={error} inline />
            ) : loading || !data ? (
                <div style={{ padding: 28, textAlign: 'center', color: INK3, fontSize: 13 }}>Loading…</div>
            ) : data.rows.length === 0 ? (
                <EmptyLine text="No data for this period." />
            ) : (
                <>
                    <div className="overflow-x-auto">
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 640 }}>
                            <thead>
                                <tr>
                                    <Th align="left">{DIM_HEADER[dimension]}</Th>
                                    <Th>Leads → Done</Th>
                                    <Th>Revenue</Th>
                                    <Th>Ad spend</Th>
                                    <Th>ROAS</Th>
                                    <Th>Mktg contribution</Th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.rows.map((row, i) => (
                                    <BreakdownTr key={row.key} row={row} color={DOT_PALETTE[i % DOT_PALETTE.length]} maxAbs={maxAbs} modeledSpend={dimension !== 'channel'} />
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div
                        style={{
                            display: 'flex', gap: 8, marginTop: 14, fontSize: 12.5, color: INK2,
                            background: 'var(--blanc-accent-soft)', borderRadius: 12, padding: '10px 13px',
                        }}
                    >
                        <TriangleAlert size={16} style={{ color: 'var(--blanc-accent)', flexShrink: 0, marginTop: 1 }} />
                        <div>
                            <b style={{ color: INK1 }}>ROAS shows only where cost is known.</b> Connect Google Ads to pull spend automatically;
                            free channels show contribution from revenue minus call cost. Until a source's cost is known, its ROAS stays “—”.
                            {dimension !== 'channel' && (
                                <> Ad cost per {dimension} is <b style={{ color: INK1 }}>estimated</b> (<b>EST</b>) — each channel's spend split evenly across its leads.</>
                            )}
                        </div>
                    </div>
                </>
            )}
        </Card>
    );
}

function BreakdownTr({ row, color, maxAbs, modeledSpend }: { row: BreakdownRow; color: string; maxAbs: number; modeledSpend: boolean }) {
    const contrib = row.marketing_contribution_cents;
    const positive = contrib >= 0;
    const barW = Math.round((Math.abs(contrib) / maxAbs) * 100);
    return (
        <tr style={{ borderTop: `1px solid ${LINE}` }}>
            <td style={{ padding: '11px 10px', textAlign: 'left' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontWeight: 600, color: INK1 }}>
                    <span style={{ width: 9, height: 9, borderRadius: '50%', background: color, flex: 'none' }} />
                    {row.label}
                </div>
            </td>
            <td className="mono" style={tdStyle}>
                <b style={{ color: INK1 }}>{fmtCount(row.funnel_counts.leads)}</b>
                <span style={{ color: INK3 }}> → {fmtCount(row.jobs_done)}</span>
            </td>
            <td className="mono" style={tdStyle}>{fmtMoney(row.revenue_net_cents)}</td>
            <td className="mono" style={{ ...tdStyle, color: row.ad_spend_cents !== null ? INK1 : INK3 }}>
                {row.ad_spend_cents !== null ? (
                    <>
                        {fmtMoney(row.ad_spend_cents)}
                        {modeledSpend && row.ad_spend_cents > 0 && (
                            <span title="Estimated: this channel's spend split evenly across its leads" style={{ marginLeft: 5, fontSize: 10, fontWeight: 700, color: INK3, letterSpacing: '0.03em' }}>EST</span>
                        )}
                    </>
                ) : '—'}
            </td>
            <td className="mono" style={{ ...tdStyle, fontWeight: 700, color: roasColor(row.roas) }}>
                {row.roas !== null ? `${row.roas.toFixed(1)}×` : '—'}
            </td>
            <td style={tdStyle}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end', fontWeight: 700, color: positive ? OK : DANGER }} className="mono">
                    {fmtSignedMoney(contrib)}
                    <span style={{ width: 56, height: 7, borderRadius: 4, background: FIELD, overflow: 'hidden', position: 'relative', flex: 'none' }}>
                        <i style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: `${barW}%`, borderRadius: 4, background: positive ? OK : DANGER }} />
                    </span>
                </span>
            </td>
        </tr>
    );
}

const tdStyle: CSSProperties = { padding: '11px 10px', textAlign: 'right', verticalAlign: 'middle' };

function roasColor(roas: number | null): string {
    if (roas === null) return INK3;
    if (roas >= 1.5) return OK;
    if (roas >= 1) return INK2;
    return DANGER;
}

function Th({ children, align = 'right' }: { children: ReactNode; align?: 'left' | 'right' }) {
    return (
        <th style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: INK3, textAlign: align, padding: '0 10px 10px', whiteSpace: 'nowrap' }}>
            {children}
        </th>
    );
}

function DimensionToggle({ value, onChange }: { value: BreakdownDimension; onChange: (d: BreakdownDimension) => void }) {
    return (
        <div style={{ display: 'inline-flex', background: FIELD, borderRadius: 10, padding: 3 }}>
            {DIMENSIONS.map(d => {
                const on = d.id === value;
                return (
                    <button
                        key={d.id}
                        type="button"
                        onClick={() => onChange(d.id)}
                        style={{
                            border: 'none', background: on ? SURFACE : 'transparent', color: on ? INK1 : INK2,
                            font: 'inherit', fontSize: 13, fontWeight: 600, padding: '5px 12px', borderRadius: 8, cursor: 'pointer',
                            boxShadow: on ? '0 1px 2px rgba(0,0,0,.06)' : 'none',
                        }}
                    >
                        {d.label}
                    </button>
                );
            })}
        </div>
    );
}

/* ── data quality ───────────────────────────────────────────────────────── */
function DataQualityCard({ data, loading, error }: { data?: AnalyticsDataQuality; loading: boolean; error: string | null }) {
    return (
        <Card title="Sources & data quality">
            {error ? (
                <ErrorBlock message={error} inline />
            ) : loading || !data ? (
                <div style={{ padding: 20, textAlign: 'center', color: INK3, fontSize: 13 }}>Loading…</div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                        <QiLabel>Connected cost sources</QiLabel>
                        {data.connected_sources.length === 0 ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                                <span style={{ width: 26, height: 26, borderRadius: 7, background: FIELD, display: 'grid', placeItems: 'center', color: INK3 }}>
                                    <Plug size={14} />
                                </span>
                                <div style={{ fontSize: 13, color: INK2 }}>
                                    No cost source connected yet.
                                    <div style={{ fontSize: 12, color: INK3 }}>Google Ads spend sync arrives next.</div>
                                </div>
                            </div>
                        ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                                {data.connected_sources.map((s, i) => (
                                    <div key={s.key ?? i} style={{ fontSize: 13, fontWeight: 600, color: INK1 }}>{s.label ?? s.key ?? 'Source'}</div>
                                ))}
                            </div>
                        )}
                    </div>
                    <div>
                        <QiLabel>Attribution coverage</QiLabel>
                        <div className="mono" style={{ fontSize: 20, fontWeight: 700, marginTop: 5, fontFamily: HEAD_FONT, color: INK1 }}>{fmtPct(data.attribution_coverage_pct)}</div>
                        <div style={{ fontSize: 12, color: INK3, marginTop: 3 }}>of leads matched to a channel</div>
                    </div>
                    <div>
                        <QiLabel>Unallocated / unknown</QiLabel>
                        <div className="mono" style={{ fontSize: 20, fontWeight: 700, marginTop: 5, fontFamily: HEAD_FONT, color: INK1 }}>{fmtMoney(data.unallocated_spend_cents)}</div>
                        <div style={{ fontSize: 12, color: INK3, marginTop: 3 }}>
                            spend with 0 attributed leads · <b className="mono" style={{ color: INK2 }}>{fmtMoney(data.tax_basis_unknown_cents)}</b> tax-basis-unknown
                        </div>
                    </div>
                </div>
            )}
        </Card>
    );
}

function QiLabel({ children }: { children: ReactNode }) {
    return <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: INK3 }}>{children}</div>;
}

/* ── shared states ──────────────────────────────────────────────────────── */
function LoadingBlock() {
    return <div style={{ padding: 40, textAlign: 'center', color: INK3 }}>Loading analytics…</div>;
}
function EmptyLine({ text }: { text: string }) {
    return <div style={{ padding: '18px 4px', fontSize: 13, color: INK3 }}>{text}</div>;
}
function ErrorBlock({ message, inline }: { message?: string; inline?: boolean }) {
    return (
        <div style={{ padding: inline ? 20 : 40, textAlign: 'center', color: DANGER, fontSize: 13 }}>
            {message || 'Failed to load analytics.'}
        </div>
    );
}
