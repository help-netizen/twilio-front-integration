import { ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { useAuthz } from '../../hooks/useAuthz';
import { useOnboardingChecklist } from '../../hooks/useOnboardingChecklist';

export const OnboardingChecklistCard = () => {
    const navigate = useNavigate();
    const { isTenantAdmin } = useAuthz();
    const { checklist } = useOnboardingChecklist();

    // Loading and errors fall through to null so Pulse remains fail-quiet.
    if (!isTenantAdmin() || !checklist?.visible) return null;

    const { done, total } = checklist.progress;
    const progressPercent = total > 0 ? Math.min(100, (done / total) * 100) : 0;

    return (
        <button
            type="button"
            onClick={() => navigate('/welcome')}
            className="flex w-full items-center gap-4 rounded-xl border bg-[var(--blanc-surface-strong)] px-5 py-3.5 text-left"
            style={{ borderColor: 'var(--blanc-line)' }}
        >
            <span
                className="shrink-0 text-base font-semibold"
                style={{ color: 'var(--blanc-ink-1)', fontFamily: 'var(--blanc-font-heading)' }}
            >
                Finish setting up
            </span>
            <span className="min-w-16 flex-1">
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
            </span>
            <span className="shrink-0 text-sm" style={{ color: 'var(--blanc-ink-3)' }}>
                {done} of {total} done
            </span>
            <ChevronRight className="size-4 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
        </button>
    );
};
