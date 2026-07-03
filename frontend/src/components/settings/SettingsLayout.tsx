import { NavLink, Outlet } from 'react-router-dom';
import { useAuthz } from '../../hooks/useAuthz';
import { SETTINGS_NAV, type SettingsNavLink } from './settingsNav';

/**
 * Settings layout route (UI-AUDIT-001 W4, variant C): persistent left sub-nav
 * on desktop, pages render in <Outlet/>.
 *
 * - Sidebar is canvas-only (LAYOUT-CANON rule 7): no background/border panel,
 *   just text and the soft active fill. Visual reference: TelephonyNav.
 * - Link gating mirrors ProtectedRoute semantics (any-of across the provided
 *   checks) via useAuthz; a group with no visible links is hidden entirely.
 * - Active state = NavLink's default match (pathname === to || starts with
 *   to + '/'), so /settings/integrations/vapi-ai highlights Integrations.
 * - <md: the sidebar is hidden and both wrappers are inert block flow — pages
 *   keep scrolling in .app-main exactly as before (mobile untouched).
 * - md+: the row fills .app-main (same trick as TelephonyLayout) and content
 *   scrolls in its own column, so the sidebar stays pinned.
 */
export default function SettingsLayout() {
    const { hasAnyPermission, hasPlatformRole } = useAuthz();

    const canSee = (link: SettingsNavLink) => {
        const checks: boolean[] = [];
        if (link.platformRoles && link.platformRoles.length > 0) checks.push(hasPlatformRole(...link.platformRoles));
        if (link.permissions && link.permissions.length > 0) checks.push(hasAnyPermission(...link.permissions));
        return checks.length === 0 ? true : checks.some(Boolean);
    };

    const groups = SETTINGS_NAV
        .map(group => ({ ...group, links: group.links.filter(canSee) }))
        .filter(group => group.links.length > 0);

    return (
        <div className="md:flex md:h-full">
            <aside className="hidden w-[232px] shrink-0 overflow-y-auto px-4 py-8 md:block">
                <div
                    className="px-3 text-lg font-semibold"
                    style={{ fontFamily: 'var(--blanc-font-heading, inherit)', color: 'var(--blanc-ink-1)' }}
                >
                    Settings
                </div>
                <nav className="mt-6 space-y-6">
                    {groups.map(group => (
                        <div key={group.title}>
                            <div className="blanc-eyebrow px-3">{group.title}</div>
                            <div className="mt-1.5 space-y-0.5">
                                {group.links.map(link => (
                                    <NavLink
                                        key={link.to}
                                        to={link.to}
                                        className={({ isActive }) =>
                                            `block rounded-lg px-3 py-1.5 text-[13px] transition-colors ${isActive
                                                ? 'bg-[rgba(127,66,225,0.08)] font-semibold text-[var(--blanc-accent)]'
                                                : 'text-[var(--blanc-ink-2)] hover:text-[var(--blanc-ink-1)]'
                                            }`
                                        }
                                    >
                                        {link.label}
                                    </NavLink>
                                ))}
                            </div>
                        </div>
                    ))}
                </nav>
            </aside>
            <div className="md:min-w-0 md:flex-1 md:overflow-y-auto">
                <Outlet />
            </div>
        </div>
    );
}
