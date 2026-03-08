import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Phone, Clock, FileText } from 'lucide-react';
import { telephonyApi } from '../../services/telephonyApi';
import type { ActiveCallInfo } from '../../types/telephony';

export default function ActiveCallWorkspacePage() {
    const { callId } = useParams<{ callId: string }>();
    const [call, setCall] = useState<ActiveCallInfo | null>(null);
    useEffect(() => { if (callId) telephonyApi.getActiveCall(callId).then(setCall); }, [callId]);
    if (!call) return <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div>;
    const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    return (
        <div style={{ padding: 24, display: 'grid', gridTemplateColumns: '280px 1fr 300px', gap: 16, height: 'calc(100vh - 100px)' }}>
            {/* Caller Info */}
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                <div style={{ textAlign: 'center', marginBottom: 16 }}>
                    <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#ede9fe', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', fontSize: 24, color: '#6366f1' }}>{call.caller_name[0]}</div>
                    <div style={{ fontSize: 16, fontWeight: 700 }}>{call.caller_name}</div>
                    <div style={{ fontSize: 13, color: '#6b7280' }}>{call.caller_phone}</div>
                </div>
                <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#6b7280' }}>Direction</span><span style={{ fontWeight: 500 }}>{call.direction}</span></div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#6b7280' }}>Agent</span><span style={{ fontWeight: 500 }}>{call.agent}</span></div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#6b7280' }}>Duration</span><span style={{ fontWeight: 500 }}>{fmtDur(call.duration_sec)}</span></div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#6b7280' }}>Status</span><span style={{ fontWeight: 600, color: '#10b981' }}>{call.status}</span></div>
                </div>
            </div>
            {/* Call Controls */}
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                    <Phone size={18} style={{ color: '#10b981' }} />
                    <span style={{ fontSize: 16, fontWeight: 600 }}>Active Call — {fmtDur(call.duration_sec)}</span>
                    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: '#d1fae5', color: '#065f46' }}>{call.status}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
                    <button style={{ padding: '8px 18px', fontSize: 13, background: '#fef3c7', color: '#92400e', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 500 }}>Hold</button>
                    <button style={{ padding: '8px 18px', fontSize: 13, background: '#dbeafe', color: '#1e40af', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 500 }}>Transfer</button>
                    <button style={{ padding: '8px 18px', fontSize: 13, background: '#fef2f2', color: '#ef4444', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 500 }}>End Call</button>
                </div>
                <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}><FileText size={14} />Notes</div>
                    <textarea defaultValue={call.notes.join('\n')} rows={4} style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', resize: 'vertical' }} />
                </div>
            </div>
            {/* Timeline */}
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}><Clock size={15} />Call Timeline</div>
                {call.timeline.map((e, i) => (
                    <div key={i} style={{ display: 'flex', gap: 10, padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
                        <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace', minWidth: 60 }}>{e.time}</span>
                        <span style={{ fontSize: 12, color: '#374151' }}>{e.event}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
