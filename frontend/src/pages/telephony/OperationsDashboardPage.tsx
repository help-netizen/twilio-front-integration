import { useState, useEffect } from 'react';
import { LayoutDashboard, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { telephonyApi } from '../../services/telephonyApi';
import type { DashboardKPI, AgentStatus, QueuedCall } from '../../types/telephony';

const TREND_ICON = { up: <TrendingUp size={12} />, down: <TrendingDown size={12} />, flat: <Minus size={12} /> };
const statusColors: Record<string, { bg: string; dot: string }> = {
    available: { bg: '#d1fae5', dot: '#10b981' }, on_call: { bg: '#dbeafe', dot: '#3b82f6' },
    away: { bg: '#fef3c7', dot: '#f59e0b' }, offline: { bg: '#f3f4f6', dot: '#9ca3af' },
};

export default function OperationsDashboardPage() {
    const [kpis, setKpis] = useState<DashboardKPI[]>([]);
    const [agents, setAgents] = useState<AgentStatus[]>([]);
    const [queue, setQueue] = useState<QueuedCall[]>([]);
    useEffect(() => { telephonyApi.getKpis().then(setKpis); telephonyApi.getAgents().then(setAgents); telephonyApi.getQueue().then(setQueue); }, []);

    return (
        <div style={{ padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
                <LayoutDashboard size={20} style={{ color: '#6366f1' }} />
                <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Operations Dashboard</h1>
            </div>
            {/* KPIs */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 24 }}>
                {kpis.map(k => (
                    <div key={k.label} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '16px 18px' }}>
                        <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 500, marginBottom: 4 }}>{k.label}</div>
                        <div style={{ fontSize: 22, fontWeight: 700, color: '#111' }}>{k.value}</div>
                        {k.change && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, color: k.trend === 'up' ? '#10b981' : k.trend === 'down' ? '#ef4444' : '#6b7280', marginTop: 4 }}>
                                {k.trend && TREND_ICON[k.trend]}{k.change}
                            </div>
                        )}
                    </div>
                ))}
            </div>
            {/* Agents + Queue */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Agents ({agents.length})</div>
                    {agents.map(a => {
                        const sc = statusColors[a.status] || statusColors.offline;
                        return (
                            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
                                <div style={{ width: 8, height: 8, borderRadius: '50%', background: sc.dot }} />
                                <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{a.name}</span>
                                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: sc.bg, color: sc.dot, fontWeight: 600 }}>{a.status}</span>
                            </div>
                        );
                    })}
                </div>
                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Queue ({queue.length})</div>
                    {queue.map(q => (
                        <div key={q.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
                            <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{q.caller_name || q.caller}</span>
                            <span style={{ fontSize: 11, color: '#6b7280' }}>{q.wait_seconds}s</span>
                            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, fontWeight: 600, background: q.priority === 'vip' ? '#fef2f2' : q.priority === 'high' ? '#fef3c7' : '#f3f4f6', color: q.priority === 'vip' ? '#ef4444' : q.priority === 'high' ? '#f59e0b' : '#6b7280' }}>{q.priority}</span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
