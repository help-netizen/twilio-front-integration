import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Calendar, Settings } from 'lucide-react';

const MOCK: Record<string, { name: string; tz: string; hours: { day: string; open: string; close: string }[] }> = {
    'sched-1': {
        name: 'Business Hours', tz: 'America/New_York', hours: [
            { day: 'Monday', open: '09:00', close: '18:00' }, { day: 'Tuesday', open: '09:00', close: '18:00' },
            { day: 'Wednesday', open: '09:00', close: '18:00' }, { day: 'Thursday', open: '09:00', close: '18:00' },
            { day: 'Friday', open: '09:00', close: '17:00' }, { day: 'Saturday', open: 'Closed', close: '' },
            { day: 'Sunday', open: 'Closed', close: '' },
        ]
    },
};

export default function ScheduleDetailPage() {
    const { scheduleId } = useParams<{ scheduleId: string }>();
    const navigate = useNavigate();
    const s = MOCK[scheduleId || ''] || { name: 'Unknown', tz: '', hours: [] };
    return (
        <div style={{ padding: 24 }}>
            <button onClick={() => navigate('/settings/telephony/schedules')} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#6366f1', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginBottom: 16 }}><ArrowLeft size={14} />Back to Schedules</button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <Calendar size={20} style={{ color: '#3b82f6' }} />
                <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>{s.name}</h1>
                <button style={{ padding: '4px 10px', fontSize: 11, background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}><Settings size={12} />Edit</button>
            </div>
            <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 20px' }}>Timezone: <strong>{s.tz}</strong></p>
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, maxWidth: 480 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Weekly Hours</div>
                {s.hours.map(h => (
                    <div key={h.day} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f3f4f6', fontSize: 13 }}>
                        <span style={{ fontWeight: 500, minWidth: 100 }}>{h.day}</span>
                        <span style={{ color: h.open === 'Closed' ? '#ef4444' : '#374151' }}>{h.open === 'Closed' ? 'Closed' : `${h.open} — ${h.close}`}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
