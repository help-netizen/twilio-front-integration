import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { PhoneIncoming, PhoneOff, Users, Clock, BarChart3, AlertCircle, ArrowRight, Headphones } from 'lucide-react';
import { extendedMockApi, type DashboardKPIs, type QueuedCall, type AgentStatus, type LiveCall } from '../../services/extendedMockApi';

function formatWait(sec: number) {
    const m = Math.floor(sec / 60); const s = sec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function OperationsDashboardPage() {
    const navigate = useNavigate();
    const [kpis, setKpis] = useState<DashboardKPIs | null>(null);
    const [queue, setQueue] = useState<QueuedCall[]>([]);
    const [agents, setAgents] = useState<AgentStatus[]>([]);
    const [liveCalls, setLiveCalls] = useState<LiveCall[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        Promise.all([
            extendedMockApi.getDashboardKPIs(),
            extendedMockApi.getQueuedCalls(),
            extendedMockApi.getAgents(),
            extendedMockApi.getLiveCalls(),
        ]).then(([k, q, a, lc]) => { setKpis(k); setQueue(q); setAgents(a); setLiveCalls(lc); setLoading(false); });
    }, []);

    if (loading || !kpis) return <div style={{ padding: 32 }}><div style={{ width: 24, height: 24, border: '3px solid #e5e7eb', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 1s linear infinite' }} /></div>;

    const statusColor: Record<string, string> = { online: '#10b981', busy: '#f59e0b', on_call: '#3b82f6', offline: '#d1d5db' };

    return (
        <div style={{ padding: '24px 32px', maxWidth: 1400 }}>
            <div style={{ marginBottom: 20 }}>
                <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111', margin: 0 }}>Operations Dashboard</h1>
                <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>Live call center overview — updated in real time</p>
            </div>

            {/* KPI Cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12, marginBottom: 24 }}>
                {[
                    { label: 'Active Now', value: kpis.active_calls_now, icon: <PhoneIncoming size={18} />, color: '#3b82f6' },
                    { label: 'In Queue', value: kpis.calls_in_queue, icon: <Clock size={18} />, color: '#f59e0b' },
                    { label: 'Longest Wait', value: formatWait(kpis.longest_wait_sec), icon: <Clock size={18} />, color: '#ef4444' },
                    { label: 'Missed Today', value: kpis.missed_today, icon: <PhoneOff size={18} />, color: '#ef4444' },
                    { label: 'Avg Answer', value: `${kpis.avg_answer_time_sec}s`, icon: <BarChart3 size={18} />, color: '#10b981' },
                    { label: 'Agents Online', value: kpis.agents_online, icon: <Users size={18} />, color: '#8b5cf6' },
                ].map(k => (
                    <div key={k.label} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <span style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>{k.label}</span>
                            <span style={{ color: k.color }}>{k.icon}</span>
                        </div>
                        <div style={{ fontSize: 26, fontWeight: 700, color: k.color }}>{k.value}</div>
                    </div>
                ))}
            </div>

            {/* Two-column: Queue + Agents */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
                {/* Queue Panel */}
                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                        <h3 style={{ fontSize: 14, fontWeight: 600, color: '#374151', margin: 0, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Queue ({queue.length})</h3>
                        <button onClick={() => navigate('/calls/queue')} style={{ fontSize: 12, color: '#6366f1', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>View All <ArrowRight size={12} /></button>
                    </div>
                    {queue.length === 0 ? (
                        <div style={{ padding: 20, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No calls in queue</div>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {queue.map(q => (
                                <div key={q.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: q.wait_time_sec > 120 ? '#fef2f2' : '#f9fafb', borderRadius: 8 }}>
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontSize: 13, fontWeight: 500 }}>{q.caller_name || q.caller_phone}</div>
                                        <div style={{ fontSize: 11, color: '#6b7280' }}>{q.number_group} · {q.flow_step}</div>
                                    </div>
                                    <div style={{ textAlign: 'right' }}>
                                        <div style={{ fontSize: 13, fontWeight: 600, color: q.wait_time_sec > 120 ? '#ef4444' : '#f59e0b' }}>{formatWait(q.wait_time_sec)}</div>
                                        <div style={{ fontSize: 10, color: '#9ca3af' }}>#{q.position}</div>
                                    </div>
                                    {q.badges.map(b => <span key={b} style={{ fontSize: 9, fontWeight: 600, padding: '2px 6px', borderRadius: 8, background: '#dbeafe', color: '#1e40af' }}>{b}</span>)}
                                    <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 8, background: q.status === 'offering' ? '#d1fae5' : '#f3f4f6', color: q.status === 'offering' ? '#065f46' : '#6b7280' }}>{q.status}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Agent Panel */}
                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                    <h3 style={{ fontSize: 14, fontWeight: 600, color: '#374151', margin: '0 0 14px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Agents ({agents.length})</h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {agents.map(a => (
                            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: '#f9fafb', borderRadius: 8 }}>
                                <div style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor[a.status] || '#d1d5db', flexShrink: 0 }} />
                                <div style={{ flex: 1 }}>
                                    <div style={{ fontSize: 13, fontWeight: 500 }}>{a.name}</div>
                                    <div style={{ fontSize: 11, color: '#6b7280' }}>{a.user_group}</div>
                                </div>
                                <span style={{ fontSize: 11, fontWeight: 500, textTransform: 'capitalize', color: statusColor[a.status] }}>{a.status.replace('_', ' ')}</span>
                                {a.status === 'on_call' && <Headphones size={14} style={{ color: '#3b82f6' }} />}
                                {!a.device_ready && <AlertCircle size={14} style={{ color: '#f59e0b' }} />}
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* Active Calls */}
            {liveCalls.length > 0 && (
                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                    <h3 style={{ fontSize: 14, fontWeight: 600, color: '#374151', margin: '0 0 14px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Active Calls ({liveCalls.length})</h3>
                    {liveCalls.map(c => (
                        <div key={c.id} onClick={() => navigate(`/calls/live/${c.id}`)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', background: '#f0fdf4', borderRadius: 8, cursor: 'pointer' }}>
                            <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#10b981', animation: 'pulse 2s infinite' }} />
                            <div style={{ flex: 1 }}>
                                <div style={{ fontSize: 13, fontWeight: 600 }}>{c.caller_name || c.caller} → {c.agent}</div>
                                <div style={{ fontSize: 11, color: '#6b7280' }}>{c.number_group} · {formatWait(c.duration_sec)}</div>
                            </div>
                            <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: c.state === 'connected' ? '#d1fae5' : '#fef3c7', color: c.state === 'connected' ? '#065f46' : '#92400e' }}>{c.state}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
