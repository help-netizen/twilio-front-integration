import { useState, useEffect } from 'react';
import { Phone, Users, LayoutDashboard, Music } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { telephonyApi } from '../../services/telephonyApi';

const INK1 = 'var(--blanc-ink-1, #202734)';
const INK2 = 'var(--blanc-ink-2, #536070)';
const INK3 = 'var(--blanc-ink-3, #7d8796)';
const JOB = 'var(--blanc-job, #2f63d8)';
const LINE = 'var(--blanc-line, rgba(117,106,89,0.18))';

export default function RouteManagerOverviewPage() {
    const navigate = useNavigate();
    const [counts, setCounts] = useState({ user_groups_count: 0, phone_numbers_count: 0, call_flows_count: 0 });

    useEffect(() => { telephonyApi.getOverview().then(setCounts); }, []);

    const cards = [
        { title: 'User Groups', desc: 'Agent groups with numbers, schedules & call flows', icon: Users, path: '/settings/telephony/user-groups', count: `${counts.user_groups_count} groups` },
        { title: 'Phone Numbers', desc: 'Buy, route, and assign numbers; SMS compliance', icon: Phone, path: '/settings/telephony/phone-numbers', count: `${counts.phone_numbers_count} numbers` },
        { title: 'Audio Library', desc: 'Greetings, prompts, hold music', icon: Music, path: '/settings/telephony/audio-library', count: null },
        { title: 'Live Operations', desc: 'Active calls, queues, and agent presence', icon: LayoutDashboard, path: '/settings/telephony/dashboard', count: 'Live' },
    ];

    return (
        <div style={{ padding: '28px 24px' }}>
            <div className="blanc-eyebrow">Telephony</div>
            <h1 style={{ fontSize: 24, fontWeight: 600, margin: '4px 0 4px', fontFamily: 'var(--blanc-font-heading, Manrope), sans-serif', color: INK1 }}>Telephony</h1>
            <p style={{ fontSize: 13, color: INK3, margin: '0 0 24px' }}>Numbers, agent groups, call flows, and live operations.</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
                {cards.map(c => {
                    const Icon = c.icon;
                    return (
                        <div key={c.title} onClick={() => navigate(c.path)} style={{ background: 'var(--blanc-surface-strong, #fffdf9)', border: `1px solid ${LINE}`, borderRadius: 16, padding: 20, cursor: 'pointer', transition: 'border-color 0.15s' }}
                            onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(117,106,89,0.34)')}
                            onMouseLeave={e => (e.currentTarget.style.borderColor = 'rgba(117,106,89,0.18)')}>
                            <Icon size={20} style={{ color: INK3, marginBottom: 12 }} />
                            <div style={{ fontSize: 15, fontWeight: 600, color: INK1 }}>{c.title}</div>
                            <div style={{ fontSize: 12, color: INK2, marginBottom: 8 }}>{c.desc}</div>
                            {c.count && <div style={{ fontSize: 11, color: JOB, fontWeight: 600 }}>{c.count}</div>}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
