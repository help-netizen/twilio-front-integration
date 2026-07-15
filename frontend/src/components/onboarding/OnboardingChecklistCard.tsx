import { CheckCircle2, ChevronRight, Circle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { useAuthz } from '../../hooks/useAuthz';
import { useOnboardingChecklist } from '../../hooks/useOnboardingChecklist';

/**
 * OB-8: compact onboarding tracker for /pulse. Instead of hiding the steps behind
 * a single "Finish setting up" row, it surfaces the actual steps inline (done/pending),
 * so the user sees at a glance what's left. Header (and progress) → /welcome hub;
 * tapping a pending step → that step's CTA. Gate + fail-quiet preserved (admins only,
 * hidden when the checklist isn't visible / failed to load).
 */
export const OnboardingChecklistCard = () => {
    const navigate = useNavigate();
    const { isTenantAdmin } = useAuthz();
    const { checklist } = useOnboardingChecklist();

    // Loading and errors fall through to null so Pulse remains fail-quiet.
    if (!isTenantAdmin() || !checklist?.visible) return null;

    const { done, total } = checklist.progress;
    const progressPercent = total > 0 ? Math.min(100, (done / total) * 100) : 0;

    return (
        <div
            className="rounded-xl border bg-[var(--blanc-surface-strong)]"
            style={{ borderColor: 'var(--blanc-line)' }}
        >
            {/* Header → the full /welcome setup hub */}
            <button
                type="button"
                onClick={() => navigate('/welcome')}
                className="flex w-full items-center gap-3 px-5 pt-3.5 pb-2 text-left"
            >
                <span
                    className="text-base font-semibold"
                    style={{ color: 'var(--blanc-ink-1)', fontFamily: 'var(--blanc-font-heading)' }}
                >
                    Finish setting up
                </span>
                <span className="flex-1" />
                <span className="shrink-0 text-sm" style={{ color: 'var(--blanc-ink-3)' }}>
                    {done} of {total}
                </span>
                <ChevronRight className="size-4 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
            </button>

            <div className="px-5">
                <span
                    role="progressbar"
                    aria-label="Setup progress"
                    aria-valuemin={0}
                    aria-valuemax={total}
                    aria-valuenow={done}
                    className="block h-1.5 overflow-hidden rounded-full"
                    style={{ background: 'rgba(25,25,25,0.06)' }}
                >
                    <span
                        className="block h-full rounded-full"
                        style={{ background: 'var(--blanc-accent)', width: `${progressPercent}%` }}
                    />
                </span>
            </div>

            {/* Steps — done (check) / pending (tap → its CTA) */}
            <ul className="mt-1.5 px-2 pb-2">
                {checklist.items.map(item =>
                    item.done ? (
                        <li key={item.key} className="flex items-center gap-2.5 px-3 py-2">
                            <CheckCircle2 className="size-4 shrink-0" style={{ color: 'var(--blanc-success)' }} />
                            <span className="truncate text-sm" style={{ color: 'var(--blanc-ink-3)' }}>
                                {item.title}
                            </span>
                        </li>
                    ) : (
                        <li key={item.key}>
                            <button
                                type="button"
                                onClick={() => navigate(item.cta.path)}
                                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--blanc-surface-muted)]"
                            >
                                <Circle className="size-4 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                                <span className="min-w-0 flex-1 truncate text-sm" style={{ color: 'var(--blanc-ink-1)' }}>
                                    {item.title}
                                </span>
                                <span className="shrink-0 text-[13px] font-medium" style={{ color: 'var(--blanc-accent)' }}>
                                    {item.cta.label}
                                </span>
                                <ChevronRight className="size-3.5 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                            </button>
                        </li>
                    )
                )}
            </ul>
        </div>
    );
};
