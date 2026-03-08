import { useLocation, useNavigate } from 'react-router-dom';
import {
    LayoutDashboard, Phone, PhoneIncoming, Users, Calendar, GitBranch, Music,
    Shield, FileText, Hash, ListOrdered,
} from 'lucide-react';

interface NavItem {
    label: string;
    path: string;
    icon: React.ReactNode;
}

interface NavSection {
    title: string;
    items: NavItem[];
}

const sections: NavSection[] = [
    {
        title: 'Operations',
        items: [
            { label: 'Dashboard', path: '/calls/dashboard', icon: <LayoutDashboard size={15} /> },
            { label: 'Queue', path: '/calls/queue', icon: <ListOrdered size={15} /> },
        ],
    },
    {
        title: 'Configuration',
        items: [
            { label: 'Overview', path: '/settings/telephony', icon: <LayoutDashboard size={15} /> },
            { label: 'Number Groups', path: '/settings/telephony/groups', icon: <Hash size={15} /> },
            { label: 'Phone Numbers', path: '/settings/telephony/phone-numbers', icon: <Phone size={15} /> },
            { label: 'User Groups', path: '/settings/telephony/user-groups', icon: <Users size={15} /> },
            { label: 'Schedules', path: '/settings/telephony/schedules', icon: <Calendar size={15} /> },
            { label: 'Call Flows', path: '/settings/telephony/call-flows', icon: <GitBranch size={15} /> },
            { label: 'Audio Library', path: '/settings/telephony/audio-library', icon: <Music size={15} /> },
        ],
    },
    {
        title: 'Advanced',
        items: [
            { label: 'Provider Settings', path: '/settings/telephony/provider-settings', icon: <Shield size={15} /> },
            { label: 'Routing Logs', path: '/settings/telephony/routing-logs', icon: <FileText size={15} /> },
        ],
    },
];

export default function TelephonyNav() {
    const location = useLocation();
    const navigate = useNavigate();

    const isActive = (path: string) => {
        if (path === '/settings/telephony') return location.pathname === path;
        return location.pathname.startsWith(path);
    };

    return (
        <nav style={{
            width: 220, background: '#f9fafb', borderRight: '1px solid #e5e7eb',
            padding: '16px 0', overflowY: 'auto', flexShrink: 0, height: '100%',
        }}>
            <div style={{ padding: '0 12px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <PhoneIncoming size={18} style={{ color: '#6366f1' }} />
                <span style={{ fontSize: 14, fontWeight: 700, color: '#111' }}>Telephony</span>
            </div>

            {sections.map(section => (
                <div key={section.title} style={{ marginBottom: 4 }}>
                    <div style={{
                        fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase',
                        letterSpacing: '0.08em', padding: '10px 16px 4px',
                    }}>
                        {section.title}
                    </div>
                    {section.items.map(item => {
                        const active = isActive(item.path);
                        return (
                            <button
                                key={item.path}
                                onClick={() => navigate(item.path)}
                                style={{
                                    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                                    padding: '8px 16px', fontSize: 13, fontWeight: active ? 600 : 400,
                                    color: active ? '#6366f1' : '#374151',
                                    background: active ? '#ede9fe' : 'transparent',
                                    border: 'none', borderRadius: 0, cursor: 'pointer',
                                    textAlign: 'left', transition: 'background 0.1s',
                                }}
                                onMouseEnter={e => { if (!active) (e.currentTarget.style.background = '#f3f4f6'); }}
                                onMouseLeave={e => { if (!active) (e.currentTarget.style.background = 'transparent'); }}
                            >
                                <span style={{ color: active ? '#6366f1' : '#6b7280', flexShrink: 0 }}>{item.icon}</span>
                                <span>{item.label}</span>
                            </button>
                        );
                    })}
                </div>
            ))}
        </nav>
    );
}
