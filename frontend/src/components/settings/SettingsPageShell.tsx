import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

export interface SettingsPageShellProps {
    /** Route for the back link. */
    backTo?: string;
    /** Back link text. */
    backLabel?: string;
    /** Optional eyebrow line above the title (.blanc-eyebrow). */
    eyebrow?: string;
    title: string;
    description?: string;
    /** Rendered at the right edge of the title row (status badges, page-level buttons). */
    actions?: ReactNode;
    children: ReactNode;
}

/**
 * Canonical Settings page skeleton (UI-AUDIT-001 W4, LAYOUT-CANON).
 * Invisible container (rule 7): a single max-width wrapper owns the page padding
 * and the 24px section rhythm (rule 5 — spacing comes from the parent, so children
 * never carry their own margins). Surfaces belong to the sections themselves
 * (see SettingsSection).
 *
 * ВЫРАВНИВАНИЕ — ПО ЛЕВОМУ КРАЮ (решение владельца, 2026-07-02): колонка
 * ограничена max-w-4xl для читаемости, но прижата к левому полю страницы.
 * Центрирование (mx-auto) ломает восприятие при разной ширине контента
 * секций; слой/шторка для настроек отвергнуты — это полноэкранная страница.
 */
export function SettingsPageShell({
    backTo = '/settings',
    backLabel = 'Settings',
    eyebrow,
    title,
    description,
    actions,
    children,
}: SettingsPageShellProps) {
    const navigate = useNavigate();

    return (
        <div className="flex max-w-5xl flex-col gap-8 px-6 py-8" style={{ color: 'var(--blanc-ink-1)' }}>
            {/* Back link is mobile-only: on md+ the persistent Settings sidebar
                (SettingsLayout) makes it redundant. gap (not space-y) so the hidden
                button leaves no phantom margin before the title on desktop. */}
            <button
                type="button"
                onClick={() => navigate(backTo)}
                className="flex items-center gap-1.5 text-sm md:hidden"
                style={{ color: 'var(--blanc-ink-3)' }}
            >
                <ArrowLeft className="h-4 w-4" /> {backLabel}
            </button>

            {/* OB-9: stack actions below the title on mobile so page-level buttons
                (e.g. "Get another number") never overlap the heading at 375px;
                row layout with right-aligned actions returns at sm+. */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                    {eyebrow && <div className="blanc-eyebrow">{eyebrow}</div>}
                    <h2
                        className="text-2xl font-semibold"
                        style={{ fontFamily: 'var(--blanc-font-heading, inherit)', color: 'var(--blanc-ink-1)' }}
                    >
                        {title}
                    </h2>
                    {description && (
                        <p className="text-sm mt-1" style={{ color: 'var(--blanc-ink-2)' }}>{description}</p>
                    )}
                </div>
                {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
            </div>

            {children}
        </div>
    );
}
