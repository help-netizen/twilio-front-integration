import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '../ui/dropdown-menu';
import { Users, Settings, LogOut, Activity, MessageSquareText, DollarSign, Contact2, Briefcase, CalendarDays, ListChecks, ChevronRight } from 'lucide-react';
import { useAuthz } from '../../hooks/useAuthz';
import { useIsMobile } from '../../hooks/useIsMobile';
import { isFeedbackWidgetEnabled, openFeedbackWidget } from '../feedback/FeedbackWidget';
import {
    findActiveSettingsGroup,
    getVisibleSettingsGroups,
    isSettingsNavLinkActive,
} from '../settings/settingsNav';

interface AppNavProps { activeTab: string; pulseUnreadCount: number; leadsNewCount: number; openTasksCount: number; hasRole: (r: string) => boolean; logout: () => void; }

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

export const AppNavTabs: React.FC<AppNavProps> = ({ activeTab, pulseUnreadCount, leadsNewCount, openTasksCount }) => {
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
                            <TabsTrigger key={t.key} value={t.key} className="flex items-center gap-2" onClick={() => navigate(t.path)} style={(t.key === 'pulse' || t.key === 'leads' || t.key === 'tasks') ? { position: 'relative' } : undefined}>
                                <Icon className="size-4" />{t.label}
                                {t.key === 'pulse' && pulseUnreadCount > 0 && <span className="pulse-unread-badge" title={`${pulseUnreadCount} unread`}>{pulseUnreadCount > 9 ? '9+' : pulseUnreadCount}</span>}
                                {t.key === 'leads' && leadsNewCount > 0 && <span className="pulse-unread-badge" title={`${leadsNewCount} new leads`}>{leadsNewCount > 9 ? '9+' : leadsNewCount}</span>}
                                {t.key === 'tasks' && openTasksCount > 0 && <span className="pulse-unread-badge" title={`${openTasksCount} open tasks`}>{openTasksCount > 9 ? '9+' : openTasksCount}</span>}
                            </TabsTrigger>
                        );
                    })}
                </TabsList>
            </Tabs>
        </div>
    );
};

// ─── Bottom Navigation Bar (mobile) ─────────────────────────────────────────

export const BottomNavBar: React.FC<{ activeTab: string; pulseUnreadCount: number; leadsNewCount: number; openTasksCount: number }> = ({ activeTab, pulseUnreadCount, leadsNewCount, openTasksCount }) => {
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
                        {t.key === 'tasks' && openTasksCount > 0 && (
                            <span
                                className="pulse-unread-badge"
                                style={{ position: 'absolute', top: 4, right: '50%', marginRight: -16, transform: 'scale(0.85)' }}
                            >
                                {openTasksCount > 9 ? '9+' : openTasksCount}
                            </span>
                        )}
                    </button>
                );
            })}
        </nav>
    );
};

export const SettingsMenu: React.FC<{ activeTab: string; hasRole: (r: string) => boolean; logout: () => void }> = ({ activeTab, logout }) => {
    const navigate = useNavigate();
    const location = useLocation();
    const { permissions, platformRole } = useAuthz();
    const isMobile = useIsMobile();
    const isFeedbackEnabled = isFeedbackWidgetEnabled(import.meta.env.VITE_FEATURE_FEEDBACK_WIDGET);
    const groups = getVisibleSettingsGroups({ permissions, platformRole });
    const activeGroup = findActiveSettingsGroup(groups, location);

    // Low-permission users (provider/technician) get no settings entries — but on
    // mobile the feedback FAB is hidden, so keep a dropdown that still offers
    // "Send feedback" alongside Log Out. Otherwise fall back to the bare button.
    if (groups.length === 0) {
        if (isMobile && isFeedbackEnabled) {
            return (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild><button className="user-menu" style={{ cursor: 'pointer' }}><Settings className="size-4" style={{ display: 'inline', verticalAlign: 'middle', marginRight: '4px' }} /><span className="hidden md:inline">Settings</span></button></DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem className="flex items-center gap-2 cursor-pointer" onClick={openFeedbackWidget}><MessageSquareText className="size-4" />Send feedback</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="flex items-center gap-2 cursor-pointer text-red-600" onClick={logout}><LogOut className="size-4" />Log Out</DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            );
        }
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
            <DropdownMenuContent align="end" className="w-72">
                {groups.map((group, index) => {
                    const isActive = activeGroup?.id === group.id;
                    const startsPlatformSection = group.kind === 'platform'
                        && groups[index - 1]?.kind !== 'platform';
                    return (
                        <React.Fragment key={group.id}>
                            {startsPlatformSection && <DropdownMenuSeparator />}
                            <DropdownMenuItem
                                className={`flex cursor-pointer items-center justify-between gap-2 ${isActive ? 'font-semibold text-[var(--blanc-accent)]' : ''}`}
                                onClick={() => navigate(group.links[0].to)}
                            >
                                {group.title}<ChevronRight className="size-3.5" />
                            </DropdownMenuItem>
                            {isActive && group.links.map(link => {
                                const linkActive = isSettingsNavLinkActive(link, location);
                                return (
                                    <DropdownMenuItem
                                        key={link.id}
                                        className={`ml-3 cursor-pointer pl-4 text-[13px] ${linkActive
                                            ? 'font-semibold text-[var(--blanc-accent)]'
                                            : 'text-[var(--blanc-ink-2)]'
                                        }`}
                                        onClick={() => navigate(link.to)}
                                    >
                                        {link.label}
                                    </DropdownMenuItem>
                                );
                            })}
                        </React.Fragment>
                    );
                })}
                {isMobile && isFeedbackEnabled && <DropdownMenuItem className="flex items-center gap-2 cursor-pointer" onClick={openFeedbackWidget}><MessageSquareText className="size-4" />Send feedback</DropdownMenuItem>}
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
