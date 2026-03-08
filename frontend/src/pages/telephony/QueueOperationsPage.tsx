import { useState, useEffect } from 'react';
import { PhoneIncoming, Headphones, Clock, AlertCircle, Phone } from 'lucide-react';
import { extendedMockApi, type QueuedCall, type AgentStatus } from '../../services/extendedMockApi';

function formatWait(sec: number) {
    const m = Math.floor(sec / 60); const s = sec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function QueueOperationsPage() {
    const [queue, setQueue] = useState<QueuedCall[]>([]);
    const [agents, setAgents] = useState<AgentStatus[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedCall, setSelectedCall] = useState<QueuedCall | null>(null);

    useEffect(() => {
        Promise.all([extendedMockApi.getQueuedCalls(), extendedMockApi.getAgents()]).then(([q, a]) => { setQueue(q); setAgents(a); setLoading(false); });
    }, []);

    const onlineAgents = agents.filter(a => a.status === 'online');
    const statusColor: Record<string, string> = { online: '#10b981', busy: '#f59e0b', on_call: '#3b82f6', offline: '#d1d5db' };

    if (loading) return <div style={{ padding: 32 }}><div style={{ width: 24, height: 24, border: '3px solid #e5e7eb', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 1s linear infinite' }} /></div>;

    return (
        <div style={{ padding: '24px 32px', maxWidth: 1400 }}>
            <div style={{ marginBottom: 20 }}>
                <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111', margin: 0 }}>Queue Operations</h1>
                <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>Manage queued calls and assign to available agents</p>
            </div>

            {/* Summary strip */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
                {[
                    { label: 'In Queue', value: queue.length, color: '#f59e0b' },
                    { label: 'Offering', value: queue.filter(q => q.status === 'offering').length, color: '#10b981' },
                    { label: 'Longest Wait', value: queue.length > 0 ? formatWait(Math.max(...queue.map(q => q.wait_time_sec))) : '—', color: '#ef4444' },
                    { label: 'Agents Available', value: onlineAgents.length, color: '#8b5cf6' },
                ].map(s => (
                    <div key={s.label} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 20px', flex: 1, display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ fontSize: 22, fontWeight: 700, color: s.color }}>{s.value}</div>
                        <div style={{ fontSize: 12, color: '#6b7280' }}>{s.label}</div>
                    </div>
                ))}
            </div>

            {/* Two-column layout */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 16 }}>
                {/* Queue list */}
                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                    <h3 style={{ fontSize: 14, fontWeight: 600, color: '#374151', margin: '0 0 14px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Queued Calls</h3>
                    {queue.length === 0 ? (
                        <div style={{ padding: 40, textAlign: 'center' }}>
                            <Phone size={40} style={{ color: '#d1d5db', marginBottom: 12 }} />
                            <div style={{ fontSize: 15, fontWeight: 500, color: '#6b7280', marginBottom: 4 }}>No calls in queue</div>
                            <div style={{ fontSize: 13, color: '#9ca3af' }}>New inbound calls will appear here when agents are busy</div>
                        </div>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {queue.map(q => (
                                <div key={q.id} onClick={() => setSelectedCall(q)} style={{
                                    display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px',
                                    background: selectedCall?.id === q.id ? '#f0f0ff' : q.wait_time_sec > 120 ? '#fef2f2' : '#f9fafb',
                                    borderRadius: 10, cursor: 'pointer', border: selectedCall?.id === q.id ? '1px solid #c7d2fe' : '1px solid transparent',
                                    transition: 'all 0.1s',
                                }}>
                                    <div style={{ width: 40, height: 40, borderRadius: '50%', background: q.wait_time_sec > 120 ? '#fee2e2' : '#ede9fe', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                        <PhoneIncoming size={18} style={{ color: q.wait_time_sec > 120 ? '#ef4444' : '#8b5cf6' }} />
                                    </div>
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontSize: 14, fontWeight: 600 }}>{q.caller_name || q.caller_phone}</div>
                                        <div style={{ fontSize: 12, color: '#6b7280' }}>
                                            {q.caller_name ? <span style={{ fontFamily: 'monospace', fontSize: 11, marginRight: 8 }}>{q.caller_phone}</span> : null}
                                            {q.number_group} · {q.flow_step}
                                        </div>
                                    </div>
                                    <div style={{ textAlign: 'right' }}>
                                        <div style={{ fontSize: 15, fontWeight: 700, color: q.wait_time_sec > 120 ? '#ef4444' : '#f59e0b', display: 'flex', alignItems: 'center', gap: 4 }}>
                                            <Clock size={13} />{formatWait(q.wait_time_sec)}
                                        </div>
                                        <div style={{ fontSize: 10, color: '#9ca3af' }}>Position #{q.position}</div>
                                    </div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-end' }}>
                                        {q.badges.map(b => <span key={b} style={{ fontSize: 9, fontWeight: 600, padding: '2px 6px', borderRadius: 8, background: '#dbeafe', color: '#1e40af' }}>{b}</span>)}
                                        <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 8, background: q.status === 'offering' ? '#d1fae5' : '#f3f4f6', color: q.status === 'offering' ? '#065f46' : '#6b7280' }}>{q.status}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Right panel: Agent + action */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {/* Selected call actions */}
                    {selectedCall && (
                        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                            <h3 style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 12px' }}>Actions</h3>
                            <div style={{ fontSize: 13, marginBottom: 12 }}>
                                <strong>{selectedCall.caller_name || selectedCall.caller_phone}</strong> waiting {formatWait(selectedCall.wait_time_sec)}
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                <button style={{ width: '100%', padding: '10px', fontSize: 13, fontWeight: 600, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}><Phone size={14} />Connect to Me</button>
                                <button style={{ width: '100%', padding: '10px', fontSize: 13, fontWeight: 500, background: '#fff', color: '#6366f1', border: '1px solid #6366f1', borderRadius: 8, cursor: 'pointer' }}>Transfer to Agent…</button>
                                <button style={{ width: '100%', padding: '10px', fontSize: 13, fontWeight: 500, background: '#fef2f2', color: '#ef4444', border: '1px solid #fca5a5', borderRadius: 8, cursor: 'pointer' }}>Send to Voicemail</button>
                            </div>
                        </div>
                    )}

                    {/* Agents */}
                    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, flex: 1 }}>
                        <h3 style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 12px' }}>Agents</h3>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {agents.map(a => (
                                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: '#f9fafb', borderRadius: 8 }}>
                                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor[a.status] || '#d1d5db', flexShrink: 0 }} />
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontSize: 13, fontWeight: 500 }}>{a.name}</div>
                                        <div style={{ fontSize: 11, color: '#6b7280' }}>{a.user_group}</div>
                                    </div>
                                    <span style={{ fontSize: 11, fontWeight: 500, textTransform: 'capitalize', color: statusColor[a.status] }}>{a.status.replace('_', ' ')}</span>
                                    {a.status === 'on_call' && <Headphones size={13} style={{ color: '#3b82f6' }} />}
                                    {!a.device_ready && <AlertCircle size={13} style={{ color: '#f59e0b' }} />}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
