import { Phone, Users, LayoutDashboard, Music } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export default function RouteManagerOverviewPage() {
    const navigate = useNavigate();
    const cards = [
        { title: 'User Groups', desc: 'Agent groups with numbers, schedules & call flows', icon: <Users size={24} style={{ color: '#f59e0b' }} />, path: '/settings/telephony/user-groups', count: '2 groups' },
        { title: 'Phone Numbers', desc: 'Manage Twilio numbers', icon: <Phone size={24} style={{ color: '#10b981' }} />, path: '/settings/telephony/phone-numbers', count: '4 numbers' },
        { title: 'Audio Library', desc: 'Greetings, prompts, hold music', icon: <Music size={24} style={{ color: '#8b5cf6' }} />, path: '/settings/telephony/audio-library', count: '3 assets' },
        { title: 'Dashboard', desc: 'Live operations', icon: <LayoutDashboard size={24} style={{ color: '#ef4444' }} />, path: '/calls/dashboard', count: 'Live' },
    ];
    return (
        <div style={{ padding: 24 }}>
            <h1 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 4px' }}>Telephony Route Manager</h1>
            <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 24px' }}>Configure call routing, numbers, and flows</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
                {cards.map(c => (
                    <div key={c.title} onClick={() => navigate(c.path)} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, cursor: 'pointer', transition: 'box-shadow 0.15s' }}
                        onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.08)')}
                        onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}>
                        <div style={{ marginBottom: 12 }}>{c.icon}</div>
                        <div style={{ fontSize: 15, fontWeight: 600, color: '#111' }}>{c.title}</div>
                        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>{c.desc}</div>
                        <div style={{ fontSize: 11, color: '#6366f1', fontWeight: 600 }}>{c.count}</div>
                    </div>
                ))}
            </div>
        </div>
    );
}
