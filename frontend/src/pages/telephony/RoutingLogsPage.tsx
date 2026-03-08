import { useState, useEffect } from 'react';
import { Search, CheckCircle, XCircle, AlertCircle, Voicemail, ChevronRight } from 'lucide-react';
import { extendedMockApi, type RoutingLogEntry } from '../../services/extendedMockApi';

const RESULT_CONFIG: Record<string, { color: string; bg: string; icon: any }> = {
    connected: { color: '#065f46', bg: '#d1fae5', icon: CheckCircle },
    voicemail: { color: '#6d28d9', bg: '#ede9fe', icon: Voicemail },
    abandoned: { color: '#92400e', bg: '#fef3c7', icon: XCircle },
    failed: { color: '#991b1b', bg: '#fee2e2', icon: AlertCircle },
};

export default function RoutingLogsPage() {
    const [logs, setLogs] = useState<RoutingLogEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [resultFilter, setResultFilter] = useState('all');
    const [selectedLog, setSelectedLog] = useState<RoutingLogEntry | null>(null);

    useEffect(() => { extendedMockApi.getRoutingLogs().then(l => { setLogs(l); setLoading(false); }); }, []);

    const filtered = logs.filter(l => {
        if (resultFilter !== 'all' && l.result !== resultFilter) return false;
        if (search && !l.caller.includes(search) && !(l.caller_name || '').toLowerCase().includes(search.toLowerCase()) && !l.called_number.includes(search)) return false;
        return true;
    });

    if (loading) return <div style={{ padding: 32 }}><div style={{ width: 24, height: 24, border: '3px solid #e5e7eb', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 1s linear infinite' }} /></div>;

    return (
        <div style={{ padding: '24px 32px', maxWidth: 1400 }}>
            <div style={{ marginBottom: 20 }}>
                <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111', margin: 0 }}>Routing Logs</h1>
                <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>Trace inbound call routing decisions and diagnose issues</p>
            </div>

            {/* Filters */}
            <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
                <div style={{ position: 'relative', flex: 1, maxWidth: 300 }}>
                    <Search size={16} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
                    <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by phone, name, or call ID..." style={{ width: '100%', padding: '8px 12px 8px 32px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, outline: 'none' }} />
                </div>
                <select value={resultFilter} onChange={e => setResultFilter(e.target.value)} style={{ padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, background: '#fff' }}>
                    <option value="all">All Results</option>
                    <option value="connected">Connected</option>
                    <option value="voicemail">Voicemail</option>
                    <option value="abandoned">Abandoned</option>
                    <option value="failed">Failed</option>
                </select>
                <button style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '8px 12px', fontSize: 13, background: resultFilter === 'failed' ? '#fef2f2' : '#fff', border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer', color: resultFilter === 'failed' ? '#ef4444' : '#6b7280' }} onClick={() => setResultFilter(f => f === 'failed' ? 'all' : 'failed')}>
                    <AlertCircle size={14} />Errors Only
                </button>
            </div>

            {/* Split view */}
            <div style={{ display: 'flex', gap: 16, minHeight: 500 }}>
                {/* Session list */}
                <div style={{ flex: selectedLog ? 1 : 1, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <thead>
                            <tr style={{ background: '#f9fafb' }}>
                                {['Time', 'Caller', 'Called', 'Group', 'Flow', 'Result', 'Latency'].map(h => (
                                    <th key={h} style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb', fontSize: 12 }}>{h}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.map((l, i) => {
                                const rc = RESULT_CONFIG[l.result] || RESULT_CONFIG.failed;
                                const Icon = rc.icon;
                                return (
                                    <tr key={l.id} onClick={() => setSelectedLog(l)} style={{ cursor: 'pointer', background: selectedLog?.id === l.id ? '#f0f0ff' : i % 2 === 0 ? '#fff' : '#fafbfc' }} onMouseEnter={e => { if (selectedLog?.id !== l.id) e.currentTarget.style.background = '#fafafe'; }} onMouseLeave={e => { if (selectedLog?.id !== l.id) e.currentTarget.style.background = i % 2 === 0 ? '#fff' : '#fafbfc'; }}>
                                        <td style={{ padding: '10px 12px', borderBottom: '1px solid #f0f0f0', fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>{new Date(l.started_at).toLocaleTimeString()}</td>
                                        <td style={{ padding: '10px 12px', borderBottom: '1px solid #f0f0f0' }}>
                                            <div>{l.caller_name || <span style={{ color: '#9ca3af' }}>Unknown</span>}</div>
                                            <div style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' }}>{l.caller}</div>
                                        </td>
                                        <td style={{ padding: '10px 12px', borderBottom: '1px solid #f0f0f0', fontFamily: 'monospace', fontSize: 12 }}>{l.called_number}</td>
                                        <td style={{ padding: '10px 12px', borderBottom: '1px solid #f0f0f0' }}>{l.number_group}</td>
                                        <td style={{ padding: '10px 12px', borderBottom: '1px solid #f0f0f0' }}>{l.resolved_flow} <span style={{ fontSize: 11, color: '#9ca3af' }}>v{l.flow_version}</span></td>
                                        <td style={{ padding: '10px 12px', borderBottom: '1px solid #f0f0f0' }}>
                                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: rc.bg, color: rc.color }}>
                                                <Icon size={12} />{l.result}
                                            </span>
                                        </td>
                                        <td style={{ padding: '10px 12px', borderBottom: '1px solid #f0f0f0', fontSize: 12, color: '#6b7280' }}>{l.latency_ms}ms</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                    {filtered.length === 0 && <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No routing logs match your filters</div>}
                </div>

                {/* Trace detail */}
                {selectedLog && (
                    <div style={{ width: 380, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, flexShrink: 0, overflowY: 'auto' }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 16 }}>Trace Detail</div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, marginBottom: 20 }}>
                            {[
                                { label: 'Caller', value: `${selectedLog.caller_name || 'Unknown'} (${selectedLog.caller})` },
                                { label: 'Called', value: selectedLog.called_number },
                                { label: 'Number Group', value: selectedLog.number_group },
                                { label: 'Flow', value: `${selectedLog.resolved_flow} v${selectedLog.flow_version}` },
                                { label: 'Result', value: selectedLog.result },
                                { label: 'Latency', value: `${selectedLog.latency_ms}ms` },
                                { label: 'Provider', value: selectedLog.provider_status },
                            ].map(r => (
                                <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <span style={{ color: '#6b7280' }}>{r.label}</span>
                                    <span style={{ fontWeight: 500 }}>{r.value}</span>
                                </div>
                            ))}
                        </div>

                        {/* Flow path */}
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Flow Path</div>
                        {selectedLog.path.length > 0 ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                {selectedLog.path.map((step, i) => (
                                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: i === selectedLog.path.length - 1 ? '#f0fdf4' : '#f9fafb', borderRadius: 6, fontSize: 12 }}>
                                        <div style={{ width: 20, height: 20, borderRadius: '50%', background: i === selectedLog.path.length - 1 ? '#10b981' : '#e5e7eb', color: i === selectedLog.path.length - 1 ? '#fff' : '#6b7280', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, flexShrink: 0 }}>{i + 1}</div>
                                        <span style={{ fontWeight: 500 }}>{step}</span>
                                        {i < selectedLog.path.length - 1 && <ChevronRight size={12} style={{ color: '#d1d5db', marginLeft: 'auto' }} />}
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>No flow path (routing failed)</div>
                        )}

                        {selectedLog.error && (
                            <div style={{ marginTop: 16, padding: '10px 12px', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8 }}>
                                <div style={{ fontSize: 11, fontWeight: 600, color: '#991b1b', marginBottom: 4 }}>Error</div>
                                <div style={{ fontSize: 12, color: '#991b1b' }}>{selectedLog.error}</div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
