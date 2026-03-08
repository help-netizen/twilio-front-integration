import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Users, Shield, Zap, Clock, User, Circle } from 'lucide-react';
import { telephonyApi } from '../../services/telephonyMockApi';
import type { UserGroupDetail, RoutingMode, RoutingStrategy, FallbackAction } from '../../types/telephony';

const MODE_LABELS: Record<RoutingMode, string> = { queue_pull: 'Queue Pull', auto_offer: 'Auto Offer' };
const STRATEGY_LABELS: Record<RoutingStrategy, string> = { round_robin: 'Round Robin', longest_idle: 'Longest Idle', fixed_priority: 'Fixed Priority' };
const FALLBACK_LABELS: Record<FallbackAction, string> = { voicemail: 'Voicemail', forward_external: 'Forward External', hangup: 'Hangup' };

export default function UserGroupDetailPage() {
    const { groupId } = useParams<{ groupId: string }>();
    const navigate = useNavigate();
    const [group, setGroup] = useState<UserGroupDetail | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (groupId) telephonyApi.getUserGroup(groupId).then(g => { setGroup(g); setLoading(false); });
    }, [groupId]);

    if (loading) return <div style={{ padding: 32 }}><div style={{ width: 24, height: 24, border: '3px solid #e5e7eb', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 1s linear infinite' }} /></div>;
    if (!group) return <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>Group not found</div>;

    return (
        <div style={{ padding: '24px 32px', maxWidth: 900 }}>
            <button onClick={() => navigate('/settings/telephony/user-groups')} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#6366f1', background: 'none', border: 'none', cursor: 'pointer', marginBottom: 16, padding: 0 }}><ArrowLeft size={16} />Back to User Groups</button>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
                <div style={{ width: 44, height: 44, borderRadius: 10, background: '#eef2ff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Users size={22} style={{ color: '#6366f1' }} /></div>
                <div>
                    <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111', margin: 0 }}>{group.name}</h1>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 13, color: '#6b7280', marginTop: 4 }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Zap size={12} />{MODE_LABELS[group.routing_mode]}</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Shield size={12} />{STRATEGY_LABELS[group.strategy]}</span>
                    </div>
                </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                {/* Members */}
                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                    <h3 style={{ fontSize: 14, fontWeight: 600, color: '#374151', margin: '0 0 14px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Members ({group.members.length})</h3>
                    {group.members.length === 0 ? (
                        <p style={{ fontSize: 13, color: '#9ca3af', textAlign: 'center', padding: 16 }}>No members</p>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {group.members.sort((a, b) => a.priority - b.priority).map(m => (
                                <div key={m.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', background: '#f9fafb', borderRadius: 8 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                        <div style={{ position: 'relative' }}>
                                            <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><User size={16} style={{ color: '#6b7280' }} /></div>
                                            <Circle size={10} fill={m.is_online ? '#10b981' : '#d1d5db'} stroke="none" style={{ position: 'absolute', bottom: -1, right: -1 }} />
                                        </div>
                                        <div>
                                            <div style={{ fontSize: 13, fontWeight: 500 }}>{m.user_name}</div>
                                            <div style={{ fontSize: 11, color: '#9ca3af' }}>{m.user_email}</div>
                                        </div>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                        {group.strategy === 'fixed_priority' && <span style={{ fontSize: 11, fontWeight: 600, background: '#eef2ff', color: '#6366f1', padding: '2px 6px', borderRadius: 4 }}>P{m.priority}</span>}
                                        <span style={{ fontSize: 11, fontWeight: 500, color: m.is_active ? '#10b981' : '#d1d5db' }}>{m.is_active ? 'Active' : 'Inactive'}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Routing Policy */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                        <h3 style={{ fontSize: 14, fontWeight: 600, color: '#374151', margin: '0 0 14px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Routing Policy</h3>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f0f0f0' }}>
                                <span style={{ fontSize: 13, color: '#6b7280' }}>Mode</span>
                                <span style={{ fontSize: 13, fontWeight: 600 }}>{MODE_LABELS[group.routing_mode]}</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f0f0f0' }}>
                                <span style={{ fontSize: 13, color: '#6b7280' }}>Strategy</span>
                                <span style={{ fontSize: 13, fontWeight: 600 }}>{STRATEGY_LABELS[group.strategy]}</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f0f0f0' }}>
                                <span style={{ fontSize: 13, color: '#6b7280' }}>Offer Timeout</span>
                                <span style={{ fontSize: 13, fontWeight: 600 }}>{group.offer_timeout_sec}s</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f0f0f0' }}>
                                <span style={{ fontSize: 13, color: '#6b7280' }}>Per-user Capacity</span>
                                <span style={{ fontSize: 13, fontWeight: 600 }}>{group.per_user_capacity}</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
                                <span style={{ fontSize: 13, color: '#6b7280' }}>Fallback</span>
                                <span style={{ fontSize: 13, fontWeight: 600 }}>{FALLBACK_LABELS[group.fallback_action]}</span>
                            </div>
                        </div>
                    </div>

                    <div style={{ background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 12, padding: 20 }}>
                        <h3 style={{ fontSize: 14, fontWeight: 600, color: '#5b21b6', margin: '0 0 10px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Clock size={16} />Test Routing Preview</div>
                        </h3>
                        <p style={{ fontSize: 13, color: '#7c3aed', lineHeight: 1.6, margin: 0 }}>
                            Next call would be offered to: <strong>{group.members.filter(m => m.is_online && m.is_active).map(m => m.user_name).join(', ') || 'No available operators'}</strong>
                            <br />Strategy: {STRATEGY_LABELS[group.strategy]} with {group.offer_timeout_sec}s timeout
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
