import type { ReactNode } from 'react';

export interface SettingsSectionProps {
    /** Section heading, shown in the left label column (desktop) / above the card (mobile). */
    title?: string;
    /** Muted helper line under the title. */
    description?: string;
    /** Bottom action row (per-section Save), right-aligned inside the card. */
    footer?: ReactNode;
    /** true = no surface: a plain group with no background/padding. */
    flat?: boolean;
    children: ReactNode;
}

/** Section-card surface values from CLAUDE.md (UI section). No borders, no shadows. */
const surface = { background: 'rgba(25, 25, 25, 0.03)', borderRadius: 16, padding: '20px 22px' } as const;

/**
 * Canonical Settings section (UI-AUDIT-001 W4) — «лейбл слева, карточка справа»
 * (паттерн Stripe Dashboard): на десктопе заголовок+описание секции живут в левой
 * колонке ПРЯМО на канвасе (правило 7 — без поверхности), контент — единственная
 * карточка справа. Пустая правая зона широких экранов превращается в структуру.
 * На мобильном — стек (лейбл над карточкой). Ритм полей внутри children —
 * space-y-3.5 / grid gap — задаёт вызывающий.
 */
export function SettingsSection({ title, description, footer, flat = false, children }: SettingsSectionProps) {
    const card = (
        <div style={flat ? undefined : surface}>
            {children}
            {footer && <div className="mt-4 flex items-center justify-end gap-3">{footer}</div>}
        </div>
    );

    if (!title && !description) return <section>{card}</section>;

    return (
        <section className="grid grid-cols-1 md:grid-cols-[240px_1fr] gap-3 md:gap-8">
            <div className="md:pt-1">
                {title && (
                    <div className="text-sm font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>{title}</div>
                )}
                {description && (
                    <p className="text-[13px] mt-1" style={{ color: 'var(--blanc-ink-3)' }}>{description}</p>
                )}
            </div>
            {card}
        </section>
    );
}
