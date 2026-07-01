import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '../ui/dropdown-menu';
import { PhoneIncoming, Users, Settings, Key, BookOpen, FileText, LogOut, Shield, Activity, MessageSquareText, DollarSign, Contact2, Wrench, Briefcase, Bell, CalendarDays, MapPin, FileCog, Zap, CreditCard, Building2, ListChecks } from 'lucide-react';
import { useAuthz } from '../../hooks/useAuthz';

interface AppNavProps { activeTab: string; pulseUnreadCount: number; leadsNewCount: number; hasRole: (r: string) => boolean; logout: () => void; }

// Top-level workspaces, each backed by a canonical permission key (PF007).
// Navigation is built from effective permissions — hidden UI is convenience,
// the backend stays authoritative.
const WORKSPACE_TABS = [
    { key: 'pulse', label: 'Pulse', icon: Activity, path: '/pulse', permission: 'pulse.view' },
    { key: 'leads', label: 'Leads', icon: Users, path: '/leads', permission: 'leads.view' },
    { key: 'jobs', label: 'Jobs', icon: Briefcase, path: '/jobs', permission: 'jobs.view' },
    { key: 'schedule', label: 'Schedule', icon: CalendarDays, path: '/schedule', permission: 'schedule.view' },
    { key: 'tasks', label: 'Tasks', icon: ListChecks, path: '/tasks', permission: 'tasks.view' },
    { key: 'contacts', label: 'Contacts', icon: Contact2, path: '/contacts', permission: 'contacts.view' },
    { key: 'payments', label: 'Payments', icon: DollarSign, path: '/payments', permission: 'payments.view' },
] as const;

function useVisibleTabs() {
    const { hasPermission } = useAuthz();
    return WORKSPACE_TABS.filter(t => hasPermission(t.permission));
}

export const AppNavTabs: React.FC<AppNavProps> = ({ activeTab, pulseUnreadCount, leadsNewCount }) => {
    const navigate = useNavigate();
    const tabs = useVisibleTabs();
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
            <h1 className="text-2xl font-semibold" style={{ margin: 0, color: '#202223' }}>Albusto</h1>
            <Tabs value={activeTab} className="w-auto hidden md:block">
                <TabsList>
                    {tabs.map(t => {
                        const Icon = t.icon;
                        return (
                            <TabsTrigger key={t.key} value={t.key} className="flex items-center gap-2" onClick={() => navigate(t.path)} style={(t.key === 'pulse' || t.key === 'leads') ? { position: 'relative' } : undefined}>
                                <Icon className="size-4" />{t.label}
                                {t.key === 'pulse' && pulseUnreadCount > 0 && <span className="pulse-unread-badge" title={`${pulseUnreadCount} unread`}>{pulseUnreadCount > 9 ? '9+' : pulseUnreadCount}</span>}
                                {t.key === 'leads' && leadsNewCount > 0 && <span className="pulse-unread-badge" title={`${leadsNewCount} new leads`}>{leadsNewCount > 9 ? '9+' : leadsNewCount}</span>}
                            </TabsTrigger>
                        );
                    })}
                </TabsList>
            </Tabs>
        </div>
    );
};

// ─── Bottom Navigation Bar (mobile) ─────────────────────────────────────────

export const BottomNavBar: React.FC<{ activeTab: string; pulseUnreadCount: number; leadsNewCount: number }> = ({ activeTab, pulseUnreadCount, leadsNewCount }) => {
    const navigate = useNavigate();
    const tabs = useVisibleTabs();
    return (
        <nav className="app-bottom-nav">
            {tabs.map(t => {
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
                        {t.key === 'leads' && leadsNewCount > 0 && (
                            <span
                                className="pulse-unread-badge"
                                style={{ position: 'absolute', top: 4, right: '50%', marginRight: -16, transform: 'scale(0.85)' }}
                            >
                                {leadsNewCount > 9 ? '9+' : leadsNewCount}
                            </span>
                        )}
                    </button>
                );
            })}
        </nav>
    );
};

// Settings menu entries with their backing permissions (PF007)
const SETTINGS_ITEMS = [
    { label: 'Integrations', icon: Key, path: '/settings/integrations', permission: 'tenant.integrations.manage' },
    { label: 'Company', icon: Building2, path: '/settings/company', permission: 'tenant.company.manage' },
    { label: 'Lead & Job', icon: FileText, path: '/settings/lead-form', permission: 'tenant.company.manage' },
    { label: 'Quick Messages', icon: MessageSquareText, path: '/settings/quick-messages', permission: 'tenant.company.manage' },
    { label: 'API Docs', icon: BookOpen, path: '/settings/api-docs', permission: 'tenant.integrations.manage' },
    { label: 'Users', icon: Users, path: '/settings/users', permission: 'tenant.users.manage' },
    { label: 'Roles & Access', icon: Shield, path: '/settings/roles', permission: 'tenant.roles.manage' },
    { label: 'Providers', icon: Wrench, path: '/settings/providers', permission: 'tenant.company.manage' },
    { label: 'Telephony', icon: PhoneIncoming, path: '/settings/telephony', permission: 'tenant.telephony.manage' },
    { label: 'Actions & Notifications', icon: Bell, path: '/settings/actions-notifications', permission: 'tenant.company.manage' },
    { label: 'Automation', icon: Zap, path: '/settings/automation', permission: 'tenant.company.manage' },
    { label: 'Billing', icon: CreditCard, path: '/settings/billing', permission: 'tenant.company.manage' },
    { label: 'Service Territories', icon: MapPin, path: '/settings/service-territories', permission: 'tenant.company.manage' },
    { label: 'Document Templates', icon: FileCog, path: '/settings/document-templates', permission: 'tenant.integrations.manage' },
] as const;

export const SettingsMenu: React.FC<{ activeTab: string; hasRole: (r: string) => boolean; logout: () => void }> = ({ activeTab, logout }) => {
    const navigate = useNavigate();
    const { hasPermission, hasPlatformRole } = useAuthz();
    const items = SETTINGS_ITEMS.filter(i => hasPermission(i.permission));
    // Platform admin entry is platform-role based, never a tenant capability
    const isPlatformAdmin = hasPlatformRole('super_admin');

    if (items.length === 0 && !isPlatformAdmin) {
        return (
            <button className="user-menu" style={{ cursor: 'pointer' }} onClick={logout}>
                <LogOut className="size-4" style={{ display: 'inline', verticalAlign: 'middle', marginRight: '4px' }} />
                <span className="hidden md:inline">Log Out</span>
            </button>
        );
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild><button className="user-menu" style={{ cursor: 'pointer', fontWeight: activeTab === 'settings' ? 600 : 400 }}><Settings className="size-4" style={{ display: 'inline', verticalAlign: 'middle', marginRight: '4px' }} /><span className="hidden md:inline">Settings</span></button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
                {items.map(i => {
                    const Icon = i.icon;
                    return (
                        <DropdownMenuItem key={i.path} className="flex items-center gap-2 cursor-pointer" onClick={() => navigate(i.path)}><Icon className="size-4" />{i.label}</DropdownMenuItem>
                    );
                })}
                {isPlatformAdmin && <><DropdownMenuSeparator /><DropdownMenuItem className="flex items-center gap-2 cursor-pointer" onClick={() => navigate('/settings/admin')}><Shield className="size-4" />Super Admin</DropdownMenuItem></>}
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
    if (pathname.startsWith('/tasks')) return 'tasks';
    if (pathname.startsWith('/contacts')) return 'contacts';
    if (pathname.startsWith('/payments')) return 'payments';
    if (pathname.startsWith('/settings')) return 'settings';
    if (pathname.startsWith('/calls') || pathname.startsWith('/contact/')) return 'calls';
    return 'pulse';
}
