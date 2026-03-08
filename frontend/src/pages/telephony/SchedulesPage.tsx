import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Calendar, Plus, Search, Globe, Clock, CheckCircle, XCircle } from 'lucide-react';
import { telephonyApi } from '../../services/telephonyMockApi';
import type { Schedule } from '../../types/telephony';

export default function SchedulesPage() {
    const navigate = useNavigate();
    const [schedules, setSchedules] = useState<Schedule[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');

    useEffect(() => { telephonyApi.getSchedules().then(s => { setSchedules(s); setLoading(false); }); }, []);
    const filtered = schedules.filter(s => !search || s.name.toLowerCase().includes(search.toLowerCase()));

    if (loading) return <div style={{ padding: 32 }}><div style={{ width: 24, height: 24, border: '3px solid #e5e7eb', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 1s linear infinite' }} /></div>;

    return (
        <div style={{ padding: '24px 32px', maxWidth: 1200 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                <div>
                    <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111', margin: 0 }}>Schedules</h1>
                    <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>Define business hours and holiday exceptions</p>
                </div>
                <button onClick={() => { telephonyApi.createSchedule({ name: 'New Schedule', timezone: 'America/New_York' }).then(() => telephonyApi.getSchedules().then(setSchedules)); }} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', fontSize: 13, fontWeight: 500, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}><Plus size={16} />Create Schedule</button>
            </div>

            <div style={{ position: 'relative', maxWidth: 320, marginBottom: 20 }}>
                <Search size={16} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search schedules..." style={{ width: '100%', padding: '8px 12px 8px 32px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, outline: 'none' }} />
            </div>

            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                        <tr style={{ background: '#f9fafb' }}>
                            <th style={{ textAlign: 'left', padding: '10px 16px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Name</th>
                            <th style={{ textAlign: 'left', padding: '10px 16px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Timezone</th>
                            <th style={{ textAlign: 'center', padding: '10px 16px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Intervals</th>
                            <th style={{ textAlign: 'center', padding: '10px 16px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Exceptions</th>
                            <th style={{ textAlign: 'center', padding: '10px 16px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Used By</th>
                            <th style={{ textAlign: 'center', padding: '10px 16px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Now</th>
                            <th style={{ textAlign: 'left', padding: '10px 16px', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Updated</th>
                        </tr>
                    </thead>
                    <tbody>
                        {filtered.map((s, i) => (
                            <tr key={s.id} onClick={() => navigate(`/settings/telephony/schedules/${s.id}`)} style={{ cursor: 'pointer', background: i % 2 === 0 ? '#fff' : '#fafbfc' }} onMouseEnter={e => { e.currentTarget.style.background = '#f0f0ff'; }} onMouseLeave={e => { e.currentTarget.style.background = i % 2 === 0 ? '#fff' : '#fafbfc'; }}>
                                <td style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0' }}><div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Calendar size={14} style={{ color: '#10b981' }} /><span style={{ fontWeight: 500 }}>{s.name}</span></div></td>
                                <td style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', color: '#6b7280' }}><div style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Globe size={12} />{s.timezone.replace('America/', '')}</div></td>
                                <td style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', textAlign: 'center' }}>{s.intervals_count}</td>
                                <td style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', textAlign: 'center' }}>{s.exceptions_count}</td>
                                <td style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', textAlign: 'center' }}>{s.used_by_groups_count} groups</td>
                                <td style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', textAlign: 'center' }}>{s.is_open_now ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#10b981', fontWeight: 600 }}><CheckCircle size={14} />Open</span> : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#ef4444', fontWeight: 600 }}><XCircle size={14} />Closed</span>}</td>
                                <td style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', color: '#6b7280' }}><div style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Clock size={12} />{new Date(s.updated_at).toLocaleDateString()}</div></td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {filtered.length === 0 && <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No schedules found</div>}
            </div>
        </div>
    );
}
