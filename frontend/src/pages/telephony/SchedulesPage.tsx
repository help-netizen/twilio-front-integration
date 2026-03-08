import { useState } from 'react';
import { Calendar, Plus, ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface Schedule { id: string; name: string; timezone: string; is_active: boolean; hours: { day: string; open: string; close: string }[]; }
const MOCK: Schedule[] = [
    {
        id: 'sched-1', name: 'Business Hours', timezone: 'America/New_York', is_active: true, hours: [
            { day: 'Mon', open: '09:00', close: '18:00' }, { day: 'Tue', open: '09:00', close: '18:00' },
            { day: 'Wed', open: '09:00', close: '18:00' }, { day: 'Thu', open: '09:00', close: '18:00' },
            { day: 'Fri', open: '09:00', close: '17:00' },
        ]
    },
];

export default function SchedulesPage() {
    const navigate = useNavigate();
    const [schedules] = useState(MOCK);
    return (
        <div style={{ padding: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <div><h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Schedules</h1><p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>Business hours and holiday schedules</p></div>
                <button style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', fontSize: 13, fontWeight: 600, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}><Plus size={15} />New Schedule</button>
            </div>
            {schedules.map(s => (
                <div key={s.id} onClick={() => navigate(`/settings/telephony/schedules/${s.id}`)} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 20px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, cursor: 'pointer', marginBottom: 10, transition: 'box-shadow 0.15s' }}
                    onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.06)')} onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}>
                    <div style={{ width: 36, height: 36, borderRadius: 8, background: '#dbeafe', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Calendar size={16} style={{ color: '#3b82f6' }} /></div>
                    <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>{s.name}</div>
                        <div style={{ fontSize: 12, color: '#6b7280' }}>{s.timezone} · {s.hours.length} days</div>
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: s.is_active ? '#d1fae5' : '#fef3c7', color: s.is_active ? '#065f46' : '#92400e' }}>{s.is_active ? 'Active' : 'Inactive'}</span>
                    <ChevronRight size={16} style={{ color: '#9ca3af' }} />
                </div>
            ))}
        </div>
    );
}
