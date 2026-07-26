import React, { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '../ui/dropdown-menu';
import { BottomSheet } from '../ui/BottomSheet';
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
            <button
                type="button"
                onClick={() => navigate('/pulse')}
                aria-label="albusto — go to Pulse"
                title="Pulse"
                style={{ margin: 0, padding: 0, border: 'none', background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
            >
                <img src="/albusto-wordmark.svg" alt="albusto" style={{ height: 28, width: 'auto', display: 'block' }} />
            </button>
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
// MOBILE-NAV-001: the top header (brand + settings gear) is hidden on mobile to
// reclaim vertical space. The bottom bar carries the four primary workspaces and
// a "More" gear that opens a sheet with the remaining workspaces, every settings
// group, feedback and Log out — so the whole app stays reachable from one bar.

const PRIMARY_KEYS: readonly string[] = ['pulse', 'leads', 'jobs', 'tasks'];

export const MobileMoreSheet: React.FC<{ open: boolean; onClose: () => void; logout: () => void; activeTab: string }> = ({ open, onClose, logout, activeTab }) => {
    const navigate = useNavigate();
    const location = useLocation();
    const { permissions, platformRole } = useAuthz();
    const overflowTabs = useVisibleTabs().filter(t => !PRIMARY_KEYS.includes(t.key));
    const groups = getVisibleSettingsGroups({ permissions, platformRole });
    const activeGroup = findActiveSettingsGroup(groups, location);
    // Feedback is offered ONLY on the exact /pulse inbox (matches the FAB gating
    // in AppLayout), so the sheet never dispatches into a widget that isn't mounted.
    const isFeedbackEnabled = isFeedbackWidgetEnabled(import.meta.env.VITE_FEATURE_FEEDBACK_WIDGET)
        && location.pathname === '/pulse';
    const go = (path: string) => { onClose(); navigate(path); };

    return (
        <BottomSheet open={open} onClose={onClose} title="Menu">
            <div className="flex flex-col pb-1">
                {overflowTabs.map(t => {
                    const Icon = t.icon;
                    const isActive = activeTab === t.key;
                    return (
                        <button
                            key={t.key}
                            onClick={() => go(t.path)}
                            className={`flex items-center gap-3 px-1 py-3 text-left text-[15px] ${isActive ? 'font-semibold text-[var(--blanc-accent)]' : 'text-[var(--blanc-ink-1)]'}`}
                        >
                            <Icon className="size-5 text-[var(--blanc-ink-3)]" />{t.label}
                        </button>
                    );
                })}

                {groups.length > 0 && (
                    <>
                        <div className="blanc-eyebrow mt-4 mb-1 px-1">Settings</div>
                        {groups.map(group => {
                            const isActive = activeGroup?.id === group.id;
                            return (
                                <button
                                    key={group.id}
                                    onClick={() => go(group.links[0].to)}
                                    className={`flex items-center justify-between gap-3 px-1 py-3 text-left text-[15px] ${isActive ? 'font-semibold text-[var(--blanc-accent)]' : 'text-[var(--blanc-ink-1)]'}`}
                                >
                                    {group.title}<ChevronRight className="size-4 text-[var(--blanc-ink-3)]" />
                                </button>
                            );
                        })}
                    </>
                )}

                <div className="mt-4 flex flex-col">
                    {isFeedbackEnabled && (
                        <button
                            onClick={() => { onClose(); openFeedbackWidget(); }}
                            className="flex items-center gap-3 px-1 py-3 text-left text-[15px] text-[var(--blanc-ink-1)]"
                        >
                            <MessageSquareText className="size-5 text-[var(--blanc-ink-3)]" />Send feedback
                        </button>
                    )}
                    <button
                        onClick={() => { onClose(); logout(); }}
                        className="flex items-center gap-3 px-1 py-3 text-left text-[15px] text-red-600"
                    >
                        <LogOut className="size-5" />Log out
                    </button>
                </div>
            </div>
        </BottomSheet>
    );
};

export const BottomNavBar: React.FC<{ activeTab: string; pulseUnreadCount: number; leadsNewCount: number; openTasksCount: number; logout: () => void }> = ({ activeTab, pulseUnreadCount, leadsNewCount, openTasksCount, logout }) => {
    const navigate = useNavigate();
    const primary = useVisibleTabs().filter(t => PRIMARY_KEYS.includes(t.key));
    const [moreOpen, setMoreOpen] = useState(false);
    // "More" lights up whenever the active surface isn't one of the four primary
    // workspaces (i.e. it lives in the sheet: schedule/contacts/payments/settings).
    const moreActive = !PRIMARY_KEYS.includes(activeTab);
    const badgeFor = (key: string) =>
        key === 'pulse' ? pulseUnreadCount : key === 'leads' ? leadsNewCount : key === 'tasks' ? openTasksCount : 0;
    return (
        <>
            <nav className="app-bottom-nav">
                {primary.map(t => {
                    const Icon = t.icon;
                    const badge = badgeFor(t.key);
                    return (
                        <button
                            key={t.key}
                            className={`app-bottom-nav-item ${activeTab === t.key ? 'active' : ''}`}
                            onClick={() => navigate(t.path)}
                        >
                            <Icon className="size-5" />
                            <span>{t.label}</span>
                            {badge > 0 && (
                                <span
                                    className="pulse-unread-badge"
                                    style={{ position: 'absolute', top: 4, right: '50%', marginRight: -16, transform: 'scale(0.85)' }}
                                >
                                    {badge > 9 ? '9+' : badge}
                                </span>
                            )}
                        </button>
                    );
                })}
                <button
                    className={`app-bottom-nav-item ${moreActive ? 'active' : ''}`}
                    onClick={() => setMoreOpen(true)}
                    aria-label="More"
                >
                    <Settings className="size-5" />
                    <span>More</span>
                </button>
            </nav>
            <MobileMoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} logout={logout} activeTab={activeTab} />
        </>
    );
};

export const SettingsMenu: React.FC<{ activeTab: string; hasRole: (r: string) => boolean; logout: () => void }> = ({ activeTab, logout }) => {
    const navigate = useNavigate();
    const location = useLocation();
    const { permissions, platformRole } = useAuthz();
    const isMobile = useIsMobile();
    // Feedback is offered ONLY on the exact /pulse inbox (matches the FAB gating in
    // AppLayout), so the mobile "Send feedback" item never dispatches into a widget
    // that isn't mounted.
    const isFeedbackEnabled = isFeedbackWidgetEnabled(import.meta.env.VITE_FEATURE_FEEDBACK_WIDGET)
        && location.pathname === '/pulse';
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
