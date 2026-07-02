/**
 * OnboardingChecklistCard — ONBTEL-001 Part A (spec §1.5, normative).
 *
 * "Get started" card shown on /pulse between the unified header and the
 * two-column layout. Fully data-driven from GET /api/onboarding/checklist —
 * renders items[] from the response without knowing the catalog. Render gate
 * lives here: tenant_admin AND server-said-visible, otherwise null (so the
 * call site in PulsePage stays a single unconditional line).
 *
 * Collapse is client-only (localStorage, per-company key). There is NO
 * dismiss control by construction — the card disappears forever only when
 * the server fixes completed_at (write-once) and returns visible:false.
 */
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, ChevronDown, ChevronUp, Circle } from 'lucide-react';
import { Button } from '../ui/button';
import { useAuthz } from '../../hooks/useAuthz';
import { useOnboardingChecklist } from '../../hooks/useOnboardingChecklist';

const collapseKey = (companyId: string) => `albusto.onb-checklist.collapsed:${companyId}`;

export const OnboardingChecklistCard: React.FC = () => {
    const { company, isTenantAdmin } = useAuthz();
    const { checklist } = useOnboardingChecklist();
    const navigate = useNavigate();

    const storageKey = company?.id ? collapseKey(company.id) : null;

    // Collapse state — read per-company from localStorage; survives reload (A3).
    const [collapsed, setCollapsedState] = useState<boolean>(() => {
        if (!storageKey) return false;
        try { return localStorage.getItem(storageKey) === '1'; } catch { return false; }
    });

    // Re-sync if the company identity arrives late or changes (per-company key, E-A10).
    useEffect(() => {
        if (!storageKey) return;
        try { setCollapsedState(localStorage.getItem(storageKey) === '1'); } catch { /* ignore */ }
    }, [storageKey]);

    const setCollapsed = (next: boolean) => {
        setCollapsedState(next);
        if (!storageKey) return;
        try {
            if (next) localStorage.setItem(storageKey, '1');
            else localStorage.removeItem(storageKey);
        } catch { /* private mode — state still applies for the session */ }
    };

    // Render gate (spec §1.5): tenant_admin AND server-visible. Errors/loading
    // fall through to null — fail-quiet (A8), Pulse works as usual.
    if (!isTenantAdmin() || !checklist?.visible) return null;

    const items = checklist.items;
    const doneCount = items.filter(i => i.done).length;
    const progress = `${doneCount} of ${items.length} done`;

    return (
        <section
            style={{
                border: '1px solid var(--blanc-line)',
                borderRadius: 16,
                background: 'var(--blanc-surface-strong)',
                flexShrink: 0,
            }}
        >
            {collapsed ? (
                /* Collapsed — one compact row: title + progress + chevron (A3). */
                <button
                    type="button"
                    onClick={() => setCollapsed(false)}
                    aria-label="Expand checklist"
                    className="flex w-full items-center gap-3 px-5 py-3 text-left"
                >
                    <span
                        className="text-base font-semibold"
                        style={{ color: 'var(--blanc-ink-1)', fontFamily: 'var(--blanc-font-heading)' }}
                    >
                        Get started
                    </span>
                    <span className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>{progress}</span>
                    <ChevronDown className="size-4 ml-auto" style={{ color: 'var(--blanc-ink-3)' }} />
                </button>
            ) : (
                <div className="px-5 py-4">
                    <div className="flex items-start gap-3">
                        <div className="flex-1 min-w-0">
                            <div className="blanc-eyebrow">Getting started</div>
                            <h2
                                className="text-2xl font-semibold"
                                style={{ color: 'var(--blanc-ink-1)', fontFamily: 'var(--blanc-font-heading)' }}
                            >
                                Get started
                            </h2>
                        </div>
                        <span className="text-sm mt-1" style={{ color: 'var(--blanc-ink-3)' }}>{progress}</span>
                        <button
                            type="button"
                            onClick={() => setCollapsed(true)}
                            aria-label="Collapse checklist"
                            className="p-1.5 rounded-lg transition-colors hover:bg-black/[0.04]"
                        >
                            <ChevronUp className="size-4" style={{ color: 'var(--blanc-ink-3)' }} />
                        </button>
                    </div>

                    <div className="mt-4 space-y-3.5">
                        {items.map(item => (
                            <div key={item.key} className="flex items-center gap-3">
                                {item.done ? (
                                    <CheckCircle2 className="size-4 shrink-0" style={{ color: 'var(--blanc-success)' }} />
                                ) : (
                                    <Circle className="size-4 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                                )}
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm font-medium" style={{ color: 'var(--blanc-ink-1)' }}>
                                        {item.title}
                                    </div>
                                    <div className="text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                                        {item.description}
                                    </div>
                                </div>
                                {!item.done && (
                                    <Button size="sm" onClick={() => navigate(item.cta.path)}>
                                        {item.cta.label}
                                    </Button>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </section>
    );
};
