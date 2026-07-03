import { useLocation, useNavigate } from 'react-router-dom';
import {
    LayoutDashboard, Phone, PhoneIncoming, Users, Music,
    Shield, FileText,
} from 'lucide-react';
import { useIsMobile } from '../../hooks/useIsMobile';

const sections = [
    {
        title: 'Operations',
        items: [
            { label: 'Dashboard', path: '/settings/telephony/dashboard', icon: <LayoutDashboard size={15} /> },

        ],
    },
    {
        title: 'Configuration',
        items: [
            { label: 'Overview', path: '/settings/telephony', icon: <LayoutDashboard size={15} /> },
            { label: 'Phone Numbers', path: '/settings/telephony/phone-numbers', icon: <Phone size={15} /> },
            { label: 'User Groups', path: '/settings/telephony/user-groups', icon: <Users size={15} /> },
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
    const isMobile = useIsMobile();
    const isActive = (path: string) => path === '/settings/telephony' ? location.pathname === path : location.pathname.startsWith(path);

    if (isMobile) {
        // Mobile: flatten all groups into one horizontal, scrollable tab strip
        // at the top (group titles + "Telephony" heading dropped — the chips are
        // self-explanatory). Content renders full-width below (see TelephonyLayout).
        const items = sections.flatMap(s => s.items);
        return (
            <nav style={{
                display: 'flex', flexWrap: 'nowrap', gap: 8, alignItems: 'center',
                overflowX: 'auto', WebkitOverflowScrolling: 'touch',
                background: 'var(--blanc-bg)', borderBottom: '1px solid var(--blanc-line)',
                padding: '10px 12px', flexShrink: 0,
            }}>
                {items.map(item => {
                    const active = isActive(item.path);
                    return (
                        <button key={item.path} onClick={() => navigate(item.path)} style={{
                            display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0,
                            minHeight: 40, padding: '8px 14px', fontSize: 13, whiteSpace: 'nowrap',
                            fontWeight: active ? 600 : 400, color: active ? 'var(--blanc-accent)' : 'var(--blanc-ink-2)',
                            background: active ? 'var(--blanc-accent-soft)' : 'var(--blanc-panel-surface)',
                            border: `1px solid ${active ? 'transparent' : 'var(--blanc-line)'}`, borderRadius: 999,
                            cursor: 'pointer', transition: 'background 0.1s',
                        }}>
                            <span style={{ color: active ? 'var(--blanc-accent)' : 'var(--blanc-ink-3)', flexShrink: 0, display: 'inline-flex' }}>{item.icon}</span>
                            <span>{item.label}</span>
                        </button>
                    );
                })}
            </nav>
        );
    }

    return (
        <nav style={{ width: 220, borderRight: '1px solid var(--blanc-line)', padding: '16px 0', overflowY: 'auto', flexShrink: 0, height: '100%' }}>
            <div style={{ padding: '0 16px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <PhoneIncoming size={18} style={{ color: 'var(--blanc-accent)' }} />
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--blanc-ink-1)', fontFamily: 'var(--blanc-font-heading)' }}>Telephony</span>
            </div>
            {sections.map(s => (
                <div key={s.title} style={{ marginBottom: 4 }}>
                    <div style={{
                        fontSize: 11, fontWeight: 600, color: 'var(--blanc-ink-2)',
                        textTransform: 'uppercase', letterSpacing: '0.14em', padding: '10px 16px 4px',
                    }}>{s.title}</div>
                    {s.items.map(item => {
                        const active = isActive(item.path);
                        return (
                            <button key={item.path} onClick={() => navigate(item.path)} style={{
                                display: 'flex', alignItems: 'center', gap: 8, width: 'calc(100% - 16px)', margin: '0 8px',
                                padding: '7px 8px', fontSize: 13,
                                fontWeight: active ? 600 : 400, color: active ? 'var(--blanc-accent)' : 'var(--blanc-ink-2)',
                                background: active ? 'var(--blanc-accent-soft)' : 'transparent', border: 'none', borderRadius: 10,
                                cursor: 'pointer', textAlign: 'left', transition: 'background 0.1s',
                            }}
                                onMouseEnter={e => { if (!active) (e.currentTarget.style.background = 'var(--blanc-field)'); }}
                                onMouseLeave={e => { if (!active) (e.currentTarget.style.background = 'transparent'); }}
                            >
                                <span style={{ color: active ? 'var(--blanc-accent)' : 'var(--blanc-ink-3)', flexShrink: 0 }}>{item.icon}</span>
                                <span>{item.label}</span>
                            </button>
                        );
                    })}
                </div>
            ))}
        </nav>
    );
}
