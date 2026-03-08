import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Phone, Plus, Search, Globe, GitBranch, Calendar } from 'lucide-react';
import { telephonyApi } from '../../services/telephonyMockApi';
import type { PhoneNumberGroup } from '../../types/telephony';

export default function PhoneNumberGroupsPage() {
    const navigate = useNavigate();
    const [groups, setGroups] = useState<PhoneNumberGroup[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');

    useEffect(() => { telephonyApi.getPhoneNumberGroups().then(g => { setGroups(g); setLoading(false); }); }, []);

    const filtered = groups.filter(g => !search || g.name.toLowerCase().includes(search.toLowerCase()));

    if (loading) return <div style={{ padding: 32 }}><div style={{ width: 24, height: 24, border: '3px solid #e5e7eb', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 1s linear infinite' }} /></div>;

    return (
        <div style={{ padding: '24px 32px', maxWidth: 1200 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                <div>
                    <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111', margin: 0 }}>Phone Number Groups</h1>
                    <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>Organize phone numbers and assign routing flows</p>
                </div>
                <button onClick={() => { telephonyApi.createPhoneNumberGroup({ name: 'New Group', timezone: 'America/New_York' }).then(() => telephonyApi.getPhoneNumberGroups().then(setGroups)); }} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', fontSize: 13, fontWeight: 500, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}><Plus size={16} />Create Group</button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
                <div style={{ position: 'relative', flex: 1, maxWidth: 320 }}>
                    <Search size={16} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
                    <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search groups..." style={{ width: '100%', padding: '8px 12px 8px 32px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, outline: 'none' }} />
                </div>
            </div>

            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                        <tr style={{ background: '#f9fafb' }}>
                            <th style={{ textAlign: 'left', padding: '10px 16px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Name</th>
                            <th style={{ textAlign: 'left', padding: '10px 16px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Timezone</th>
                            <th style={{ textAlign: 'center', padding: '10px 16px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Numbers</th>
                            <th style={{ textAlign: 'left', padding: '10px 16px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Active Flow</th>
                            <th style={{ textAlign: 'left', padding: '10px 16px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Schedule</th>
                            <th style={{ textAlign: 'center', padding: '10px 16px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Queued</th>
                            <th style={{ textAlign: 'center', padding: '10px 16px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Missed</th>
                            <th style={{ textAlign: 'center', padding: '10px 16px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        {filtered.map((g, i) => (
                            <tr key={g.id} onClick={() => navigate(`/settings/telephony/groups/${g.id}`)} style={{ cursor: 'pointer', background: i % 2 === 0 ? '#fff' : '#fafbfc', transition: 'background 0.1s' }} onMouseEnter={e => { e.currentTarget.style.background = '#f0f0ff'; }} onMouseLeave={e => { e.currentTarget.style.background = i % 2 === 0 ? '#fff' : '#fafbfc'; }}>
                                <td style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <Phone size={14} style={{ color: '#6366f1' }} />
                                        <span style={{ fontWeight: 500 }}>{g.name}</span>
                                        {g.is_default && <span style={{ fontSize: 10, fontWeight: 600, background: '#dbeafe', color: '#1d4ed8', padding: '1px 5px', borderRadius: 4 }}>DEFAULT</span>}
                                    </div>
                                </td>
                                <td style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', color: '#6b7280' }}><div style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Globe size={12} />{g.timezone.replace('America/', '')}</div></td>
                                <td style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', textAlign: 'center' }}>{g.numbers_count}</td>
                                <td style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0' }}>{g.active_flow_name ? <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}><GitBranch size={12} style={{ color: '#8b5cf6' }} /><span>{g.active_flow_name}</span><span style={{ fontSize: 11, color: '#9ca3af' }}>v{g.active_flow_version}</span></div> : <span style={{ color: '#d1d5db' }}>—</span>}</td>
                                <td style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0' }}>{g.schedule_name ? <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Calendar size={12} style={{ color: '#10b981' }} /><span>{g.schedule_name}</span></div> : <span style={{ color: '#d1d5db' }}>—</span>}</td>
                                <td style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', textAlign: 'center' }}>{g.queued_calls_now > 0 ? <span style={{ fontWeight: 600, color: '#f59e0b' }}>{g.queued_calls_now}</span> : <span style={{ color: '#d1d5db' }}>0</span>}</td>
                                <td style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', textAlign: 'center' }}>{g.unanswered_today > 0 ? <span style={{ fontWeight: 600, color: '#ef4444' }}>{g.unanswered_today}</span> : <span style={{ color: '#d1d5db' }}>0</span>}</td>
                                <td style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', textAlign: 'center' }}><span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: g.status === 'active' ? '#d1fae5' : '#f3f4f6', color: g.status === 'active' ? '#065f46' : '#6b7280' }}>{g.status}</span></td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {filtered.length === 0 && <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No groups found</div>}
            </div>
        </div>
    );
}
