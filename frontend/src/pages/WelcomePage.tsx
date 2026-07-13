import { CheckCircle2, CreditCard, Mail, MapPin, Phone, Sparkles } from 'lucide-react';
import { Navigate, useNavigate } from 'react-router-dom';

import { CloudBanner } from '../components/ui/CloudBanner';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { useAuthz } from '../hooks/useAuthz';
import { useOnboardingChecklist } from '../hooks/useOnboardingChecklist';
import type { OnboardingChecklistTrial } from '../services/onboardingApi';

const stepIcons = {
    service_territory: MapPin,
    connect_telephony: Phone,
    connect_email: Mail,
    stripe_payments: CreditCard,
};

function WelcomePageSkeleton() {
    return (
        <div className="w-full px-4 py-6 sm:px-6 sm:py-8" aria-busy="true" aria-label="Loading setup progress">
            <div className="mx-auto w-full max-w-5xl space-y-6">
                <div className="space-y-3 rounded-[22px] bg-[var(--blanc-surface-muted)] p-6 sm:p-8">
                    <Skeleton className="h-3 w-36" />
                    <Skeleton className="h-8 w-64 max-w-full" />
                    <Skeleton className="h-4 w-full max-w-xl" />
                    <Skeleton className="h-1.5 w-full" />
                </div>
                <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
                    {[0, 1, 2, 3].map(item => (
                        <Skeleton key={item} className="h-36 w-full rounded-xl" />
                    ))}
                </div>
            </div>
        </div>
    );
}

function TrialInformer({ trial, onViewPlans }: { trial: OnboardingChecklistTrial; onViewPlans: () => void }) {
    const title = trial.days_left === 0
        ? 'Your trial ends today'
        : `${trial.days_left} ${trial.days_left === 1 ? 'day' : 'days'} left on your trial`;

    return (
        <section
            aria-label="Trial status"
            className="flex flex-col gap-4 rounded-xl p-5 sm:flex-row sm:items-center sm:justify-between"
            style={{ background: 'var(--blanc-surface-muted)' }}
        >
            <div>
                <h2
                    className="text-base font-semibold"
                    style={{ color: 'var(--blanc-ink-1)', fontFamily: 'var(--blanc-font-heading)' }}
                >
                    {title}
                </h2>
                <p className="mt-1 text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                    Your setup carries over when you pick a plan.
                </p>
            </div>
            <Button variant="outline" className="h-11 self-start px-5 sm:self-auto" onClick={onViewPlans}>
                View plans
            </Button>
        </section>
    );
}

export default function WelcomePage() {
    const navigate = useNavigate();
    const { loading: authzLoading, isTenantAdmin } = useAuthz();
    const { checklist, isLoading, error } = useOnboardingChecklist();

    if (authzLoading) return <WelcomePageSkeleton />;
    if (!isTenantAdmin()) return <Navigate to="/pulse" replace />;
    if (isLoading) return <WelcomePageSkeleton />;

    if (error || !checklist) {
        return (
            <div className="w-full px-4 py-6 sm:px-6 sm:py-8">
                <main className="mx-auto w-full max-w-5xl">
                    <CloudBanner variant="hero">
                        <p className="blanc-eyebrow">WELCOME TO ALBUSTO</p>
                        <h2
                            className="mt-2 text-2xl sm:text-[28px]"
                            style={{ color: 'var(--blanc-ink-1)', fontFamily: 'var(--blanc-font-heading)', fontWeight: 800 }}
                        >
                            Let's get you set up
                        </h2>
                        <p className="mt-2 text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                            We couldn't load your setup progress. It'll retry automatically.
                        </p>
                    </CloudBanner>
                </main>
            </div>
        );
    }

    const { done, total } = checklist.progress;
    const complete = total > 0 && done === total;
    const progressPercent = total > 0 ? Math.min(100, (done / total) * 100) : 0;

    return (
        <div className="w-full px-4 py-6 sm:px-6 sm:py-8">
            <main className="mx-auto w-full max-w-5xl space-y-6">
                {complete ? (
                    <CloudBanner variant="hero">
                        <p className="blanc-eyebrow">WELCOME TO ALBUSTO</p>
                        <h2
                            className="mt-2 text-2xl sm:text-[28px]"
                            style={{ color: 'var(--blanc-ink-1)', fontFamily: 'var(--blanc-font-heading)', fontWeight: 800 }}
                        >
                            You're all set!
                        </h2>
                        <p className="mt-2 text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                            Your workspace is ready — calls, email, and payments are all wired up.
                        </p>
                        <Button className="mt-5 h-11 px-6" onClick={() => navigate('/pulse')}>
                            Go to Pulse
                        </Button>
                    </CloudBanner>
                ) : (
                    <>
                        <CloudBanner variant="hero">
                            <p className="blanc-eyebrow">WELCOME TO ALBUSTO</p>
                            <h2
                                className="mt-2 text-2xl sm:text-[28px]"
                                style={{ color: 'var(--blanc-ink-1)', fontFamily: 'var(--blanc-font-heading)', fontWeight: 800 }}
                            >
                                Let's get you set up
                            </h2>
                            <p className="mt-2 text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                                Four quick steps, about 3 minutes — and you're ready for your first customer.
                            </p>
                            <div className="mt-6">
                                <p className="mb-2 text-sm font-medium" style={{ color: 'var(--blanc-ink-2)' }}>
                                    {done} of {total} done
                                </p>
                                <div
                                    role="progressbar"
                                    aria-label="Setup progress"
                                    aria-valuemin={0}
                                    aria-valuemax={total}
                                    aria-valuenow={done}
                                    className="h-1.5 overflow-hidden rounded-full"
                                    style={{ background: 'rgba(25,25,25,0.06)' }}
                                >
                                    <div
                                        className="h-full rounded-full"
                                        style={{ background: 'var(--blanc-accent)', width: `${progressPercent}%` }}
                                    />
                                </div>
                            </div>
                        </CloudBanner>

                        <section aria-label="Setup steps" className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
                            {checklist.items.map(item => {
                                const StepIcon = stepIcons[item.key as keyof typeof stepIcons] ?? Sparkles;

                                return (
                                    <article
                                        key={item.key}
                                        className="flex items-start gap-3.5 rounded-xl border bg-[var(--blanc-surface-strong)] p-5"
                                        style={{ borderColor: 'var(--blanc-line)' }}
                                    >
                                        <div
                                            className="flex size-10 shrink-0 items-center justify-center rounded-xl"
                                            style={{ background: 'var(--blanc-accent-soft)' }}
                                        >
                                            <StepIcon className="size-5" style={{ color: 'var(--blanc-accent)' }} />
                                        </div>
                                        <div className="flex min-w-0 flex-1 flex-col items-start">
                                            <div className="flex items-center gap-1.5">
                                                <h3
                                                    className="text-base font-semibold"
                                                    style={{ color: 'var(--blanc-ink-1)', fontFamily: 'var(--blanc-font-heading)' }}
                                                >
                                                    {item.title}
                                                </h3>
                                                {item.done && (
                                                    <CheckCircle2 className="size-4 shrink-0" style={{ color: 'var(--blanc-success)' }} />
                                                )}
                                            </div>
                                            <p className="mt-1 text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                                                {item.done ? item.done_note : item.description}
                                            </p>
                                            {!item.done && (
                                                <>
                                                    <p className="mt-3 text-[13px]" style={{ color: 'var(--blanc-ink-3)' }}>
                                                        ~{item.est_minutes} min
                                                    </p>
                                                    <Button className="mt-3" onClick={() => navigate(item.cta.path)}>
                                                        {item.cta.label}
                                                    </Button>
                                                </>
                                            )}
                                        </div>
                                    </article>
                                );
                            })}
                        </section>
                    </>
                )}

                {checklist.trial && (
                    <TrialInformer trial={checklist.trial} onViewPlans={() => navigate('/settings/billing')} />
                )}
            </main>
        </div>
    );
}
