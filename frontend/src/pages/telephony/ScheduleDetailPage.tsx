import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Calendar, Globe, Clock, CheckCircle, XCircle, AlertCircle } from 'lucide-react';
import { telephonyApi } from '../../services/telephonyMockApi';
import type { ScheduleDetail } from '../../types/telephony';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function ScheduleDetailPage() {
    const { scheduleId } = useParams<{ scheduleId: string }>();
    const navigate = useNavigate();
    const [schedule, setSchedule] = useState<ScheduleDetail | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (scheduleId) telephonyApi.getSchedule(scheduleId).then(s => { setSchedule(s); setLoading(false); });
    }, [scheduleId]);

    if (loading) return <div style={{ padding: 32 }}><div style={{ width: 24, height: 24, border: '3px solid #e5e7eb', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 1s linear infinite' }} /></div>;
    if (!schedule) return <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>Schedule not found</div>;

    const intervalsByDay = DAY_NAMES.map((_, i) => schedule.intervals.filter(iv => iv.day_of_week === i));

    return (
        <div style={{ padding: '24px 32px', maxWidth: 900 }}>
            <button onClick={() => navigate('/settings/telephony/schedules')} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#6366f1', background: 'none', border: 'none', cursor: 'pointer', marginBottom: 16, padding: 0 }}><ArrowLeft size={16} />Back to Schedules</button>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
                <div style={{ width: 44, height: 44, borderRadius: 10, background: '#f0fdf4', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Calendar size={22} style={{ color: '#10b981' }} /></div>
                <div>
                    <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111', margin: 0 }}>{schedule.name}</h1>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
                        <span style={{ fontSize: 13, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 4 }}><Globe size={12} />{schedule.timezone}</span>
                        {schedule.is_open_now ? <span style={{ fontSize: 12, fontWeight: 600, color: '#10b981', display: 'flex', alignItems: 'center', gap: 4 }}><CheckCircle size={14} />Currently Open</span> : <span style={{ fontSize: 12, fontWeight: 600, color: '#ef4444', display: 'flex', alignItems: 'center', gap: 4 }}><XCircle size={14} />Currently Closed</span>}
                    </div>
                </div>
            </div>

            {/* Weekly Grid */}
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, marginBottom: 16 }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, color: '#374151', margin: '0 0 16px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Weekly Hours</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {DAY_NAMES.map((day, i) => (
                        <div key={day} style={{ display: 'flex', alignItems: 'center', padding: '10px 14px', background: intervalsByDay[i].length > 0 ? '#f0fdf4' : '#fafafa', borderRadius: 8, minHeight: 44 }}>
                            <span style={{ width: 100, fontSize: 13, fontWeight: 600, color: '#374151' }}>{DAY_SHORT[i]}</span>
                            {intervalsByDay[i].length > 0 ? (
                                <div style={{ display: 'flex', gap: 10, flex: 1 }}>
                                    {intervalsByDay[i].map(iv => (
                                        <div key={iv.id} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
                                            <Clock size={12} style={{ color: '#10b981' }} />
                                            <span style={{ fontFamily: 'monospace', fontWeight: 500 }}>{iv.start_time}</span>
                                            <span style={{ color: '#9ca3af' }}>–</span>
                                            <span style={{ fontFamily: 'monospace', fontWeight: 500 }}>{iv.end_time}</span>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <span style={{ fontSize: 13, color: '#d1d5db', fontStyle: 'italic' }}>Closed</span>
                            )}
                        </div>
                    ))}
                </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                {/* Exceptions */}
                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                    <h3 style={{ fontSize: 14, fontWeight: 600, color: '#374151', margin: '0 0 14px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Exceptions & Holidays</h3>
                    {schedule.exceptions.length === 0 ? (
                        <p style={{ fontSize: 13, color: '#9ca3af', textAlign: 'center', padding: 16 }}>No exceptions defined</p>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {schedule.exceptions.map(ex => (
                                <div key={ex.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: ex.is_closed ? '#fef2f2' : '#f0fdf4', borderRadius: 8 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <AlertCircle size={14} style={{ color: ex.is_closed ? '#ef4444' : '#10b981' }} />
                                        <span style={{ fontSize: 13, fontWeight: 500 }}>{ex.label}</span>
                                    </div>
                                    <div style={{ fontSize: 12, color: '#6b7280' }}>
                                        <span>{ex.date}</span>
                                        {ex.is_closed ? <span style={{ marginLeft: 8, color: '#ef4444', fontWeight: 600 }}>Closed</span> : <span style={{ marginLeft: 8 }}>{ex.start_time}–{ex.end_time}</span>}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Linked Groups */}
                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                    <h3 style={{ fontSize: 14, fontWeight: 600, color: '#374151', margin: '0 0 14px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Linked Groups</h3>
                    {schedule.linked_groups.length === 0 ? (
                        <p style={{ fontSize: 13, color: '#9ca3af', textAlign: 'center', padding: 16 }}>Not used by any group</p>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {schedule.linked_groups.map(g => (
                                <div key={g.id} onClick={() => navigate(`/settings/telephony/groups/${g.id}`)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: '#f9fafb', borderRadius: 8, cursor: 'pointer' }}>
                                    <Calendar size={14} style={{ color: '#6366f1' }} />
                                    <span style={{ fontSize: 13, fontWeight: 500 }}>{g.name}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
