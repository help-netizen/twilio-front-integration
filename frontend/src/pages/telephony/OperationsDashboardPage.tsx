import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { TrendingUp, TrendingDown, Minus, PhoneCall, Timer, Users, ArrowRightLeft } from 'lucide-react';
import { toast } from 'sonner';
import { telephonyApi } from '../../services/telephonyApi';
import type { DashboardKPI, OperationsDashboardData, OperationGroup, OperationCall } from '../../types/telephony';

const INK1 = 'var(--blanc-ink-1, #202734)';
const INK3 = 'var(--blanc-ink-3, #7d8796)';
const JOB = 'var(--blanc-job, #2f63d8)';
const OK = 'var(--blanc-success, #1b8b63)';
const WARN = 'var(--blanc-warning, #b26a1d)';
const DANGER = 'var(--blanc-danger, #d44d3c)';
const LINE = 'var(--blanc-line, rgba(117,106,89,0.18))';
const ROW = 'rgba(117,106,89,0.1)';
const SURFACE = 'var(--blanc-surface-strong, #fffdf9)';

const TREND_ICON = { up: <TrendingUp size={12} />, down: <TrendingDown size={12} />, flat: <Minus size={12} /> };
const statusTone: Record<string, { bg: string; color: string }> = {
    available: { bg: 'rgba(27,139,99,0.12)', color: OK },
    on_call: { bg: 'rgba(47,99,216,0.12)', color: JOB },
    away: { bg: 'rgba(178,106,29,0.12)', color: WARN },
    offline: { bg: 'rgba(117,106,89,0.1)', color: INK3 },
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
            toast.success('Call transferred');
            await load();
        } catch (err) {
            console.error('[OperationsDashboard] transfer failed:', err);
            toast.error('Failed to transfer call');
        } finally {
            setTransfering(null);
        }
    };

    return (
        <div style={{ padding: '28px 24px' }}>
            <div style={{ marginBottom: 20 }}>
                <div className="blanc-eyebrow">Telephony</div>
                <h1 style={{ fontSize: 24, fontWeight: 600, margin: '4px 0 0', fontFamily: 'var(--blanc-font-heading, Manrope), sans-serif', color: INK1 }}>Live operations</h1>
            </div>

            <Kpis kpis={data.kpis} />

            {loading ? (
                <div style={{ padding: 40, textAlign: 'center', color: INK3 }}>Loading operations…</div>
            ) : error ? (
                <div style={{ padding: 40, textAlign: 'center', color: DANGER }}>{error}</div>
            ) : data.groups.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: INK3, border: `1px dashed ${LINE}`, borderRadius: 16 }}>No user groups configured.</div>
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
                <div key={k.label} style={{ background: SURFACE, border: `1px solid ${LINE}`, borderRadius: 12, padding: '16px 18px' }}>
                    <div style={{ fontSize: 11, color: INK3, fontWeight: 500, marginBottom: 4 }}>{k.label}</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: INK1, fontFamily: 'var(--blanc-font-heading, Manrope), sans-serif' }}>{k.value}</div>
                    {k.change && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, color: k.trend === 'up' ? OK : k.trend === 'down' ? DANGER : INK3, marginTop: 4 }}>
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
        <div style={{ background: SURFACE, border: `1px solid ${LINE}`, borderRadius: 16, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Users size={16} style={{ color: JOB }} />
                    <div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: INK1 }}>{group.name}</div>
                        <div style={{ fontSize: 12, color: INK3 }}>
                            {group.active_calls.length} talking · {group.waiting_count} queued · longest wait {formatSeconds(group.longest_wait_seconds)}
                        </div>
                    </div>
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 10, background: group.reachable ? 'rgba(27,139,99,0.12)' : 'rgba(212,77,60,0.1)', color: group.reachable ? OK : DANGER }}>
                    {group.reachable ? 'Reachable' : 'Voicemail risk'}
                </span>
            </div>

            {/* Responsive: active calls + agents wrap to one column when cramped. */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 20, padding: '4px 18px 18px' }}>
                <div>
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
                        <div key={call.call_sid} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: `1px solid ${ROW}` }}>
                            <span style={{ fontSize: 13, fontWeight: 600, flex: 1, color: INK1 }}>{call.caller_name || call.caller}</span>
                            <span style={{ fontSize: 12, color: INK3 }}>{formatSeconds(call.wait_seconds)}</span>
                            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: 'rgba(178,106,29,0.12)', color: WARN, fontWeight: 700 }}>{call.current_node_kind || 'queue'}</span>
                        </div>
                    ))}
                </div>

                <div>
                    <SectionTitle icon={<Users size={14} />} label={`Agents (${group.agents.length})`} />
                    {group.agents.map(agent => {
                        const sc = statusTone[agent.status] || statusTone.offline;
                        return (
                            <div key={agent.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: `1px solid ${ROW}` }}>
                                <div style={{ width: 8, height: 8, borderRadius: '50%', background: sc.color }} />
                                <span style={{ fontSize: 13, fontWeight: 500, flex: 1, color: INK1 }}>{agent.name}</span>
                                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: sc.bg, color: sc.color, fontWeight: 600 }}>{agent.status.replace('_', ' ')}</span>
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
    // Caller info on the first line; the transfer cluster wraps below on narrow
    // widths instead of being crushed into fixed columns.
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 0', borderBottom: `1px solid ${ROW}` }}>
            <div style={{ minWidth: 0, flex: '1 1 160px' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: INK1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{call.caller_name || call.caller}</div>
                <div style={{ fontSize: 12, color: INK3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{call.called_number}</div>
            </div>
            <span style={{ fontSize: 12, color: INK3, flexShrink: 0 }}>{formatSeconds(call.duration_sec || call.wait_seconds)}</span>
            <div style={{ display: 'flex', gap: 8, flex: '1 1 240px', minWidth: 0 }}>
                <select
                    value={selectedTarget}
                    onChange={event => onTargetChange(call.call_sid, event.target.value)}
                    style={{ flex: 1, minWidth: 0, height: 32, border: `1px solid ${LINE}`, borderRadius: 8, padding: '0 8px', fontSize: 12, background: SURFACE, color: INK1 }}
                >
                    <option value="">Transfer to…</option>
                    {targets.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                </select>
                <button
                    disabled={!selectedTarget || transfering}
                    onClick={() => onTransfer(call)}
                    style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4, height: 32, padding: '0 12px', border: 'none', borderRadius: 8, background: selectedTarget && !transfering ? JOB : 'rgba(117,106,89,0.18)', color: '#fff', fontSize: 12, fontWeight: 700, cursor: selectedTarget && !transfering ? 'pointer' : 'default', flexShrink: 0 }}
                >
                    <ArrowRightLeft size={13} />{transfering ? '…' : 'Transfer'}
                </button>
            </div>
        </div>
    );
}

function SectionTitle({ icon, label }: { icon: ReactNode; label: string }) {
    return <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: INK3, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>{icon}{label}</div>;
}

function EmptyLine({ text }: { text: string }) {
    return <div style={{ fontSize: 12, color: INK3, padding: '8px 0' }}>{text}</div>;
}
