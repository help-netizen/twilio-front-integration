import { Plus, Users, Phone, Calendar, Clock, Settings, Play } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { USER_GROUPS, STATUS_COLORS } from '../../data/userGroupsMock';

export default function UserGroupsPage() {
    const navigate = useNavigate();

    return (
        <div style={{ padding: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <div>
                    <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>User Groups</h1>
                    <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>Agent groups with numbers, schedules & call flows</p>
                </div>
                <button style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', fontSize: 13, fontWeight: 600, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>
                    <Plus size={15} />New Group
                </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {USER_GROUPS.map(g => {
                    const openDays = g.schedule.hours.filter(h => h.open !== 'Closed');
                    const closedDays = g.schedule.hours.length - openDays.length;
                    return (
                        <div key={g.id} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, overflow: 'hidden', transition: 'box-shadow 0.15s' }}
                            onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.07)')}
                            onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}>
                            {/* Header */}
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid #f3f4f6' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                    <div style={{ width: 36, height: 36, borderRadius: 8, background: '#fef3c7', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                        <Users size={16} style={{ color: '#f59e0b' }} />
                                    </div>
                                    <div>
                                        <div style={{ fontSize: 15, fontWeight: 700, color: '#111' }}>{g.name}</div>
                                        <div style={{ fontSize: 12, color: '#6b7280' }}>{g.desc} · <strong>{g.strategy}</strong></div>
                                    </div>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: g.flow.status === 'published' ? '#d1fae5' : '#fef3c7', color: g.flow.status === 'published' ? '#065f46' : '#92400e' }}>
                                        {g.flow.status}
                                    </span>
                                    <button onClick={(e) => { e.stopPropagation(); navigate(`/settings/telephony/user-groups/${g.id}`); }}
                                        style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px', fontSize: 12, fontWeight: 500, background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer' }}>
                                        <Settings size={12} />Edit
                                    </button>
                                    <button onClick={(e) => { e.stopPropagation(); navigate(`/settings/telephony/user-groups/${g.id}/flow`); }}
                                        style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px', fontSize: 12, fontWeight: 600, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
                                        <Play size={12} />Flow Builder
                                    </button>
                                </div>
                            </div>

                            {/* Body — 3 columns: Members | Numbers | Schedule */}
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 0 }}>
                                {/* Members */}
                                <div style={{ padding: '14px 18px', borderRight: '1px solid #f3f4f6' }}>
                                    <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 5 }}>
                                        <Users size={12} />Members ({g.members.length})
                                    </div>
                                    {g.members.map(m => {
                                        const sc = STATUS_COLORS[m.status] || STATUS_COLORS.offline;
                                        return (
                                            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                                                <div style={{ width: 7, height: 7, borderRadius: '50%', background: sc.dot, flexShrink: 0 }} />
                                                <span style={{ fontSize: 12, fontWeight: 500, color: '#374151', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</span>
                                                <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, background: sc.bg, color: sc.dot, fontWeight: 600 }}>{m.status.replace('_', ' ')}</span>
                                            </div>
                                        );
                                    })}
                                </div>

                                {/* Assigned Numbers */}
                                <div style={{ padding: '14px 18px', borderRight: '1px solid #f3f4f6' }}>
                                    <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 5 }}>
                                        <Phone size={12} />Numbers ({g.numbers.length})
                                    </div>
                                    {g.numbers.map(n => (
                                        <div key={n.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0' }}>
                                            <Phone size={11} style={{ color: '#6366f1', flexShrink: 0 }} />
                                            <span style={{ fontSize: 12, fontWeight: 500, color: '#374151', flex: 1 }}>{n.number}</span>
                                            <span style={{ fontSize: 10, color: '#9ca3af' }}>{n.friendly_name}</span>
                                        </div>
                                    ))}
                                </div>

                                {/* Schedule */}
                                <div style={{ padding: '14px 18px' }}>
                                    <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 5 }}>
                                        <Calendar size={12} />Schedule · {g.schedule.timezone.split('/')[1]}
                                    </div>
                                    {g.schedule.hours.map(h => (
                                        <div key={h.day} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 11 }}>
                                            <span style={{ fontWeight: 500, color: '#374151', minWidth: 30 }}>{h.day}</span>
                                            {h.open === 'Closed'
                                                ? <span style={{ color: '#ef4444', fontWeight: 500 }}>Closed</span>
                                                : <span style={{ color: '#374151', display: 'flex', alignItems: 'center', gap: 3 }}><Clock size={9} />{h.open}–{h.close}</span>
                                            }
                                        </div>
                                    ))}
                                    {closedDays > 0 && (
                                        <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4 }}>{closedDays} day{closedDays > 1 ? 's' : ''} closed</div>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
