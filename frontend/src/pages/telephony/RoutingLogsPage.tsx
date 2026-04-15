/**
 * RoutingLogsPage — Call routing logs with sortable columns, grouped by day.
 * Uses real call data from GET /api/calls.
 * Day headings follow Pulse DateSeparator pattern (heading label, no lines).
 * Sortable column headers follow Jobs table pattern.
 */

import { useState, useEffect, useMemo } from 'react';
import { ArrowUp, ArrowDown, ArrowUpDown, PhoneIncoming, PhoneOutgoing, Download } from 'lucide-react';
import { format } from 'date-fns';
import { telephonyApi } from '../../services/telephonyApi';
import { DateRangePickerPopover } from '../../components/ui/DateRangePickerPopover';
import type { RoutingLogEntry } from '../../types/telephony';

// ── Result styling ───────────────────────────────────────────────────────

const RESULT_CONFIG: Record<string, { bg: string; text: string; label: string }> = {
    answered: { bg: 'rgba(16, 185, 129, 0.10)', text: '#065f46', label: 'Answered' },
    voicemail: { bg: 'rgba(59, 130, 246, 0.10)', text: '#1e40af', label: 'Voicemail' },
    abandoned: { bg: 'rgba(245, 158, 11, 0.10)', text: '#92400e', label: 'Missed' },
    error: { bg: 'rgba(239, 68, 68, 0.10)', text: '#b91c1c', label: 'Error' },
};

// ── Date helpers ─────────────────────────────────────────────────────────

function dateKey(ts: string): string {
    try {
        const d = new Date(ts);
        if (isNaN(d.getTime())) return '';
        return d.toLocaleDateString('en-CA');
    } catch { return ''; }
}

function formatDayHeading(ts: string): string {
    try {
        const d = new Date(ts);
        if (isNaN(d.getTime())) return ts;
        const now = new Date();
        const todayKey = now.toLocaleDateString('en-CA');
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayKey = yesterday.toLocaleDateString('en-CA');
        const dk = d.toLocaleDateString('en-CA');
        if (dk === todayKey) return 'Today';
        if (dk === yesterdayKey) return 'Yesterday';
        return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    } catch { return ts; }
}

function formatTime(ts: string): string {
    try {
        const d = new Date(ts);
        if (isNaN(d.getTime())) return '';
        return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    } catch { return ''; }
}

function formatDuration(sec: number): string {
    if (!sec || sec <= 0) return '—';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m === 0) return `${s}s`;
    return `${m}m ${s}s`;
}

// ── Sorting ──────────────────────────────────────────────────────────────

type SortField = 'timestamp' | 'caller' | 'caller_phone' | 'number_called' | 'result' | 'duration_sec';
type SortOrder = 'asc' | 'desc';

function sortLogs(logs: RoutingLogEntry[], field: SortField, order: SortOrder): RoutingLogEntry[] {
    const sorted = [...logs];
    sorted.sort((a, b) => {
        let cmp = 0;
        switch (field) {
            case 'timestamp':
                cmp = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
                break;
            case 'caller':
                cmp = (a.contact_name || a.caller).localeCompare(b.contact_name || b.caller);
                break;
            case 'caller_phone':
                cmp = a.caller.localeCompare(b.caller);
                break;
            case 'number_called':
                cmp = a.number_called.localeCompare(b.number_called);
                break;
            case 'result':
                cmp = a.result.localeCompare(b.result);
                break;
            case 'duration_sec':
                cmp = a.duration_sec - b.duration_sec;
                break;
        }
        return order === 'asc' ? cmp : -cmp;
    });
    return sorted;
}

// ── Group by day ─────────────────────────────────────────────────────────

interface DayGroup {
    key: string;
    heading: string;
    logs: RoutingLogEntry[];
}

function groupByDay(logs: RoutingLogEntry[]): DayGroup[] {
    const map = new Map<string, RoutingLogEntry[]>();
    const order: string[] = [];
    for (const log of logs) {
        const dk = dateKey(log.timestamp);
        if (!dk) continue;
        if (!map.has(dk)) { map.set(dk, []); order.push(dk); }
        map.get(dk)!.push(log);
    }
    return order.map(dk => ({
        key: dk,
        heading: formatDayHeading(map.get(dk)![0].timestamp),
        logs: map.get(dk)!,
    }));
}

// ── CSV export ───────────────────────────────────────────────────────────

function escapeCsv(val: string): string {
    if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        return '"' + val.replace(/"/g, '""') + '"';
    }
    return val;
}

function formatDateForCsv(ts: string): string {
    try {
        const d = new Date(ts);
        if (isNaN(d.getTime())) return '';
        return d.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch { return ''; }
}

function exportToCsv(logs: RoutingLogEntry[]) {
    const header = ['Date', 'Time', 'Direction', 'Caller', 'Phone', 'To', 'Result', 'Duration (s)'];
    const rows = logs.map(log => [
        escapeCsv(formatDateForCsv(log.timestamp)),
        escapeCsv(formatTime(log.timestamp)),
        escapeCsv(log.direction === 'outbound' ? 'Outbound' : 'Inbound'),
        escapeCsv(log.contact_name || ''),
        escapeCsv(log.caller),
        escapeCsv(log.number_called),
        escapeCsv(RESULT_CONFIG[log.result]?.label || log.result),
        String(log.duration_sec),
    ]);

    const csv = [header.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `routing-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

// ── Column definitions ───────────────────────────────────────────────────

interface ColDef {
    key: string;
    label: string;
    sortKey?: SortField;
    width: string;
    align?: 'left' | 'right' | 'center';
}

const COLUMNS: ColDef[] = [
    { key: 'time', label: 'Time', sortKey: 'timestamp', width: '90px', align: 'left' },
    { key: 'caller', label: 'Caller', sortKey: 'caller', width: '1fr', align: 'left' },
    { key: 'caller_phone', label: 'From', sortKey: 'caller_phone', width: '160px', align: 'left' },
    { key: 'to', label: 'To', sortKey: 'number_called', width: '160px', align: 'left' },
    { key: 'result', label: 'Result', sortKey: 'result', width: '100px', align: 'center' },
    { key: 'duration', label: 'Duration', sortKey: 'duration_sec', width: '80px', align: 'right' },
];

const gridTemplate = COLUMNS.map(c => c.width).join(' ');

// ── Component ────────────────────────────────────────────────────────────

function defaultDateFrom(): string {
    const d = new Date(); d.setDate(d.getDate() - 7);
    return format(d, 'yyyy-MM-dd');
}

export default function RoutingLogsPage() {
    const [logs, setLogs] = useState<RoutingLogEntry[]>([]);
    const [selected, setSelected] = useState<RoutingLogEntry | null>(null);
    const [loading, setLoading] = useState(true);
    const [sortBy, setSortBy] = useState<SortField>('timestamp');
    const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
    const [dateFrom, setDateFrom] = useState<string>(defaultDateFrom);
    const [dateTo, setDateTo] = useState<string>(() => format(new Date(), 'yyyy-MM-dd'));

    useEffect(() => {
        telephonyApi.listLogs().then(l => { setLogs(l); setLoading(false); });
    }, []);

    const filtered = useMemo(() => {
        if (!dateFrom && !dateTo) return logs;
        return logs.filter(log => {
            const dk = dateKey(log.timestamp);
            if (!dk) return false;
            if (dateFrom && dk < dateFrom) return false;
            if (dateTo && dk > dateTo) return false;
            return true;
        });
    }, [logs, dateFrom, dateTo]);

    const sorted = useMemo(() => sortLogs(filtered, sortBy, sortOrder), [filtered, sortBy, sortOrder]);
    const dayGroups = useMemo(() => groupByDay(sorted), [sorted]);

    const handleHeaderClick = (col: ColDef) => {
        if (!col.sortKey) return;
        if (sortBy === col.sortKey) {
            setSortOrder(o => o === 'asc' ? 'desc' : 'asc');
        } else {
            setSortBy(col.sortKey);
            setSortOrder('asc');
        }
    };

    if (loading) {
        return (
            <div style={{ padding: 24 }}>
                <PageHeader />
                <div style={{ padding: 60, textAlign: 'center', color: 'var(--blanc-ink-3)' }}>Loading routing logs...</div>
            </div>
        );
    }

    return (
        <div style={{ padding: 24 }}>
            <PageHeader
                count={filtered.length}
                onExport={() => exportToCsv(sorted)}
                dateFrom={dateFrom}
                dateTo={dateTo}
                onDateFromChange={setDateFrom}
                onDateToChange={setDateTo}
            />

            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                    {/* Column headers — sticky */}
                    <div
                        style={{
                            display: 'grid',
                            gridTemplateColumns: gridTemplate,
                            gap: 0,
                            padding: '0 14px',
                            position: 'sticky',
                            top: 0,
                            zIndex: 5,
                            background: 'var(--blanc-bg, #faf7f2)',
                            paddingBottom: 4,
                        }}
                    >
                        {COLUMNS.map(col => (
                            <button
                                key={col.key}
                                type="button"
                                onClick={() => handleHeaderClick(col)}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 4,
                                    padding: '8px 6px',
                                    background: 'none',
                                    border: 'none',
                                    cursor: col.sortKey ? 'pointer' : 'default',
                                    userSelect: 'none',
                                    fontSize: 11,
                                    fontWeight: 600,
                                    color: 'var(--blanc-ink-3)',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.08em',
                                    justifyContent: col.align === 'right' ? 'flex-end' : col.align === 'center' ? 'center' : 'flex-start',
                                    outline: 'none',
                                    borderRadius: 6,
                                    transition: 'background 0.15s',
                                }}
                                onMouseEnter={e => { if (col.sortKey) e.currentTarget.style.background = 'rgba(117,106,89,0.06)'; }}
                                onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
                            >
                                {col.label}
                                {col.sortKey && (
                                    sortBy === col.sortKey
                                        ? sortOrder === 'asc'
                                            ? <ArrowUp size={13} style={{ color: 'var(--blanc-ink-1)' }} />
                                            : <ArrowDown size={13} style={{ color: 'var(--blanc-ink-1)' }} />
                                        : <ArrowUpDown size={13} style={{ opacity: 0.3 }} />
                                )}
                            </button>
                        ))}
                    </div>

                    {/* Day groups */}
                    {dayGroups.map(group => (
                        <div key={group.key}>
                            {/* Day heading */}
                            <div style={{ padding: '16px 14px 4px' }}>
                                <h3 style={{
                                    fontSize: 13,
                                    fontWeight: 700,
                                    color: 'var(--blanc-ink-1)',
                                    fontFamily: 'var(--blanc-font-heading)',
                                    letterSpacing: '-0.01em',
                                    margin: 0,
                                }}>
                                    {group.heading}
                                </h3>
                            </div>

                            {/* Rows */}
                            {group.logs.map(log => (
                                <LogRow
                                    key={log.id}
                                    log={log}
                                    isSelected={selected?.id === log.id}
                                    onClick={() => setSelected(selected?.id === log.id ? null : log)}
                                />
                            ))}
                        </div>
                    ))}

                    {logs.length === 0 && (
                        <div style={{ padding: 60, textAlign: 'center', color: 'var(--blanc-ink-3)' }}>No routing logs found</div>
                    )}
                </div>

                {/* Detail panel */}
                {selected && <DetailPanel log={selected} onClose={() => setSelected(null)} />}
            </div>
        </div>
    );
}

// ── Sub-components ───────────────────────────────────────────────────────

function PageHeader({ count, onExport, dateFrom, dateTo, onDateFromChange, onDateToChange }: {
    count?: number;
    onExport?: () => void;
    dateFrom?: string;
    dateTo?: string;
    onDateFromChange?: (d: string) => void;
    onDateToChange?: (d: string) => void;
}) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            <h1 style={{
                fontSize: 22, fontWeight: 700, margin: 0,
                fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)',
            }}>
                Routing Logs
            </h1>
            {count != null && count > 0 && (
                <span style={{
                    fontSize: 12, fontWeight: 600, color: 'var(--blanc-ink-3)',
                    background: 'rgba(117, 106, 89, 0.08)', padding: '2px 10px', borderRadius: 12,
                }}>
                    {count}
                </span>
            )}
            <div style={{ flex: 1 }} />
            {onDateFromChange && onDateToChange && (
                <DateRangePickerPopover
                    dateFrom={dateFrom}
                    dateTo={dateTo}
                    onDateFromChange={onDateFromChange}
                    onDateToChange={onDateToChange}
                />
            )}
            {onExport && (
                <button
                    type="button"
                    onClick={onExport}
                    style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        padding: '6px 14px', borderRadius: 10,
                        border: '1px solid var(--blanc-line)',
                        background: 'transparent', cursor: 'pointer',
                        fontSize: 13, fontWeight: 500, color: 'var(--blanc-ink-2)',
                        transition: 'background 0.15s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(117,106,89,0.05)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                    <Download size={14} />
                    Export CSV
                </button>
            )}
        </div>
    );
}

function LogRow({ log, isSelected, onClick }: { log: RoutingLogEntry; isSelected: boolean; onClick: () => void }) {
    const rc = RESULT_CONFIG[log.result] || RESULT_CONFIG.error;
    const DirIcon = log.direction === 'outbound' ? PhoneOutgoing : PhoneIncoming;

    return (
        <button
            type="button"
            onClick={onClick}
            style={{
                display: 'grid',
                gridTemplateColumns: gridTemplate,
                alignItems: 'center',
                width: '100%',
                padding: '8px 14px',
                borderRadius: 12,
                border: isSelected ? '1px solid var(--blanc-line)' : '1px solid transparent',
                background: isSelected ? 'rgba(117, 106, 89, 0.05)' : 'transparent',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'background 0.15s',
                outline: 'none',
                gap: 0,
            }}
            onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'rgba(117,106,89,0.03)'; }}
            onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = isSelected ? 'rgba(117,106,89,0.05)' : 'transparent'; }}
        >
            {/* Time */}
            <span style={{ fontSize: 12, color: 'var(--blanc-ink-2)', padding: '0 6px' }}>
                {formatTime(log.timestamp)}
            </span>

            {/* Caller name */}
            <div style={{ padding: '0 6px', minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                <DirIcon size={14} style={{ color: rc.text, flexShrink: 0 }} />
                <span style={{
                    fontSize: 13, fontWeight: 600, color: 'var(--blanc-ink-1)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                    {log.contact_name || '—'}
                </span>
            </div>

            {/* Caller phone */}
            <span style={{
                fontSize: 12, color: 'var(--blanc-ink-2)', padding: '0 6px',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
                {log.caller}
            </span>

            {/* To */}
            <span style={{
                fontSize: 12, color: 'var(--blanc-ink-2)', padding: '0 6px',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
                {log.number_called}
            </span>

            {/* Result */}
            <div style={{ display: 'flex', justifyContent: 'center', padding: '0 6px' }}>
                <span style={{
                    fontSize: 11, fontWeight: 600, padding: '2px 10px', borderRadius: 10,
                    background: rc.bg, color: rc.text, whiteSpace: 'nowrap',
                }}>
                    {rc.label}
                </span>
            </div>

            {/* Duration */}
            <span style={{
                fontSize: 12, color: 'var(--blanc-ink-2)', padding: '0 6px', textAlign: 'right',
            }}>
                {formatDuration(log.duration_sec)}
            </span>
        </button>
    );
}

function DetailPanel({ log, onClose }: { log: RoutingLogEntry; onClose: () => void }) {
    const rc = RESULT_CONFIG[log.result] || RESULT_CONFIG.error;

    return (
        <div style={{
            width: 300, flexShrink: 0,
            background: 'var(--blanc-surface-strong, #fffdf9)',
            border: '1px solid var(--blanc-line)', borderRadius: 16, padding: 18,
            position: 'sticky', top: 24,
        }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                <span style={{
                    fontSize: 11, fontWeight: 600, color: 'var(--blanc-ink-3)',
                    textTransform: 'uppercase', letterSpacing: '0.14em',
                }}>
                    Call Details
                </span>
                <button onClick={onClose} style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--blanc-ink-3)', fontSize: 16, padding: '2px 6px', borderRadius: 6,
                }}>×</button>
            </div>

            {log.contact_name && (
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--blanc-ink-1)', fontFamily: 'var(--blanc-font-heading)', marginBottom: 2 }}>
                    {log.contact_name}
                </div>
            )}
            <div style={{ fontSize: 13, color: 'var(--blanc-ink-2)', marginBottom: 4 }}>{log.caller}</div>
            <div style={{ fontSize: 12, color: 'var(--blanc-ink-3)', marginBottom: 14 }}>→ {log.number_called}</div>

            <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
                <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 10, background: rc.bg, color: rc.text }}>{rc.label}</span>
                <span style={{ fontSize: 12, color: 'var(--blanc-ink-2)' }}>{formatDuration(log.duration_sec)}</span>
                <span style={{ fontSize: 12, color: 'var(--blanc-ink-3)' }}>{formatTime(log.timestamp)}</span>
            </div>

            <div style={{ fontSize: 11, color: 'var(--blanc-ink-3)', marginBottom: 14, wordBreak: 'break-all' }}>{log.session_id}</div>

            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--blanc-ink-3)', textTransform: 'uppercase', letterSpacing: '0.14em', marginBottom: 8 }}>Flow Path</div>
            {log.flow_path.map((step, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                    <div style={{
                        width: 20, height: 20, borderRadius: 8,
                        background: 'rgba(117, 106, 89, 0.08)', color: 'var(--blanc-ink-2)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 10, fontWeight: 700, flexShrink: 0,
                    }}>{i + 1}</div>
                    <span style={{ fontSize: 12, color: 'var(--blanc-ink-1)' }}>{step}</span>
                </div>
            ))}

            {log.error && (
                <div style={{ marginTop: 12, padding: '8px 12px', background: 'rgba(239, 68, 68, 0.06)', borderRadius: 10, fontSize: 12, color: '#b91c1c' }}>
                    {log.error}
                </div>
            )}

            {log.latency_ms > 0 && (
                <div style={{ marginTop: 12, fontSize: 12, color: 'var(--blanc-ink-3)' }}>
                    Ring time: {log.latency_ms > 1000 ? `${(log.latency_ms / 1000).toFixed(1)}s` : `${log.latency_ms}ms`}
                </div>
            )}
        </div>
    );
}
