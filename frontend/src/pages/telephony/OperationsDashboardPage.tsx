import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { LayoutDashboard, TrendingUp, TrendingDown, Minus, PhoneCall, Timer, Users, ArrowRightLeft } from 'lucide-react';
import { telephonyApi } from '../../services/telephonyApi';
import type { DashboardKPI, OperationsDashboardData, OperationGroup, OperationCall } from '../../types/telephony';

const TREND_ICON = { up: <TrendingUp size={12} />, down: <TrendingDown size={12} />, flat: <Minus size={12} /> };
const statusColors: Record<string, { bg: string; dot: string }> = {
    available: { bg: '#d1fae5', dot: '#10b981' },
    on_call: { bg: '#dbeafe', dot: '#3b82f6' },
    away: { bg: '#fef3c7', dot: '#f59e0b' },
    offline: { bg: '#f3f4f6', dot: '#9ca3af' },
};

function formatSeconds(seconds: number): string {
    if (!seconds || seconds < 1) return '0s';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

export default function OperationsDashboardPage() {
    const [data, setData] = useState<OperationsDashboardData>({ groups: [], agents: [], queue: [], kpis: [] });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [transferTargets, setTransferTargets] = useState<Record<string, string>>({});
    const [transfering, setTransfering] = useState<string | null>(null);

    const load = async () => {
        setLoading(true);
        setError(null);
        try {
            setData(await telephonyApi.getOperationsDashboard());
        } catch (err) {
            console.error('[OperationsDashboard] failed to load:', err);
            setError(err instanceof Error ? err.message : 'Failed to load operations dashboard');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { load(); }, []);

    const transferCall = async (call: OperationCall) => {
        const target = transferTargets[call.call_sid];
        if (!target) return;
        setTransfering(call.call_sid);
        try {
            await telephonyApi.transferCall(call.call_sid, target);
            await load();
        } catch (err) {
            console.error('[OperationsDashboard] transfer failed:', err);
            alert('Failed to transfer call');
        } finally {
            setTransfering(null);
        }
    };

    return (
        <div style={{ padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
                <LayoutDashboard size={20} style={{ color: '#6366f1' }} />
                <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Operations Dashboard</h1>
            </div>

            <Kpis kpis={data.kpis} />

            {loading ? (
                <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading operations...</div>
            ) : error ? (
                <div style={{ padding: 40, textAlign: 'center', color: '#b91c1c' }}>{error}</div>
            ) : data.groups.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No user groups configured.</div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {data.groups.map(group => (
                        <GroupBlock
                            key={group.id}
                            group={group}
                            transferTargets={transferTargets}
                            transfering={transfering}
                            onTargetChange={(callSid, userId) => setTransferTargets(current => ({ ...current, [callSid]: userId }))}
                            onTransfer={transferCall}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function Kpis({ kpis }: { kpis: DashboardKPI[] }) {
    return (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 24 }}>
            {kpis.map(k => (
                <div key={k.label} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '16px 18px' }}>
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
    );
}

function GroupBlock({ group, transferTargets, transfering, onTargetChange, onTransfer }: {
    group: OperationGroup;
    transferTargets: Record<string, string>;
    transfering: string | null;
    onTargetChange: (callSid: string, userId: string) => void;
    onTransfer: (call: OperationCall) => void;
}) {
    const availableTargets = group.agents.filter(agent => agent.phone_calls_allowed !== false && agent.status === 'available');

    return (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid #f3f4f6' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Users size={16} style={{ color: '#6366f1' }} />
                    <div>
                        <div style={{ fontSize: 15, fontWeight: 700 }}>{group.name}</div>
                        <div style={{ fontSize: 12, color: '#6b7280' }}>
                            {group.active_calls.length} talking - {group.waiting_count} queued - longest wait {formatSeconds(group.longest_wait_seconds)}
                        </div>
                    </div>
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 10, background: group.reachable ? '#d1fae5' : '#fef2f2', color: group.reachable ? '#047857' : '#b91c1c' }}>
                    {group.reachable ? 'Reachable' : 'Voicemail risk'}
                </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 0 }}>
                <div style={{ padding: 18, borderRight: '1px solid #f3f4f6' }}>
                    <SectionTitle icon={<PhoneCall size={14} />} label={`Active calls (${group.active_calls.length})`} />
                    {group.active_calls.length === 0 && <EmptyLine text="No active calls" />}
                    {group.active_calls.map(call => (
                        <CallRow
                            key={call.call_sid}
                            call={call}
                            targets={availableTargets}
                            selectedTarget={transferTargets[call.call_sid] || ''}
                            transfering={transfering === call.call_sid}
                            onTargetChange={onTargetChange}
                            onTransfer={onTransfer}
                        />
                    ))}

                    <div style={{ height: 14 }} />
                    <SectionTitle icon={<Timer size={14} />} label={`Queue (${group.queued_calls.length})`} />
                    {group.queued_calls.length === 0 && <EmptyLine text="Queue is clear" />}
                    {group.queued_calls.map(call => (
                        <div key={call.call_sid} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
                            <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{call.caller_name || call.caller}</span>
                            <span style={{ fontSize: 12, color: '#6b7280' }}>{formatSeconds(call.wait_seconds)}</span>
                            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: '#fef3c7', color: '#92400e', fontWeight: 700 }}>{call.current_node_kind || 'queue'}</span>
                        </div>
                    ))}
                </div>

                <div style={{ padding: 18 }}>
                    <SectionTitle icon={<Users size={14} />} label={`Agents (${group.agents.length})`} />
                    {group.agents.map(agent => {
                        const sc = statusColors[agent.status] || statusColors.offline;
                        return (
                            <div key={agent.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
                                <div style={{ width: 8, height: 8, borderRadius: '50%', background: sc.dot }} />
                                <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{agent.name}</span>
                                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: sc.bg, color: sc.dot, fontWeight: 600 }}>{agent.status.replace('_', ' ')}</span>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

function CallRow({ call, targets, selectedTarget, transfering, onTargetChange, onTransfer }: {
    call: OperationCall;
    targets: OperationGroup['agents'];
    selectedTarget: string;
    transfering: boolean;
    onTargetChange: (callSid: string, userId: string) => void;
    onTransfer: (call: OperationCall) => void;
}) {
    return (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px 170px 96px', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
            <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{call.caller_name || call.caller}</div>
                <div style={{ fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{call.called_number}</div>
            </div>
            <span style={{ fontSize: 12, color: '#6b7280' }}>{formatSeconds(call.duration_sec || call.wait_seconds)}</span>
            <select
                value={selectedTarget}
                onChange={event => onTargetChange(call.call_sid, event.target.value)}
                style={{ height: 32, border: '1px solid #d1d5db', borderRadius: 8, padding: '0 8px', fontSize: 12, background: '#fff' }}
            >
                <option value="">Transfer to...</option>
                {targets.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </select>
            <button
                disabled={!selectedTarget || transfering}
                onClick={() => onTransfer(call)}
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4, height: 32, border: 'none', borderRadius: 8, background: selectedTarget && !transfering ? '#6366f1' : '#d1d5db', color: '#fff', fontSize: 12, fontWeight: 700, cursor: selectedTarget && !transfering ? 'pointer' : 'default' }}
            >
                <ArrowRightLeft size={13} />{transfering ? '...' : 'Transfer'}
            </button>
        </div>
    );
}

function SectionTitle({ icon, label }: { icon: ReactNode; label: string }) {
    return <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>{icon}{label}</div>;
}

function EmptyLine({ text }: { text: string }) {
    return <div style={{ fontSize: 12, color: '#9ca3af', padding: '8px 0' }}>{text}</div>;
}
