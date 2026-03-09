import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Users, Settings, GitBranch, Play, Phone, Calendar, Clock } from 'lucide-react';
import { NODE_KIND_META, type CallFlowNodeKind } from '../../types/telephony';
import { USER_GROUPS, STATUS_COLORS } from '../../data/userGroupsMock';

export default function UserGroupDetailPage() {
    const { groupId } = useParams<{ groupId: string }>();
    const navigate = useNavigate();
    const g = USER_GROUPS.find(ug => ug.id === groupId);
    if (!g) return <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Group not found</div>;

    return (
        <div style={{ padding: 24 }}>
            <button onClick={() => navigate('/settings/telephony/user-groups')} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#6366f1', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginBottom: 16 }}>
                <ArrowLeft size={14} />Back to User Groups
            </button>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>{g.name}</h1>
                <button style={{ padding: '4px 10px', fontSize: 11, background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Settings size={12} />Edit
                </button>
            </div>
            <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 20px' }}>
                {g.desc} · Ring strategy: <strong>{g.strategy}</strong>
            </p>

            {/* Row 1: Members + Assigned Numbers */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Users size={15} />Members ({g.members.length})
                    </div>
                    {g.members.map(m => {
                        const sc = STATUS_COLORS[m.status] || STATUS_COLORS.offline;
                        return (
                            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid #f3f4f6' }}>
                                <div style={{ width: 8, height: 8, borderRadius: '50%', background: sc.dot }} />
                                <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{m.name}</span>
                                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: sc.bg, color: sc.dot, fontWeight: 600 }}>{m.status}</span>
                            </div>
                        );
                    })}
                </div>

                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Phone size={15} style={{ color: '#10b981' }} />Assigned Numbers ({g.numbers.length})
                    </div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 10 }}>Inbound calls on these numbers route through this group's flow</div>
                    {g.numbers.map(n => (
                        <div key={n.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
                            <Phone size={13} style={{ color: '#6366f1' }} />
                            <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{n.number}</span>
                            <span style={{ fontSize: 11, color: '#6b7280' }}>{n.friendly_name}</span>
                        </div>
                    ))}
                </div>
            </div>

            {/* Row 2: Schedule + Call Flow */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                            <Calendar size={15} style={{ color: '#3b82f6' }} />Schedule
                        </div>
                        <span style={{ fontSize: 11, color: '#6b7280' }}>{g.schedule.timezone}</span>
                    </div>
                    {g.schedule.hours.map(h => (
                        <div key={h.day} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid #f3f4f6', fontSize: 12 }}>
                            <span style={{ fontWeight: 500, minWidth: 40 }}>{h.day}</span>
                            <span style={{ color: h.open === 'Closed' ? '#ef4444' : '#374151', display: 'flex', alignItems: 'center', gap: 4 }}>
                                {h.open === 'Closed' ? 'Closed' : <><Clock size={10} />{h.open} — {h.close}</>}
                            </span>
                        </div>
                    ))}
                </div>

                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                            <GitBranch size={15} style={{ color: '#6366f1' }} />Call Flow
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: g.flow.status === 'published' ? '#d1fae5' : '#fef3c7', color: g.flow.status === 'published' ? '#065f46' : '#92400e' }}>
                                {g.flow.status}
                            </span>
                            <button
                                onClick={() => navigate(`/settings/telephony/user-groups/${groupId}/flow`)}
                                style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px', fontSize: 12, fontWeight: 600, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}
                            >
                                <Play size={12} />Open Builder
                            </button>
                        </div>
                    </div>

                    <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
                        Updated {g.flow.updated_at} · {g.flow.graph.states.length} states · {g.flow.graph.transitions.length} transitions
                    </div>

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {g.flow.graph.states.map(s => {
                            const meta = NODE_KIND_META[s.kind as CallFlowNodeKind] || { icon: '?', label: s.kind, color: '#6b7280' };
                            return (
                                <div key={s.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', background: '#f9fafb', borderRadius: 6, fontSize: 12, border: '1px solid #e5e7eb' }}>
                                    <span>{meta.icon}</span>
                                    <span style={{ fontWeight: 500 }}>{s.name}</span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
}
