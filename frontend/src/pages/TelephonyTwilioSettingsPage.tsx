/**
 * TelephonyTwilioSettingsPage — TELEPHONY-WIZARD-UX-001 (WIZ-T3).
 *
 * Optional-plan "Telephony — Twilio" marketplace setup wizard:
 *   1 Plan   → connect implicitly, then billing checkout (or skip)
 *   2 Number → search connects implicitly; buy is an idempotent-connect fallback
 *   3 Transfer → port now or dismiss the prompt for later
 *   4 Done     → number and transfer decisions are both complete
 *
 * The ACTIVE step is DERIVED from server state (refresh/re-entry safe):
 *   donePlan = GET /api/billing → subscription != null && plan_id !== 'trial'
 *   doneNumber = purchased number OR non-canceled/non-failed port-in request
 *   doneTransfer = active port-in request OR dismissed transfer prompt
 * Plans are optional, so explicit overrides may navigate to any visible step.
 * Completion remains server-derived only.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
    AlertCircle, Check, CheckCircle2, ChevronRight,
    Loader2,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { SettingsPageShell } from '../components/settings/SettingsPageShell';
import { Badge } from '../components/ui/badge';
import { NumberSearch } from '../components/telephony/NumberSearch';
import { PortInPanel, type PortInRequest } from '../components/telephony/PortInPanel';
import { deriveWizardStep } from '../components/telephony/portInPrompt';
import { authedFetch } from '../services/apiClient';
import { billingApi, type BillingOverview, type Plan } from '../services/billingApi';

const RETURN_PATH = '/settings/integrations/telephony-twilio?step=2&billing=success';

// PAYG card contract (§2.4) — normative copy.
const PAYG_BULLETS = [
    'Calls $0.04 per minute',
    'Texts $0.03 each',
    '1 phone number',
    'Usage is paid from your wallet',
];

function usd(n: number): string {
    return '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function packageBullets(p: Plan): string[] {
    const out: string[] = [];
    if (p.max_phone_numbers != null) {
        out.push(`Up to ${p.max_phone_numbers} phone number${p.max_phone_numbers === 1 ? '' : 's'}`);
    }
    const sms = Number(p.included_units?.sms || 0);
    if (sms > 0) out.push(`${sms.toLocaleString()} text messages included`);
    const mins = Number(p.included_units?.call_minutes || 0);
    if (mins > 0) out.push(`${mins.toLocaleString()} call minutes included`);
    return out;
}

function InlineError({ text }: { text: string }) {
    return (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 13, color: 'var(--blanc-danger)' }}>
            <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{text}</span>
        </div>
    );
}

function PlanBullet({ text }: { text: string }) {
    return (
        <li style={{ display: 'flex', gap: 7, fontSize: 13, color: 'var(--blanc-ink-2)' }}>
            <Check size={15} style={{ color: 'var(--blanc-success)', flexShrink: 0, marginTop: 1 }} />
            {text}
        </li>
    );
}

function PlanCard({
    name, priceLabel, bullets, cta, caption, isCurrent, busy, disabled, onChoose,
}: {
    name: string;
    priceLabel: string;
    bullets: string[];
    cta: string;
    caption?: string;
    isCurrent: boolean;
    busy: boolean;
    disabled: boolean;
    onChoose: () => void;
}) {
    return (
        <div style={{
            border: `1px solid ${isCurrent ? 'var(--blanc-info, #2f63d8)' : 'var(--blanc-line)'}`,
            borderRadius: 16, padding: 18, background: 'var(--blanc-surface-strong, #fffdf9)',
            display: 'flex', flexDirection: 'column', gap: 12,
            flex: '1 1 230px', minWidth: 230, maxWidth: 300,
        }}>
            <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--blanc-ink-1)', fontFamily: 'var(--blanc-font-heading, Manrope), sans-serif' }}>
                        {name}
                    </span>
                    {isCurrent && (
                        <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 999, background: 'rgba(47,99,216,0.12)', color: 'var(--blanc-info, #2f63d8)' }}>
                            Current
                        </span>
                    )}
                </div>
                <div style={{ fontSize: 21, fontWeight: 600, marginTop: 2, fontFamily: 'var(--blanc-font-heading, Manrope), sans-serif', color: 'var(--blanc-ink-1)' }}>
                    {priceLabel}
                </div>
            </div>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {bullets.map(b => <PlanBullet key={b} text={b} />)}
            </ul>
            <div style={{ marginTop: 'auto' }}>
                <Button className="w-full" disabled={disabled} onClick={onChoose}>
                    {busy && <Loader2 size={14} className="mr-1.5 animate-spin" />}
                    {isCurrent ? 'Keep this plan' : cta}
                </Button>
                {caption && !isCurrent && (
                    <div style={{ fontSize: 11.5, color: 'var(--blanc-ink-3)', textAlign: 'center', marginTop: 7 }}>
                        {caption}
                    </div>
                )}
            </div>
        </div>
    );
}

export default function TelephonyTwilioSettingsPage() {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const billingSuccess = searchParams.get('billing') === 'success';

    // Plans are optional, so any visible step is a valid explicit destination.
    const [stepOverride, setStepOverride] = useState<number | null>(() => {
        const hint = Number(searchParams.get('step'));
        return Number.isInteger(hint) && hint >= 1 && hint <= 3 ? hint : null;
    });

    // ── Step derivation queries — the server is the single source of truth ────
    const billingQ = useQuery({
        queryKey: ['telephony-twilio-wizard', 'billing'],
        queryFn: async (): Promise<BillingOverview | null> => {
            const r = await authedFetch('/api/billing');
            const j = await r.json().catch(() => ({}));
            if (!r.ok || j.ok === false) return null;
            return j as BillingOverview;
        },
    });
    const numbersQ = useQuery({
        queryKey: ['telephony-twilio-wizard', 'numbers'],
        queryFn: async (): Promise<unknown[]> => {
            // { ok, numbers: [], not_connected: true } reads as 0 numbers — NOT an error.
            const r = await authedFetch('/api/telephony/numbers');
            const j = await r.json().catch(() => ({}));
            if (!r.ok || !Array.isArray(j.numbers)) return [];
            return j.numbers;
        },
    });
    const portInQ = useQuery({
        queryKey: ['telephony-twilio-wizard', 'port-ins'],
        queryFn: async (): Promise<PortInRequest[]> => {
            const r = await authedFetch('/api/telephony/port-in');
            const j = await r.json().catch(() => ({}));
            if (!r.ok || !Array.isArray(j.requests)) return [];
            return j.requests;
        },
        retry: false,
    });
    const statusQ = useQuery({
        queryKey: ['telephony-twilio-wizard', 'status'],
        queryFn: async (): Promise<string | null> => {
            const response = await authedFetch('/api/telephony/numbers/status');
            const body = await response.json().catch(() => ({}));
            if (!response.ok) return null;
            return body.port_in_prompt === 'dismissed' ? 'dismissed' : null;
        },
        retry: false,
    });
    const walletQ = useQuery({
        queryKey: ['telephony-twilio-wizard', 'wallet'],
        queryFn: billingApi.wallet,
        retry: false,
    });

    const subscription = billingQ.data?.subscription ?? null;
    const donePlan = subscription != null && subscription.plan_id !== 'trial';
    const hasPurchasedNumber = (numbersQ.data?.length ?? 0) >= 1;
    const hasActivePortIn = (portInQ.data ?? []).some(request => !['canceled', 'failed'].includes(request.status));
    const doneNumber = hasPurchasedNumber || hasActivePortIn;
    const doneTransfer = hasActivePortIn || statusQ.data === 'dismissed';
    const derivedStep = deriveWizardStep({ donePlan, doneNumber, doneTransfer });
    const activeStep = stepOverride ?? derivedStep;
    const bootLoading = billingQ.isLoading || numbersQ.isLoading || portInQ.isLoading || statusQ.isLoading;

    // Stripe return — poll billing until the webhook flips the plan.
    const awaitingPayment = billingSuccess && !donePlan;
    const [pollTimedOut, setPollTimedOut] = useState(false);
    const refetchBilling = billingQ.refetch;
    useEffect(() => {
        if (!awaitingPayment) return;
        const iv = setInterval(() => { refetchBilling(); }, 3000);
        const to = setTimeout(() => setPollTimedOut(true), 60000);
        return () => { clearInterval(iv); clearTimeout(to); };
    }, [awaitingPayment, refetchBilling]);

    // ── Step 1: Plan ───────────────────────────────────────────────────────────
    const [planBusy, setPlanBusy] = useState<string | null>(null);
    const [planError, setPlanError] = useState<string | null>(null);
    const choosePlan = async (planId: string) => {
        setPlanBusy(planId);
        setPlanError(null);
        let connected = false;
        try {
            const connectResponse = await authedFetch('/api/telephony/numbers/connect', { method: 'POST' });
            if (!connectResponse.ok) {
                setPlanError(connectResponse.status === 403
                    ? "You don't have permission to manage telephony — ask your administrator."
                    : 'Could not set up your phone workspace — try again.');
                return;
            }
            connected = true;

            const body: Record<string, unknown> = { plan_id: planId };
            if (planId !== 'payg') body.return_path = RETURN_PATH;
            const r = await authedFetch('/api/billing/checkout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok || j.ok === false) {
                if (j.code === 'PROVIDER_NOT_CONFIGURED') setPlanError('Billing is not enabled yet.');
                else toast.error(j.error || 'Could not change plan');
                setStepOverride(1);
                await Promise.all([refetchBilling(), walletQ.refetch()]);
                return;
            }
            if (j.url) {
                window.location.href = j.url;
                return;
            }
            if (j.activated) {
                toast.success('Plan activated');
                setStepOverride(2);
                await Promise.all([refetchBilling(), walletQ.refetch()]);
            }
        } catch {
            if (connected) {
                toast.error('Could not change plan');
                setStepOverride(1);
                await Promise.all([refetchBilling(), walletQ.refetch()]);
            } else {
                setPlanError('Could not set up your phone workspace — try again.');
            }
        } finally {
            setPlanBusy(null);
        }
    };

    // ── Step 3: Transfer now or later ──────────────────────────────────────────
    const [transferExpanded, setTransferExpanded] = useState(false);
    const [dismissingTransfer, setDismissingTransfer] = useState(false);
    const refetchPortIns = portInQ.refetch;
    const handlePortRequestsChange = useCallback(() => {
        setStepOverride(null);
        void refetchPortIns();
    }, [refetchPortIns]);
    const dismissTransferPrompt = async () => {
        setDismissingTransfer(true);
        try {
            const response = await authedFetch('/api/telephony/numbers/port-in-prompt/dismiss', {
                method: 'POST',
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok || body.port_in_prompt !== 'dismissed') {
                toast.error(body.error || 'Could not save your choice — try again.');
                return;
            }
            toast.success('You can transfer numbers anytime from Settings → Phone Numbers');
            await statusQ.refetch();
            setStepOverride(null);
        } catch {
            toast.error('Could not save your choice — try again.');
        } finally {
            setDismissingTransfer(false);
        }
    };

    const plans = billingQ.data?.plans ?? [];
    const packagePlans: Plan[] = plans.filter(p => p.id !== 'trial' && p.id !== 'payg');
    const currentPlanId = subscription?.plan_id ?? null;
    const plansLocked = (awaitingPayment && !pollTimedOut) || planBusy != null;
    const walletBalance = Number(walletQ.data?.balance_usd ?? 0);

    const selectPlan = (planId: string, planName: string) => {
        if (planId === currentPlanId) {
            toast.success(`You're on ${planName} — all set`);
            setStepOverride(2);
            return;
        }
        void choosePlan(planId);
    };

    const stepsMeta = [
        { n: 1, label: 'Pick your plan', description: '$5 free credit included', done: donePlan },
        { n: 2, label: 'Choose your number', description: "It's live right away", done: doneNumber },
        { n: 3, label: 'Transfer your numbers', description: 'Now or later', done: doneTransfer },
    ];

    return (
        <SettingsPageShell
            backTo="/settings/integrations"
            backLabel="Integrations"
            title="Telephony — Twilio"
            description="Choose a plan or start with a phone number."
        >
            {bootLoading ? (
                <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--blanc-ink-3)' }}>
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
            ) : (
                <>
                    {/* Plans are optional: either visible step remains reachable. */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 26 }}>
                        {stepsMeta.map((s, i) => {
                            const isActive = s.n === activeStep;
                            const clickable = !isActive;
                            return (
                                <div key={s.n} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                    {i > 0 && <ChevronRight size={14} style={{ color: 'var(--blanc-ink-3)' }} />}
                                    <button
                                        type="button"
                                        onClick={clickable ? () => setStepOverride(s.n) : undefined}
                                        disabled={!clickable}
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: 8,
                                            background: 'none', border: 'none', padding: 0,
                                            cursor: clickable ? 'pointer' : 'default',
                                        }}
                                    >
                                        <span style={{
                                            width: 26, height: 26, borderRadius: 13, flexShrink: 0,
                                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                            fontSize: 12.5, fontWeight: 600,
                                            ...(s.done
                                                ? { background: 'rgba(27,139,99,0.12)', color: 'var(--blanc-success)' }
                                                : isActive
                                                    ? { background: 'var(--blanc-info, #2f63d8)', color: '#fff' }
                                                    : { background: 'rgba(25,25,25,0.06)', color: 'var(--blanc-ink-3)' }),
                                        }}>
                                            {s.done ? <Check size={14} /> : s.n}
                                        </span>
                                        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', textAlign: 'left' }}>
                                            <span style={{
                                                fontSize: 13.5,
                                                fontWeight: isActive ? 600 : 500,
                                                color: isActive ? 'var(--blanc-ink-1)' : s.done ? 'var(--blanc-ink-2)' : 'var(--blanc-ink-3)',
                                            }}>
                                                {s.label}
                                            </span>
                                            <span style={{ fontSize: 11.5, color: 'var(--blanc-ink-3)', marginTop: 1 }}>
                                                {s.description}
                                            </span>
                                        </span>
                                    </button>
                                </div>
                            );
                        })}
                    </div>

                    {awaitingPayment && (
                        <div style={{
                            border: '1px solid var(--blanc-line)', background: 'var(--blanc-surface-strong, #fffdf9)',
                            borderRadius: 16, padding: '14px 16px', marginBottom: 16,
                            display: 'flex', alignItems: 'flex-start', gap: 10,
                        }}>
                            {!pollTimedOut ? (
                                <>
                                    <Loader2 size={16} className="animate-spin" style={{ color: 'var(--blanc-info, #2f63d8)', flexShrink: 0, marginTop: 1 }} />
                                    <span style={{ fontSize: 13.5, color: 'var(--blanc-ink-1)' }}>Confirming your payment…</span>
                                </>
                            ) : (
                                <>
                                    <AlertCircle size={16} style={{ color: 'var(--blanc-warning)', flexShrink: 0, marginTop: 1 }} />
                                    <span style={{ fontSize: 13.5, color: 'var(--blanc-ink-2)' }}>
                                        Still waiting for payment confirmation. If you completed checkout, this page
                                        will update shortly — you can also check Settings → Billing.
                                    </span>
                                </>
                            )}
                        </div>
                    )}

                    {/* Step 1 — Choose or keep a plan */}
                    {activeStep === 1 && (
                        <div className="space-y-6">
                            <div className="space-y-2">
                                <p className="text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                                    You have $5 to try Albusto pay-as-you-go — or pick a package.
                                </p>
                                {walletBalance > 0 && (
                                    <Badge variant="outline">Wallet balance: ${walletBalance.toFixed(2)}</Badge>
                                )}
                            </div>
                            {planError && <InlineError text={planError} />}
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
                                <PlanCard
                                    name="Pay as you go"
                                    priceLabel="$0/mo"
                                    bullets={PAYG_BULLETS}
                                    cta="Choose Pay as you go"
                                    isCurrent={currentPlanId === 'payg'}
                                    busy={planBusy === 'payg'}
                                    disabled={plansLocked}
                                    onChoose={() => selectPlan('payg', 'Pay as you go')}
                                />
                                {packagePlans.map(p => (
                                    <PlanCard
                                        key={p.id}
                                        name={p.name}
                                        priceLabel={`${usd(Number(p.monthly_base_usd))}/mo`}
                                        bullets={packageBullets(p)}
                                        cta={`Choose ${p.name}`}
                                        caption="You'll be redirected to secure checkout."
                                        isCurrent={currentPlanId === p.id}
                                        busy={planBusy === p.id}
                                        disabled={plansLocked}
                                        onChoose={() => selectPlan(p.id, p.name)}
                                    />
                                ))}
                            </div>
                            <Button variant="ghost" onClick={() => setStepOverride(2)} disabled={planBusy != null}>
                                Skip — get a number first
                            </Button>
                        </div>
                    )}

                    {/* Step 2 — Get a number */}
                    {activeStep === 2 && (
                        <div className="space-y-6">
                            <p className="text-sm text-[var(--blanc-ink-2)]">
                                Pick a number to get started — it can be a temporary line while your own numbers move
                                over, or stay on as your main one.
                            </p>
                            <NumberSearch
                                onPurchased={async () => {
                                    setStepOverride(null);
                                    await numbersQ.refetch();
                                }}
                                onViewPlans={() => setStepOverride(1)}
                            />
                        </div>
                    )}

                    {/* Step 3 — Transfer now or make the explicit later decision. */}
                    {activeStep === 3 && (
                        <div className="space-y-6">
                            <div className="space-y-3.5">
                                <p className="text-sm text-[var(--blanc-ink-2)]">
                                    Already have a business number your customers know? Move it into Albusto now — or come
                                    back to this anytime.
                                </p>
                                <div className="flex flex-wrap items-center gap-2">
                                    <Button type="button" onClick={() => setTransferExpanded(true)}>
                                        Transfer now
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        disabled={dismissingTransfer}
                                        onClick={dismissTransferPrompt}
                                    >
                                        {dismissingTransfer && <Loader2 className="size-4 animate-spin" />}
                                        I'll do it later
                                    </Button>
                                </div>
                            </div>
                            {transferExpanded && (
                                <PortInPanel
                                    initialRequests={portInQ.data ?? []}
                                    recommendNewNumber={!hasPurchasedNumber}
                                    onGetNewNumber={() => setStepOverride(2)}
                                    onRequestsChange={handlePortRequestsChange}
                                />
                            )}
                        </div>
                    )}

                    {/* Completion is derived from the number and transfer decisions. */}
                    {activeStep === 4 && (
                        <div style={{ textAlign: 'center', padding: '40px 16px' }}>
                            <div style={{
                                width: 56, height: 56, borderRadius: 28, background: 'rgba(27,139,99,0.12)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px',
                            }}>
                                <CheckCircle2 size={28} style={{ color: 'var(--blanc-success)' }} />
                            </div>
                            <h3 style={{ fontSize: 20, fontWeight: 600, fontFamily: 'var(--blanc-font-heading, Manrope), sans-serif', color: 'var(--blanc-ink-1)', margin: 0 }}>
                                {hasPurchasedNumber ? 'Telephony is connected' : 'Your number transfer is underway'}
                            </h3>
                            <p style={{ fontSize: 14, color: 'var(--blanc-ink-2)', margin: '8px auto 20px', maxWidth: 420 }}>
                                {hasPurchasedNumber
                                    ? 'Your number is active. Incoming calls and texts will appear in Albusto.'
                                    : 'Transfers usually take 2–4 weeks. Watch for Twilio’s email to sign the Letter of Authorization.'}
                            </p>
                            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
                                <Button onClick={() => navigate('/settings/telephony')}>Manage telephony</Button>
                                <Button variant="outline" onClick={() => navigate('/settings/integrations')}>Back to Integrations</Button>
                            </div>
                        </div>
                    )}
                </>
            )}
        </SettingsPageShell>
    );
}
