import { useState, useEffect } from 'react';
import { ListOrdered } from 'lucide-react';
import { telephonyApi } from '../../services/telephonyApi';
import type { QueuedCall, AgentStatus } from '../../types/telephony';

const statusColors: Record<string, { bg: string; dot: string }> = {
    available: { bg: '#d1fae5', dot: '#10b981' }, on_call: { bg: '#dbeafe', dot: '#3b82f6' },
    away: { bg: '#fef3c7', dot: '#f59e0b' }, offline: { bg: '#f3f4f6', dot: '#9ca3af' },
};

export default function QueueOperationsPage() {
    const [queue, setQueue] = useState<QueuedCall[]>([]);
    const [agents, setAgents] = useState<AgentStatus[]>([]);
    useEffect(() => { telephonyApi.getQueue().then(setQueue); telephonyApi.getAgents().then(setAgents); }, []);
    return (
        <div style={{ padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
                <ListOrdered size={20} style={{ color: '#6366f1' }} />
                <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Queue Operations</h1>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div>
                    <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Queued Calls ({queue.length})</div>
                    {queue.length === 0 ? <div style={{ padding: 20, textAlign: 'center', color: '#9ca3af', background: '#f9fafb', borderRadius: 8 }}>No calls in queue</div> :
                        queue.map(q => (
                            <div key={q.id} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '12px 16px', marginBottom: 8 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                                    <span style={{ fontSize: 14, fontWeight: 600 }}>{q.caller_name || q.caller}</span>
                                    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: q.priority === 'vip' ? '#fef2f2' : q.priority === 'high' ? '#fef3c7' : '#f3f4f6', color: q.priority === 'vip' ? '#ef4444' : q.priority === 'high' ? '#f59e0b' : '#6b7280' }}>{q.priority}</span>
                                </div>
                                <div style={{ fontSize: 12, color: '#6b7280' }}>{q.caller} · {q.queue_name} · Waiting {q.wait_seconds}s</div>
                            </div>
                        ))}
                </div>
                <div>
                    <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Available Agents</div>
                    {agents.map(a => {
                        const sc = statusColors[a.status] || statusColors.offline;
                        return (
                            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, marginBottom: 6 }}>
                                <div style={{ width: 8, height: 8, borderRadius: '50%', background: sc.dot }} />
                                <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{a.name}</span>
                                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: sc.bg, color: sc.dot, fontWeight: 600 }}>{a.status}</span>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
