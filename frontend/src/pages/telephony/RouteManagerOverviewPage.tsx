import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Phone, Calendar, Users, GitBranch, PhoneIncoming, PhoneMissed, Voicemail, Plus, AlertTriangle } from 'lucide-react';
import { telephonyApi } from '../../services/telephonyMockApi';
import type { RouteManagerKPIs, PhoneNumberGroup } from '../../types/telephony';

function KPICard({ icon: Icon, label, value, color }: { icon: any; label: string; value: number; color: string }) {
    return (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '20px 24px', display: 'flex', alignItems: 'center', gap: 16, flex: 1, minWidth: 180 }}>
            <div style={{ width: 44, height: 44, borderRadius: 10, background: color + '15', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon size={22} style={{ color }} />
            </div>
            <div>
                <div style={{ fontSize: 28, fontWeight: 700, color: '#111', lineHeight: 1 }}>{value}</div>
                <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>{label}</div>
            </div>
        </div>
    );
}

export default function RouteManagerOverviewPage() {
    const navigate = useNavigate();
    const [kpis, setKpis] = useState<RouteManagerKPIs | null>(null);
    const [groups, setGroups] = useState<PhoneNumberGroup[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        (async () => {
            const [k, g] = await Promise.all([telephonyApi.getOverviewKPIs(), telephonyApi.getPhoneNumberGroups()]);
            setKpis(k); setGroups(g); setLoading(false);
        })();
    }, []);

    if (loading) return <div style={{ padding: 32 }}><div style={{ width: 24, height: 24, border: '3px solid #e5e7eb', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 1s linear infinite' }} /></div>;

    return (
        <div style={{ padding: '24px 32px', maxWidth: 1200 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
                <div>
                    <h1 style={{ fontSize: 24, fontWeight: 700, color: '#111', margin: 0 }}>Route Manager</h1>
                    <p style={{ fontSize: 14, color: '#6b7280', margin: '4px 0 0' }}>Manage phone number groups, schedules, and call routing</p>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => navigate('/settings/telephony/groups')} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', fontSize: 13, fontWeight: 500, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}><Plus size={16} />New Group</button>
                    <button onClick={() => navigate('/settings/telephony/schedules')} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', fontSize: 13, fontWeight: 500, background: '#fff', color: '#374151', border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer' }}><Calendar size={16} />Schedules</button>
                    <button onClick={() => navigate('/settings/telephony/user-groups')} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', fontSize: 13, fontWeight: 500, background: '#fff', color: '#374151', border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer' }}><Users size={16} />User Groups</button>
                </div>
            </div>

            {kpis && (
                <div style={{ display: 'flex', gap: 16, marginBottom: 28, flexWrap: 'wrap' }}>
                    <KPICard icon={Phone} label="Active Groups" value={kpis.active_groups} color="#6366f1" />
                    <KPICard icon={GitBranch} label="Active Flows" value={kpis.active_flows} color="#8b5cf6" />
                    <KPICard icon={PhoneIncoming} label="Queued Now" value={kpis.queued_now} color="#f59e0b" />
                    <KPICard icon={PhoneMissed} label="Unanswered Today" value={kpis.unanswered_today} color="#ef4444" />
                    <KPICard icon={Voicemail} label="Voicemails Today" value={kpis.voicemails_today} color="#10b981" />
                </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                        <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Phone Number Groups</h3>
                        <button onClick={() => navigate('/settings/telephony/groups')} style={{ fontSize: 12, color: '#6366f1', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 500 }}>View all →</button>
                    </div>
                    {groups.length === 0 ? (
                        <p style={{ fontSize: 13, color: '#9ca3af', textAlign: 'center', padding: 24 }}>No groups configured yet</p>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {groups.map(g => (
                                <div key={g.id} onClick={() => navigate(`/settings/telephony/groups/${g.id}`)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', background: '#fafafa', borderRadius: 8, cursor: 'pointer', transition: 'background 0.15s' }} onMouseEnter={e => { e.currentTarget.style.background = '#f3f4f6'; }} onMouseLeave={e => { e.currentTarget.style.background = '#fafafa'; }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                        <Phone size={16} style={{ color: '#6366f1' }} />
                                        <span style={{ fontSize: 14, fontWeight: 500 }}>{g.name}</span>
                                        {g.is_default && <span style={{ fontSize: 10, fontWeight: 600, background: '#dbeafe', color: '#1d4ed8', padding: '2px 6px', borderRadius: 4 }}>DEFAULT</span>}
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 12, color: '#6b7280' }}>
                                        <span>{g.numbers_count} numbers</span>
                                        {g.queued_calls_now > 0 && <span style={{ color: '#f59e0b', fontWeight: 600 }}>{g.queued_calls_now} queued</span>}
                                        {g.unanswered_today > 0 && <span style={{ color: '#ef4444' }}>{g.unanswered_today} missed</span>}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                        <h3 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 12px' }}>Quick Actions</h3>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {[
                                { label: 'Create Phone Number Group', icon: Phone, path: '/settings/telephony/groups' },
                                { label: 'Create Schedule', icon: Calendar, path: '/settings/telephony/schedules' },
                                { label: 'Create User Group', icon: Users, path: '/settings/telephony/user-groups' },
                                { label: 'Create Call Flow', icon: GitBranch, path: '/settings/telephony/call-flows' },
                            ].map(a => (
                                <button key={a.label} onClick={() => navigate(a.path)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: '#fafafa', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 500, color: '#374151', width: '100%', textAlign: 'left' }}><a.icon size={16} style={{ color: '#6366f1' }} />{a.label}</button>
                            ))}
                        </div>
                    </div>

                    <div style={{ background: '#fffbeb', border: '1px solid #fbbf24', borderRadius: 12, padding: 20 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                            <AlertTriangle size={16} style={{ color: '#f59e0b' }} />
                            <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0, color: '#92400e' }}>Setup Checklist</h3>
                        </div>
                        <div style={{ fontSize: 13, color: '#78350f', lineHeight: 1.6 }}>
                            <div>✓ Phone Number Groups configured</div>
                            <div>✓ Schedules created</div>
                            <div style={{ opacity: 0.5 }}>○ Call Flows not yet configured</div>
                            <div style={{ opacity: 0.5 }}>○ Routing engine not connected</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
