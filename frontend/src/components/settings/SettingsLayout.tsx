import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { BottomSheet } from '../ui/BottomSheet';
import { useAuthz } from '../../hooks/useAuthz';
import {
    findActiveSettingsGroup,
    getVisibleSettingsGroups,
    isSettingsNavLinkActive,
} from './settingsNav';

/** SETTINGS-IA-001: collapsed group list with only the active group's leaves exposed. */
export default function SettingsLayout() {
    const location = useLocation();
    const navigate = useNavigate();
    const { permissions, platformRole, membership, company } = useAuthz();
    const groups = getVisibleSettingsGroups({
        permissions,
        platformRole,
        tenantRole: membership?.role_key,
        companyFlags: { app_studio_enabled: company?.app_studio_enabled },
    });
    const activeGroup = findActiveSettingsGroup(groups, location);
    // SETTINGS-NAV-MOBILE: the sidebar is desktop-only (md:block), so on a phone the
    // settings tree was unreachable — you could land on /settings/users by URL but had
    // no way into its siblings (Roles & permissions…). One picker opens the same tree
    // in a BottomSheet (OVERLAY-CANON: nav lists become sheets on mobile).
    const [navOpen, setNavOpen] = useState(false);
    const activeLink = activeGroup?.links.find(link => isSettingsNavLinkActive(link, location));

    return (
        <div className="md:flex md:h-full">
            <aside className="hidden w-[256px] shrink-0 overflow-y-auto px-4 py-8 md:block">
                <div
                    className="px-3 text-lg font-semibold"
                    style={{ fontFamily: 'var(--blanc-font-heading, inherit)', color: 'var(--blanc-ink-1)' }}
                >
                    Settings
                </div>
                <nav className="mt-6 space-y-1" aria-label="Settings">
                    {groups.map((group, index) => {
                        const isActive = activeGroup?.id === group.id;
                        const startsPlatformSection = group.kind === 'platform'
                            && groups[index - 1]?.kind !== 'platform';
                        return (
                            <div
                                key={group.id}
                                className={startsPlatformSection ? 'mt-5 pt-5' : undefined}
                                style={startsPlatformSection ? { borderTop: '1px solid var(--blanc-line)' } : undefined}
                            >
                                <button
                                    type="button"
                                    className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-[13px] transition-colors ${isActive
                                        ? 'font-semibold text-[var(--blanc-accent)]'
                                        : 'font-medium text-[var(--blanc-ink-2)] hover:text-[var(--blanc-ink-1)]'
                                    }`}
                                    style={isActive ? { background: 'var(--blanc-accent-soft)' } : undefined}
                                    onClick={() => navigate(group.links[0].to)}
                                    aria-expanded={isActive}
                                >
                                    <span>{group.title}</span>
                                    {isActive
                                        ? <ChevronDown className="size-3.5 shrink-0" />
                                        : <ChevronRight className="size-3.5 shrink-0" />}
                                </button>
                                {isActive && (
                                    <div className="mt-1 space-y-0.5 pl-3">
                                        {group.links.map(link => {
                                            const linkActive = isSettingsNavLinkActive(link, location);
                                            return (
                                                <Link
                                                    key={link.id}
                                                    to={link.to}
                                                    aria-current={linkActive ? 'page' : undefined}
                                                    className={`block rounded-lg px-3 py-1.5 text-[13px] transition-colors ${linkActive
                                                        ? 'font-semibold text-[var(--blanc-accent)]'
                                                        : 'text-[var(--blanc-ink-3)] hover:text-[var(--blanc-ink-1)]'
                                                    }`}
                                                >
                                                    {link.label}
                                                </Link>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </nav>
            </aside>
            <div className="md:min-w-0 md:flex-1 md:overflow-y-auto">
                <div className="px-4 pt-3 md:hidden">
                    <button
                        type="button"
                        onClick={() => setNavOpen(true)}
                        className="flex w-full items-center justify-between gap-2 rounded-xl px-3.5 py-2.5 text-left"
                        style={{ background: 'var(--blanc-field)', color: 'var(--blanc-ink-1)' }}
                    >
                        <span className="min-w-0 truncate text-sm font-medium">
                            {activeGroup?.title ?? 'Settings'}
                            {activeLink && activeGroup && activeLink.label !== activeGroup.title
                                ? ` · ${activeLink.label}`
                                : ''}
                        </span>
                        <ChevronDown className="size-4 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                    </button>
                </div>
                <BottomSheet open={navOpen} onClose={() => setNavOpen(false)} title="Settings" size="auto">
                    <div className="space-y-5 pb-2">
                        {groups.map(group => (
                            <div key={group.id}>
                                <p className="blanc-eyebrow px-1">{group.title}</p>
                                <div className="mt-1.5 space-y-0.5">
                                    {group.links.map(link => {
                                        const linkActive = isSettingsNavLinkActive(link, location);
                                        return (
                                            <Link
                                                key={link.id}
                                                to={link.to}
                                                onClick={() => setNavOpen(false)}
                                                aria-current={linkActive ? 'page' : undefined}
                                                className={`block rounded-lg px-3 py-2.5 text-[15px] ${linkActive
                                                    ? 'font-semibold text-[var(--blanc-accent)]'
                                                    : 'text-[var(--blanc-ink-1)]'
                                                }`}
                                                style={linkActive ? { background: 'var(--blanc-accent-soft)' } : undefined}
                                            >
                                                {link.label}
                                            </Link>
                                        );
                                    })}
                                </div>
                            </div>
                        ))}
                    </div>
                </BottomSheet>
                <Outlet />
            </div>
        </div>
    );
}
