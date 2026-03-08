import { useState, useEffect } from 'react';
import { FileText } from 'lucide-react';
import { telephonyApi } from '../../services/telephonyApi';
import type { RoutingLogEntry } from '../../types/telephony';

const RESULT_COLORS: Record<string, { bg: string; text: string }> = {
    answered: { bg: '#d1fae5', text: '#065f46' },
    voicemail: { bg: '#dbeafe', text: '#1e40af' },
    abandoned: { bg: '#fef3c7', text: '#92400e' },
    error: { bg: '#fef2f2', text: '#b91c1c' },
};

export default function RoutingLogsPage() {
    const [logs, setLogs] = useState<RoutingLogEntry[]>([]);
    const [selected, setSelected] = useState<RoutingLogEntry | null>(null);
    const [loading, setLoading] = useState(true);
    useEffect(() => { telephonyApi.listLogs().then(l => { setLogs(l); setLoading(false); }); }, []);
    return (
        <div style={{ padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
                <FileText size={20} style={{ color: '#6366f1' }} />
                <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Routing Logs</h1>
            </div>
            {loading ? <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div> : (
                <div style={{ display: 'flex', gap: 16 }}>
                    <div style={{ flex: 1 }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                            <thead><tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                                {['Time', 'Caller', 'To', 'Result', 'Duration', 'Latency'].map(h => <th key={h} style={{ textAlign: 'left', padding: '8px 10px', fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' }}>{h}</th>)}
                            </tr></thead>
                            <tbody>{logs.map(l => {
                                const rc = RESULT_COLORS[l.result] || { bg: '#f3f4f6', text: '#374151' };
                                return (
                                    <tr key={l.id} onClick={() => setSelected(l)} style={{ borderBottom: '1px solid #f3f4f6', cursor: 'pointer', background: selected?.id === l.id ? '#ede9fe' : 'transparent' }}>
                                        <td style={{ padding: '8px 10px', fontSize: 12 }}>{l.timestamp.split(' ')[1]}</td>
                                        <td style={{ padding: '8px 10px' }}>{l.caller}</td>
                                        <td style={{ padding: '8px 10px' }}>{l.number_called}</td>
                                        <td style={{ padding: '8px 10px' }}><span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: rc.bg, color: rc.text }}>{l.result}</span></td>
                                        <td style={{ padding: '8px 10px' }}>{l.duration_sec}s</td>
                                        <td style={{ padding: '8px 10px' }}>{l.latency_ms}ms</td>
                                    </tr>
                                );
                            })}</tbody>
                        </table>
                    </div>
                    {selected && (
                        <div style={{ width: 300, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', marginBottom: 12 }}>Session Trace</div>
                            <div style={{ fontSize: 12, color: '#374151', marginBottom: 8 }}><strong>Session:</strong> {selected.session_id}</div>
                            <div style={{ fontSize: 12, color: '#374151', marginBottom: 12 }}><strong>Caller:</strong> {selected.caller}</div>
                            <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', marginBottom: 6 }}>Flow Path</div>
                            {selected.flow_path.map((step, i) => (
                                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                                    <div style={{ width: 20, height: 20, borderRadius: '50%', background: '#ede9fe', color: '#6366f1', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700 }}>{i + 1}</div>
                                    <span style={{ fontSize: 12 }}>{step}</span>
                                </div>
                            ))}
                            {selected.error && <div style={{ marginTop: 12, padding: '8px 10px', background: '#fef2f2', borderRadius: 6, fontSize: 12, color: '#ef4444' }}>Error: {selected.error}</div>}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
