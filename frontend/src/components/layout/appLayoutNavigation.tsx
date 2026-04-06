import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '../ui/dropdown-menu';
import { Phone, PhoneIncoming, Users, Settings, Key, BookOpen, FileText, LogOut, Shield, Activity, MessageSquareText, DollarSign, Contact2, Wrench, Briefcase, Bell, CalendarDays } from 'lucide-react';

interface AppNavProps { activeTab: string; pulseUnreadCount: number; hasRole: (r: string) => boolean; logout: () => void; }

export const AppNavTabs: React.FC<AppNavProps> = ({ activeTab, pulseUnreadCount }) => {
    const navigate = useNavigate();
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
            <h1 className="text-2xl font-semibold" style={{ margin: 0, color: '#202223' }}>Blanc</h1>
            <Tabs value={activeTab} className="w-auto hidden md:block">
                <TabsList>
                    <TabsTrigger value="pulse" className="flex items-center gap-2" onClick={() => navigate('/pulse')} style={{ position: 'relative' }}><Activity className="size-4" />Pulse{pulseUnreadCount > 0 && <span className="pulse-unread-badge" title={`${pulseUnreadCount} unread`}>{pulseUnreadCount > 9 ? '9+' : pulseUnreadCount}</span>}</TabsTrigger>
                    <TabsTrigger value="leads" className="flex items-center gap-2" onClick={() => navigate('/leads')}><Users className="size-4" />Leads</TabsTrigger>
                    <TabsTrigger value="jobs" className="flex items-center gap-2" onClick={() => navigate('/jobs')}><Briefcase className="size-4" />Jobs</TabsTrigger>
                    <TabsTrigger value="schedule" className="flex items-center gap-2" onClick={() => navigate('/schedule')}><CalendarDays className="size-4" />Schedule</TabsTrigger>
                    <TabsTrigger value="contacts" className="flex items-center gap-2" onClick={() => navigate('/contacts')}><Contact2 className="size-4" />Contacts</TabsTrigger>
                    <TabsTrigger value="payments" className="flex items-center gap-2" onClick={() => navigate('/payments')}><DollarSign className="size-4" />Payments</TabsTrigger>
                </TabsList>
            </Tabs>
        </div>
    );
};

// ─── Bottom Navigation Bar (mobile) ─────────────────────────────────────────

const NAV_TABS = [
    { key: 'pulse', label: 'Pulse', icon: Activity, path: '/pulse' },
    { key: 'leads', label: 'Leads', icon: Users, path: '/leads' },
    { key: 'jobs', label: 'Jobs', icon: Briefcase, path: '/jobs' },
    { key: 'schedule', label: 'Schedule', icon: CalendarDays, path: '/schedule' },
    { key: 'contacts', label: 'Contacts', icon: Contact2, path: '/contacts' },
    { key: 'payments', label: 'Payments', icon: DollarSign, path: '/payments' },
] as const;

export const BottomNavBar: React.FC<{ activeTab: string; pulseUnreadCount: number }> = ({ activeTab, pulseUnreadCount }) => {
    const navigate = useNavigate();
    return (
        <nav className="app-bottom-nav">
            {NAV_TABS.map(t => {
                const Icon = t.icon;
                return (
                    <button
                        key={t.key}
                        className={`app-bottom-nav-item ${activeTab === t.key ? 'active' : ''}`}
                        onClick={() => navigate(t.path)}
                    >
                        <Icon className="size-5" />
                        <span>{t.label}</span>
                        {t.key === 'pulse' && pulseUnreadCount > 0 && (
                            <span
                                className="pulse-unread-badge"
                                style={{ position: 'absolute', top: 4, right: '50%', marginRight: -16, transform: 'scale(0.85)' }}
                            >
                                {pulseUnreadCount > 9 ? '9+' : pulseUnreadCount}
                            </span>
                        )}
                    </button>
                );
            })}
        </nav>
    );
};

export const SettingsMenu: React.FC<{ activeTab: string; hasRole: (r: string) => boolean; logout: () => void }> = ({ activeTab, hasRole, logout }) => {
    const navigate = useNavigate();
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild><button className="user-menu" style={{ cursor: 'pointer', fontWeight: activeTab === 'settings' ? 600 : 400 }}><Settings className="size-4" style={{ display: 'inline', verticalAlign: 'middle', marginRight: '4px' }} /><span className="hidden md:inline">Settings</span></button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem className="flex items-center gap-2 cursor-pointer" onClick={() => navigate('/settings/integrations')}><Key className="size-4" />Integrations</DropdownMenuItem>
                <DropdownMenuItem className="flex items-center gap-2 cursor-pointer" onClick={() => navigate('/settings/lead-form')}><FileText className="size-4" />Lead & Job</DropdownMenuItem>
                <DropdownMenuItem className="flex items-center gap-2 cursor-pointer" onClick={() => navigate('/settings/quick-messages')}><MessageSquareText className="size-4" />Quick Messages</DropdownMenuItem>
                <DropdownMenuItem className="flex items-center gap-2 cursor-pointer" onClick={() => navigate('/settings/api-docs')}><BookOpen className="size-4" />API Docs</DropdownMenuItem>
                <DropdownMenuItem className="flex items-center gap-2 cursor-pointer" onClick={() => navigate('/settings/users')}><Users className="size-4" />Users</DropdownMenuItem>
                <DropdownMenuItem className="flex items-center gap-2 cursor-pointer" onClick={() => navigate('/settings/providers')}><Wrench className="size-4" />Providers</DropdownMenuItem>
                <DropdownMenuItem className="flex items-center gap-2 cursor-pointer" onClick={() => navigate('/settings/telephony')}><PhoneIncoming className="size-4" />Telephony</DropdownMenuItem>
                <DropdownMenuItem className="flex items-center gap-2 cursor-pointer" onClick={() => navigate('/settings/phone-calls')}><Phone className="size-4" />Phone Calls</DropdownMenuItem>
                <DropdownMenuItem className="flex items-center gap-2 cursor-pointer" onClick={() => navigate('/settings/actions-notifications')}><Bell className="size-4" />Actions &amp; Notifications</DropdownMenuItem>
                {hasRole('super_admin') && <><DropdownMenuSeparator /><DropdownMenuItem className="flex items-center gap-2 cursor-pointer" onClick={() => navigate('/settings/admin')}><Shield className="size-4" />Super Admin</DropdownMenuItem></>}
                <DropdownMenuSeparator />
                <DropdownMenuItem className="flex items-center gap-2 cursor-pointer text-red-600" onClick={logout}><LogOut className="size-4" />Log Out</DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

export function getActiveTab(pathname: string): string {
    if (pathname.startsWith('/pulse')) return 'pulse';
    if (pathname.startsWith('/messages')) return 'messages';
    if (pathname.startsWith('/leads')) return 'leads';
    if (pathname.startsWith('/jobs')) return 'jobs';
    if (pathname.startsWith('/schedule')) return 'schedule';
    if (pathname.startsWith('/contacts')) return 'contacts';
    if (pathname.startsWith('/payments')) return 'payments';
    if (pathname.startsWith('/settings')) return 'settings';
    if (pathname.startsWith('/calls') || pathname.startsWith('/contact/')) return 'calls';
    return 'pulse';
}
