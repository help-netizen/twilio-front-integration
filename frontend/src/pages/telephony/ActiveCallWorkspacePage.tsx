import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { PhoneOff, Mic, MicOff, Pause, Play, ArrowLeft, User, Briefcase, Clock, FileText, Volume2 } from 'lucide-react';
import { extendedMockApi, type ActiveCallInfo } from '../../services/extendedMockApi';

function formatDuration(sec: number) {
    const m = Math.floor(sec / 60); const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function ActiveCallWorkspacePage() {
    const { callId } = useParams<{ callId: string }>();
    const navigate = useNavigate();
    const [call, setCall] = useState<ActiveCallInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [muted, setMuted] = useState(false);
    const [onHold, setOnHold] = useState(false);
    const [notes, setNotes] = useState('');
    const [showQuickCreate, setShowQuickCreate] = useState(false);

    useEffect(() => {
        if (!callId) return;
        extendedMockApi.getActiveCall(callId).then(c => { setCall(c); setNotes(c.notes); setLoading(false); });
    }, [callId]);

    if (loading || !call) return <div style={{ padding: 32 }}><div style={{ width: 24, height: 24, border: '3px solid #e5e7eb', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 1s linear infinite' }} /></div>;

    const stateColor: Record<string, string> = { connecting: '#f59e0b', ringing: '#f59e0b', connected: '#10b981', on_hold: '#3b82f6', ended: '#6b7280' };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 56px)' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 20px', background: '#fff', borderBottom: '1px solid #e5e7eb', flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <button onClick={() => navigate('/calls/dashboard')} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#6366f1', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}><ArrowLeft size={14} />Back</button>
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: stateColor[call.state] || '#6b7280', animation: call.state === 'connected' ? 'pulse 2s infinite' : 'none' }} />
                    <span style={{ fontSize: 14, fontWeight: 600 }}>Live Call — {call.caller_name || call.caller_phone}</span>
                    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: `${stateColor[call.state]}20`, color: stateColor[call.state], textTransform: 'capitalize' }}>{call.state.replace('_', ' ')}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Clock size={14} style={{ color: '#6b7280' }} />
                    <span style={{ fontSize: 18, fontWeight: 700, fontFamily: 'monospace', color: '#111' }}>{formatDuration(call.duration_sec)}</span>
                    {call.is_recording && <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444', animation: 'pulse 1s infinite' }} title="Recording" />}
                </div>
            </div>

            {/* Main content */}
            <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
                {/* Left: Caller info */}
                <div style={{ width: 320, background: '#f9fafb', borderRight: '1px solid #e5e7eb', padding: 20, overflowY: 'auto', flexShrink: 0 }}>
                    {/* Caller card */}
                    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, marginBottom: 16 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                            <div style={{ width: 44, height: 44, borderRadius: '50%', background: '#ede9fe', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <User size={22} style={{ color: '#8b5cf6' }} />
                            </div>
                            <div>
                                <div style={{ fontSize: 15, fontWeight: 600 }}>{call.caller_name || 'Unknown'}</div>
                                <div style={{ fontSize: 12, fontFamily: 'monospace', color: '#6b7280' }}>{call.caller_phone}</div>
                            </div>
                        </div>
                        {call.matched_entity && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', background: '#f0fdf4', borderRadius: 8, fontSize: 12, marginBottom: 8 }}>
                                <Briefcase size={13} style={{ color: '#10b981' }} />
                                <span>Linked: <strong>{call.matched_entity.type}</strong> — {call.matched_entity.name}</span>
                            </div>
                        )}
                        <div style={{ fontSize: 12, color: '#6b7280' }}>{call.previous_calls} previous calls</div>
                    </div>

                    {/* Routing path */}
                    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, marginBottom: 16 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Routing Path</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            {call.flow_path.map((step, i) => (
                                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '4px 0' }}>
                                    <div style={{ width: 16, height: 16, borderRadius: '50%', background: i === call.flow_path.length - 1 ? '#10b981' : '#e5e7eb', color: i === call.flow_path.length - 1 ? '#fff' : '#6b7280', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, fontWeight: 700, flexShrink: 0 }}>{i + 1}</div>
                                    <span style={{ fontWeight: i === call.flow_path.length - 1 ? 600 : 400 }}>{step}</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Meta */}
                    <div style={{ fontSize: 12, color: '#6b7280', display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div><strong>Group:</strong> {call.number_group}</div>
                        <div><strong>Called:</strong> {call.called_number}</div>
                        <div><strong>Agent:</strong> {call.agent}</div>
                        {call.queue_source && <div><strong>Queue:</strong> {call.queue_source}</div>}
                    </div>
                </div>

                {/* Center: Controls + Notes */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#fff' }}>
                    {/* Call controls */}
                    <div style={{ padding: '24px', display: 'flex', justifyContent: 'center', gap: 12, borderBottom: '1px solid #e5e7eb' }}>
                        <button onClick={() => setMuted(m => !m)} style={{ width: 52, height: 52, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: muted ? '#fef2f2' : '#f3f4f6', color: muted ? '#ef4444' : '#374151', border: `2px solid ${muted ? '#fca5a5' : '#e5e7eb'}`, cursor: 'pointer' }}>
                            {muted ? <MicOff size={22} /> : <Mic size={22} />}
                        </button>
                        <button onClick={() => setOnHold(h => !h)} style={{ width: 52, height: 52, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: onHold ? '#eff6ff' : '#f3f4f6', color: onHold ? '#3b82f6' : '#374151', border: `2px solid ${onHold ? '#bfdbfe' : '#e5e7eb'}`, cursor: 'pointer' }}>
                            {onHold ? <Play size={22} /> : <Pause size={22} />}
                        </button>
                        <button style={{ width: 52, height: 52, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f3f4f6', color: '#374151', border: '2px solid #e5e7eb', cursor: 'pointer' }}>
                            <Volume2 size={22} />
                        </button>
                        <button style={{ width: 52, height: 52, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fef2f2', color: '#ef4444', border: '2px solid #fca5a5', cursor: 'pointer' }}>
                            <PhoneOff size={22} />
                        </button>
                    </div>

                    {/* Notes area */}
                    <div style={{ flex: 1, padding: 20, display: 'flex', flexDirection: 'column' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                            <FileText size={14} style={{ color: '#6b7280' }} />
                            <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Call Notes</span>
                        </div>
                        <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Type notes during the call..." style={{ flex: 1, width: '100%', padding: 12, border: '1px solid #d1d5db', borderRadius: 10, fontSize: 13, fontFamily: 'inherit', resize: 'none', outline: 'none' }} />
                    </div>

                    {/* Quick actions */}
                    <div style={{ padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', gap: 8 }}>
                        <button onClick={() => setShowQuickCreate(true)} style={{ padding: '8px 16px', fontSize: 12, fontWeight: 500, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>+ Create Lead</button>
                        <button style={{ padding: '8px 16px', fontSize: 12, fontWeight: 500, background: '#fff', color: '#6366f1', border: '1px solid #6366f1', borderRadius: 8, cursor: 'pointer' }}>+ Create Job</button>
                        <button style={{ padding: '8px 16px', fontSize: 12, fontWeight: 500, background: '#fff', color: '#374151', border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer' }}>Transfer…</button>
                    </div>
                </div>

                {/* Right: Quick Create Drawer (shown inline) */}
                {showQuickCreate && (
                    <div style={{ width: 360, background: '#fff', borderLeft: '1px solid #e5e7eb', padding: 20, overflowY: 'auto', flexShrink: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                            <h3 style={{ fontSize: 14, fontWeight: 600, color: '#111', margin: 0 }}>Quick Create</h3>
                            <button onClick={() => setShowQuickCreate(false)} style={{ fontSize: 18, color: '#9ca3af', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>×</button>
                        </div>
                        {/* Tabs */}
                        <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
                            {['Lead', 'Contact', 'Job'].map(t => (
                                <button key={t} style={{ flex: 1, padding: '8px', fontSize: 12, fontWeight: 500, background: t === 'Lead' ? '#6366f1' : '#f3f4f6', color: t === 'Lead' ? '#fff' : '#374151', border: 'none', borderRadius: 6, cursor: 'pointer' }}>{t}</button>
                            ))}
                        </div>
                        {/* Form */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                            <div>
                                <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>Name</label>
                                <input defaultValue={call.caller_name || ''} style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
                            </div>
                            <div>
                                <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>Phone</label>
                                <input readOnly value={call.caller_phone} style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#f9fafb', fontFamily: 'monospace' }} />
                            </div>
                            <div>
                                <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>Source</label>
                                <select style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff' }}>
                                    <option>Phone Call</option>
                                    <option>Website</option>
                                    <option>Referral</option>
                                </select>
                            </div>
                            <div>
                                <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>Notes</label>
                                <textarea rows={3} placeholder="Quick note..." style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', resize: 'none' }} />
                            </div>
                            <button style={{ width: '100%', padding: '10px', fontSize: 13, fontWeight: 600, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', marginTop: 4 }}>Save Lead</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
