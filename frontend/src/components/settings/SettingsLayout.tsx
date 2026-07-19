import { ChevronDown, ChevronRight } from 'lucide-react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
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
    const { permissions, platformRole } = useAuthz();
    const groups = getVisibleSettingsGroups({ permissions, platformRole });
    const activeGroup = findActiveSettingsGroup(groups, location);

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
                <Outlet />
            </div>
        </div>
    );
}
