import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Phone, Globe, GitBranch, Calendar, Clock, PhoneMissed, Voicemail, Hash } from 'lucide-react';
import { telephonyApi } from '../../services/telephonyMockApi';
import type { PhoneNumberGroupDetail } from '../../types/telephony';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, marginBottom: 16 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: '#374151', margin: '0 0 14px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</h3>
            {children}
        </div>
    );
}

function Stat({ icon: Icon, label, value, color }: { icon: any; label: string; value: string | number; color: string }) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0' }}>
            <Icon size={16} style={{ color }} />
            <span style={{ fontSize: 13, color: '#6b7280', flex: 1 }}>{label}</span>
            <span style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>{value}</span>
        </div>
    );
}

export default function PhoneNumberGroupDetailPage() {
    const { groupId } = useParams<{ groupId: string }>();
    const navigate = useNavigate();
    const [group, setGroup] = useState<PhoneNumberGroupDetail | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (groupId) telephonyApi.getPhoneNumberGroup(groupId).then(g => { setGroup(g); setLoading(false); });
    }, [groupId]);

    if (loading) return <div style={{ padding: 32 }}><div style={{ width: 24, height: 24, border: '3px solid #e5e7eb', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 1s linear infinite' }} /></div>;
    if (!group) return <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>Group not found</div>;

    return (
        <div style={{ padding: '24px 32px', maxWidth: 900 }}>
            <button onClick={() => navigate('/settings/telephony/groups')} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#6366f1', background: 'none', border: 'none', cursor: 'pointer', marginBottom: 16, padding: 0 }}><ArrowLeft size={16} />Back to Groups</button>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
                <div style={{ width: 44, height: 44, borderRadius: 10, background: '#eef2ff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Phone size={22} style={{ color: '#6366f1' }} /></div>
                <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111', margin: 0 }}>{group.name}</h1>
                        {group.is_default && <span style={{ fontSize: 10, fontWeight: 600, background: '#dbeafe', color: '#1d4ed8', padding: '2px 6px', borderRadius: 4 }}>DEFAULT</span>}
                        <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: '#d1fae5', color: '#065f46' }}>{group.status}</span>
                    </div>
                    <div style={{ fontSize: 13, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}><Globe size={12} />{group.timezone}</div>
                </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div>
                    <Section title="Assigned Numbers">
                        {group.numbers.length === 0 ? (
                            <p style={{ fontSize: 13, color: '#9ca3af', textAlign: 'center', padding: 16 }}>No numbers assigned</p>
                        ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                {group.numbers.map(n => (
                                    <div key={n.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: '#f9fafb', borderRadius: 8 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                            <Hash size={14} style={{ color: '#6b7280' }} />
                                            <span style={{ fontSize: 13, fontWeight: 500, fontFamily: 'monospace' }}>{n.phone_number}</span>
                                        </div>
                                        <span style={{ fontSize: 12, color: '#9ca3af' }}>{n.friendly_name}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </Section>

                    <Section title="Active Flow">
                        {group.active_flow_name ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', background: '#f5f3ff', borderRadius: 8 }}>
                                <GitBranch size={18} style={{ color: '#8b5cf6' }} />
                                <div>
                                    <div style={{ fontSize: 14, fontWeight: 500 }}>{group.active_flow_name}</div>
                                    <div style={{ fontSize: 12, color: '#6b7280' }}>Version {group.active_flow_version}</div>
                                </div>
                            </div>
                        ) : (
                            <p style={{ fontSize: 13, color: '#9ca3af', textAlign: 'center', padding: 16 }}>No flow assigned</p>
                        )}
                    </Section>

                    <Section title="Linked Schedule">
                        {group.schedule_name ? (
                            <div onClick={() => navigate(`/settings/telephony/schedules/${group.schedule_id}`)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', background: '#f0fdf4', borderRadius: 8, cursor: 'pointer' }}>
                                <Calendar size={18} style={{ color: '#10b981' }} />
                                <div>
                                    <div style={{ fontSize: 14, fontWeight: 500 }}>{group.schedule_name}</div>
                                    <div style={{ fontSize: 12, color: '#6b7280' }}>Click to view</div>
                                </div>
                            </div>
                        ) : (
                            <p style={{ fontSize: 13, color: '#9ca3af', textAlign: 'center', padding: 16 }}>No schedule linked</p>
                        )}
                    </Section>
                </div>

                <div>
                    <Section title="Runtime Summary">
                        <Stat icon={PhoneMissed} label="Queued Now" value={group.runtime_summary.queued_now} color="#f59e0b" />
                        <Stat icon={Clock} label="Avg Wait Time" value={`${group.runtime_summary.avg_wait_time_sec}s`} color="#6366f1" />
                        <Stat icon={PhoneMissed} label="Unanswered Today" value={group.runtime_summary.unanswered_today} color="#ef4444" />
                        <Stat icon={Voicemail} label="Voicemails Today" value={group.runtime_summary.voicemails_today} color="#10b981" />
                        <Stat icon={Clock} label="Last Inbound" value={group.runtime_summary.last_inbound_at ? new Date(group.runtime_summary.last_inbound_at).toLocaleString() : '—'} color="#6b7280" />
                    </Section>

                    <Section title="Troubleshooting">
                        <div style={{ fontSize: 13, color: '#6b7280', textAlign: 'center', padding: 16 }}>
                            <div style={{ color: '#10b981', fontWeight: 500, marginBottom: 4 }}>✓ No recent errors</div>
                            <div>All routing healthy</div>
                        </div>
                    </Section>
                </div>
            </div>
        </div>
    );
}
