/**
 * RoutingLogsPage — Call routing logs with sortable columns, grouped by day.
 * Uses real call data from GET /api/calls.
 * Layout: canonical SettingsPageShell; day headings = eyebrow text on the
 * canvas (no surface, no sticky — LAYOUT-CANON rule 7), rows = white tiles.
 * Sortable column headers follow Jobs table pattern.
 */

import { useState, useEffect, useMemo } from 'react';
import { ArrowUp, ArrowDown, ArrowUpDown, PhoneIncoming, PhoneOutgoing, Download } from 'lucide-react';
import { format } from 'date-fns';
import { telephonyApi } from '../../services/telephonyApi';
import { Button } from '../../components/ui/button';
import { SettingsPageShell } from '../../components/settings/SettingsPageShell';
import { DateRangePickerPopover } from '../../components/ui/DateRangePickerPopover';
import { FloatingDetailPanel } from '../../components/ui/FloatingDetailPanel';
import type { RoutingLogEntry, UserGroup } from '../../types/telephony';
import { authedFetch } from '../../services/apiClient';

// ── Result styling ───────────────────────────────────────────────────────

const RESULT_CONFIG: Record<string, { bg: string; text: string; label: string }> = {
    answered: { bg: 'rgba(27, 139, 99, 0.12)', text: 'var(--blanc-success, #1b8b63)', label: 'Answered' },
    voicemail: { bg: 'rgba(47, 99, 216, 0.12)', text: 'var(--blanc-job, #2f63d8)', label: 'Voicemail' },
    abandoned: { bg: 'rgba(178, 106, 29, 0.12)', text: 'var(--blanc-warning, #b26a1d)', label: 'Missed' },
    error: { bg: 'rgba(212, 77, 60, 0.12)', text: 'var(--blanc-danger, #d44d3c)', label: 'Error' },
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

type SortField = 'timestamp' | 'caller' | 'caller_phone' | 'number_called' | 'group_name' | 'result' | 'duration_sec';
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
            case 'group_name':
                cmp = (a.group_name || '').localeCompare(b.group_name || '');
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
    const header = ['Date', 'Time', 'Direction', 'Group', 'Caller', 'Phone', 'To', 'Result', 'Duration (s)'];
    const rows = logs.map(log => [
        escapeCsv(formatDateForCsv(log.timestamp)),
        escapeCsv(formatTime(log.timestamp)),
        escapeCsv(log.direction === 'outbound' ? 'Outbound' : 'Inbound'),
        escapeCsv(log.group_name || ''),
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
    { key: 'group', label: 'Group', sortKey: 'group_name', width: '140px', align: 'left' },
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
    const [groups, setGroups] = useState<UserGroup[]>([]);
    const [groupId, setGroupId] = useState('');
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        telephonyApi.listLogs({ dateFrom, dateTo, groupId: groupId || undefined })
            .then(l => {
                if (cancelled) return;
                setLogs(l);
            })
            .catch(err => {
                if (cancelled) return;
                console.error('[RoutingLogs] failed to load logs:', err);
                setLogs([]);
                setError(err instanceof Error ? err.message : 'Failed to load routing logs');
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => { cancelled = true; };
    }, [dateFrom, dateTo, groupId]);

    useEffect(() => {
        let cancelled = false;
        authedFetch('/api/user-groups')
            .then(r => r.json())
            .then(json => { if (!cancelled) setGroups(json.data || []); })
            .catch(() => { if (!cancelled) setGroups([]); });
        return () => { cancelled = true; };
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

    // Date range + group filter — shared by the error and loaded states
    // (initial/reload state renders without them, as before).
    const filterActions = (
        <>
            <DateRangePickerPopover
                dateFrom={dateFrom}
                dateTo={dateTo}
                onDateFromChange={setDateFrom}
                onDateToChange={setDateTo}
            />
            <select
                value={groupId}
                onChange={e => setGroupId(e.target.value)}
                style={{
                    height: 34,
                    padding: '0 10px',
                    borderRadius: 10,
                    border: '1px solid var(--blanc-line)',
                    background: 'transparent',
                    color: 'var(--blanc-ink-2)',
                    fontSize: 13,
                }}
            >
                <option value="">All groups</option>
                {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
            </select>
        </>
    );

    if (loading) {
        return (
            <SettingsPageShell eyebrow="Telephony" title="Routing Logs">
                <div style={{ padding: 60, textAlign: 'center', color: 'var(--blanc-ink-3)' }}>Loading routing logs...</div>
            </SettingsPageShell>
        );
    }

    if (error) {
        return (
            <SettingsPageShell eyebrow="Telephony" title="Routing Logs" actions={filterActions}>
                <div style={{ padding: 60, textAlign: 'center', color: 'var(--blanc-danger, #d44d3c)' }}>{error}</div>
            </SettingsPageShell>
        );
    }

    return (
        <SettingsPageShell
            eyebrow="Telephony"
            title="Routing Logs"
            description={filtered.length > 0 ? `${filtered.length} calls` : undefined}
            actions={
                <>
                    {filterActions}
                    <Button variant="outline" size="sm" onClick={() => exportToCsv(sorted)}>
                        <Download size={14} />
                        Export CSV
                    </Button>
                </>
            }
        >
            <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {/* Column headers — eyebrow text on the canvas, not sticky (LAYOUT-CANON rule 7) */}
                <div
                    style={{
                        display: 'grid',
                        gridTemplateColumns: gridTemplate,
                        gap: 0,
                        padding: '0 14px',
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
                            onMouseEnter={e => { if (col.sortKey) e.currentTarget.style.background = 'rgba(25, 25, 25, 0.04)'; }}
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

                {/* Day groups: heading = eyebrow directly on the canvas (no surface, no sticky),
                    rows = white tiles with 8px air from the parent */}
                {dayGroups.map(group => (
                    <div key={group.key} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div className="blanc-eyebrow" style={{ padding: '8px 14px 0', margin: 0 }}>
                            {group.heading}
                        </div>

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

            {/* Detail drawer — overlay so the list keeps full width (no column crush) */}
            {selected && <DetailPanel log={selected} onClose={() => setSelected(null)} />}
        </SettingsPageShell>
    );
}

// ── Sub-components ───────────────────────────────────────────────────────

function LogRow({ log, isSelected, onClick }: { log: RoutingLogEntry; isSelected: boolean; onClick: () => void }) {
    const rc = RESULT_CONFIG[log.result] || RESULT_CONFIG.error;
    const DirIcon = log.direction === 'outbound' ? PhoneOutgoing : PhoneIncoming;

    return (
        <button
            type="button"
            onClick={onClick}
            className="blanc-tile"
            style={{
                display: 'grid',
                gridTemplateColumns: gridTemplate,
                alignItems: 'center',
                width: '100%',
                padding: '8px 14px',
                border: 'none',
                // лавандовое выделение — как .blanc-tile-row-selected
                background: isSelected ? 'rgba(127, 66, 225, 0.07)' : undefined,
                cursor: 'pointer',
                textAlign: 'left',
                outline: 'none',
                gap: 0,
            }}
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
                    {log.contact_name || log.caller}
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

            {/* Group */}
            <span style={{
                fontSize: 12, color: 'var(--blanc-ink-2)', padding: '0 6px',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
                {log.group_name || 'Unassigned'}
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
        <FloatingDetailPanel open onClose={onClose}>
        <div style={{ padding: 22, height: '100%', overflowY: 'auto' }}>
            <div style={{ marginBottom: 14 }}>
                <span style={{
                    fontSize: 11, fontWeight: 600, color: 'var(--blanc-ink-3)',
                    textTransform: 'uppercase', letterSpacing: '0.14em',
                }}>
                    Call Details
                </span>
            </div>

            {log.contact_name && (
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--blanc-ink-1)', fontFamily: 'var(--blanc-font-heading)', marginBottom: 2 }}>
                    {log.contact_name}
                </div>
            )}
            <div style={{ fontSize: 13, color: 'var(--blanc-ink-2)', marginBottom: 4 }}>{log.caller}</div>
            <div style={{ fontSize: 12, color: 'var(--blanc-ink-3)', marginBottom: 14 }}>→ {log.number_called}</div>
            {log.group_name && <div style={{ fontSize: 12, color: 'var(--blanc-ink-3)', marginBottom: 10 }}>Group: {log.group_name}</div>}

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
                        background: 'rgba(25, 25, 25, 0.05)', color: 'var(--blanc-ink-2)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 10, fontWeight: 700, flexShrink: 0,
                    }}>{i + 1}</div>
                    <span style={{ fontSize: 12, color: 'var(--blanc-ink-1)' }}>{step}</span>
                </div>
            ))}

            {log.error && (
                <div style={{ marginTop: 12, padding: '8px 12px', background: 'rgba(212, 77, 60, 0.08)', borderRadius: 10, fontSize: 12, color: 'var(--blanc-danger, #d44d3c)' }}>
                    {log.error}
                </div>
            )}

            {log.latency_ms > 0 && (
                <div style={{ marginTop: 12, fontSize: 12, color: 'var(--blanc-ink-3)' }}>
                    Ring time: {log.latency_ms > 1000 ? `${(log.latency_ms / 1000).toFixed(1)}s` : `${log.latency_ms}ms`}
                </div>
            )}
        </div>
        </FloatingDetailPanel>
    );
}
