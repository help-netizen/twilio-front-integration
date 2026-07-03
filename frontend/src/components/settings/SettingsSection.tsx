import type { ReactNode } from 'react';

export interface SettingsSectionProps {
    /** Section heading, rendered as a .blanc-eyebrow. */
    title?: string;
    /** Muted helper line under the title. */
    description?: string;
    /** Bottom action row (per-section Save), right-aligned. */
    footer?: ReactNode;
    /** true = no surface: a plain group with no background/padding. */
    flat?: boolean;
    children: ReactNode;
}

/** Section-card surface values from CLAUDE.md (UI section). No borders, no shadows. */
const surface = { background: 'rgba(25, 25, 25, 0.03)', borderRadius: 16, padding: '20px 22px' } as const;

/**
 * Canonical Settings section card (UI-AUDIT-001 W4). The single surface level on
 * the settings canvas (LAYOUT-CANON rule 7). Field rhythm inside `children`
 * (space-y-3.5 / grid gap) is owned by the caller.
 */
export function SettingsSection({ title, description, footer, flat = false, children }: SettingsSectionProps) {
    return (
        <section style={flat ? undefined : surface}>
            {(title || description) && (
                <div className="mb-4">
                    {title && <div className="blanc-eyebrow">{title}</div>}
                    {description && (
                        <p className="text-[13px]" style={{ color: 'var(--blanc-ink-3)' }}>{description}</p>
                    )}
                </div>
            )}
            {children}
            {footer && <div className="mt-4 flex items-center justify-end gap-3">{footer}</div>}
        </section>
    );
}
