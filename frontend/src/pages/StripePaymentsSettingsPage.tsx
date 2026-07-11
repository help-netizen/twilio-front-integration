import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import {
    CheckCircle2, AlertCircle, Loader2, Unplug, ExternalLink, RefreshCw,
    CreditCard, Banknote, ShieldCheck, Lock,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import {
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../components/ui/dialog';
import { CloudBanner } from '../components/ui/CloudBanner';
import { SettingsPageShell } from '../components/settings/SettingsPageShell';
import { SettingsSection } from '../components/settings/SettingsSection';
import { stripePaymentsApi, type StripePaymentsStatus, type StripeReadiness } from '../services/stripePaymentsApi';

const STATUS_NEUTRAL = 'bg-[rgba(25,25,25,0.06)] text-[var(--blanc-ink-3)]';
const STATUS_WARNING = 'bg-[rgba(178,106,29,0.12)] text-[var(--blanc-warning)]';
const STATUS_SUCCESS = 'bg-[rgba(27,139,99,0.12)] text-[var(--blanc-success)]';

const READINESS_LABEL: Record<StripeReadiness, { text: string; cls: string }> = {
    not_connected: { text: 'Not connected', cls: STATUS_NEUTRAL },
    onboarding_incomplete: { text: 'Setup incomplete', cls: STATUS_WARNING },
    action_required: { text: 'Action required', cls: STATUS_WARNING },
    payments_disabled: { text: 'Setup incomplete', cls: STATUS_WARNING },
    payouts_disabled: { text: 'Payouts disabled', cls: STATUS_WARNING },
    connected_ready: { text: 'Connected', cls: STATUS_SUCCESS },
    disconnected: { text: 'Disconnected', cls: STATUS_NEUTRAL },
};

function StatusBadge({ readiness }: { readiness: StripeReadiness }) {
    const r = READINESS_LABEL[readiness] || READINESS_LABEL.not_connected;
    return <Badge className={`${r.cls} hover:${r.cls}`}>{r.text}</Badge>;
}

function ReadinessRow({ ok, label, warn }: { ok: boolean; label: string; warn?: boolean }) {
    return (
        <div className="flex items-center gap-2 py-1.5" style={{ color: 'var(--blanc-ink-2)' }}>
            {ok ? <CheckCircle2 className="h-4 w-4 text-[var(--blanc-success)]" />
                : <AlertCircle className={`h-4 w-4 ${warn ? 'text-[var(--blanc-warning)]' : 'text-[var(--blanc-ink-3)]'}`} />}
            <span className="text-sm">{label}</span>
        </div>
    );
}

/** STRIPE-CONNECT-UX-001 §2 S-3: hardcoded Stripe US rates card (no pricing API). */
function CostRow({ label, sub, rate, rateColor }: { label: string; sub?: string; rate: string; rateColor?: string }) {
    return (
        <div className="flex items-start justify-between gap-3 min-w-0">
            <div className="min-w-0">
                <p className="text-sm" style={{ color: 'var(--blanc-ink-1)' }}>{label}</p>
                {sub && <p className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>{sub}</p>}
            </div>
            <span className="text-sm font-medium whitespace-nowrap" style={{ color: rateColor ?? 'var(--blanc-ink-1)' }}>{rate}</span>
        </div>
    );
}

function WhatItCostsCard() {
    return (
        <div style={{ background: 'rgba(25, 25, 25, 0.03)', borderRadius: 16, padding: '20px 22px' }}>
            <h4 className="text-sm font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>What it costs</h4>
            <div className="mt-3.5 space-y-3">
                <CostRow label="Card payment — link or keyed-in" sub="Visa, Mastercard, Amex, Apple Pay, Google Pay" rate="2.9% + 30¢" />
                <CostRow label="Tap to Pay in person" sub="on the technician's phone" rate="2.7% + 5¢ · soon" rateColor="var(--blanc-ink-3)" />
                <CostRow label="Monthly or setup fees" rate="$0" rateColor="var(--blanc-success)" />
                <CostRow label="Payouts to your bank" sub="about 2 business days" rate="Free" rateColor="var(--blanc-success)" />
                <CostRow label="Instant payouts — optional" rate="1.5%" />
                <CostRow label="Albusto fee on top" rate="0%" rateColor="var(--blanc-success)" />
            </div>
            <p className="mt-4 text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                Stripe's standard US rates, charged by Stripe. International cards +1.5%. Full details at stripe.com/pricing.
            </p>
        </div>
    );
}

export default function StripePaymentsSettingsPage() {
    const qc = useQueryClient();
    const [disconnectOpen, setDisconnectOpen] = useState(false);

    const { data, isLoading } = useQuery({
        queryKey: ['stripe-payments-status'],
        queryFn: () => stripePaymentsApi.getStatus().then(r => r.status),
    });
    const status: StripePaymentsStatus | undefined = data;

    const connectMut = useMutation({
        mutationFn: () => stripePaymentsApi.connect(),
        onSuccess: ({ onboarding_url }) => { if (onboarding_url) window.location.href = onboarding_url; },
        onError: (e: Error) => toast.error(e.message),
    });
    const resumeMut = useMutation({
        mutationFn: () => stripePaymentsApi.getOnboardingLink(),
        onSuccess: ({ url }) => { if (url) window.location.href = url; },
        onError: (e: Error) => toast.error(e.message),
    });
    const refreshMut = useMutation({
        mutationFn: () => stripePaymentsApi.refreshStatus(),
        onSuccess: ({ status }) => { qc.setQueryData(['stripe-payments-status'], status); toast.success('Status refreshed'); },
        onError: (e: Error) => toast.error(e.message),
    });
    const disconnectMut = useMutation({
        mutationFn: () => stripePaymentsApi.disconnect(),
        onSuccess: () => { setDisconnectOpen(false); qc.invalidateQueries({ queryKey: ['stripe-payments-status'] }); toast.success('Stripe disconnected'); },
        onError: (e: Error) => toast.error(e.message),
    });

    const readiness = status?.readiness ?? 'not_connected';
    const connected = status?.connected;
    const acct = status?.account;

    return (
        <SettingsPageShell
            backTo="/settings/integrations"
            backLabel="Integrations"
            title="Stripe Payments"
            description="Take card payments on the job, by link, or over the phone"
            actions={
                <>
                    {status?.livemode === false && connected && <Badge variant="outline">Test mode</Badge>}
                    <StatusBadge readiness={readiness} />
                </>
            }
        >
            {isLoading ? (
                <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--blanc-ink-3)' }}>
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
            ) : status?.configured === false ? (
                <SettingsSection>
                    <p className="text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                        Stripe isn't set up for this workspace yet. Once platform keys are added, you can connect your account here.
                    </p>
                </SettingsSection>
            ) : (
                <>
                    {!connected && (
                        /* R3 (STRIPE-CONNECT-UX-001 §2 S-3): cloud hero + «What it costs» */
                        <div className="grid grid-cols-1 md:grid-cols-[1.15fr_.85fr] gap-5">
                            <CloudBanner variant="hero">
                                <p className="blanc-eyebrow">PAYMENTS</p>
                                <h3
                                    className="mt-2 text-2xl sm:text-[28px]"
                                    style={{ fontFamily: 'var(--blanc-font-heading)', fontWeight: 800, color: 'var(--blanc-ink-1)' }}
                                >
                                    Get paid on the spot
                                </h3>
                                <p className="mt-2 text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                                    Charge a card at the job, text a payment link, or key it in over the phone. Money lands in your bank in about 2 business days.
                                </p>
                                <div className="mt-4 space-y-2.5">
                                    <div className="flex items-start gap-2.5">
                                        <CreditCard className="size-4 mt-0.5 shrink-0" style={{ color: 'var(--blanc-accent)' }} />
                                        <p className="text-sm">
                                            <span className="font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>Every way to pay</span>
                                            <span style={{ color: 'var(--blanc-ink-2)' }}> — Card on site, payment link by text or email</span>
                                        </p>
                                    </div>
                                    <div className="flex items-start gap-2.5">
                                        <Banknote className="size-4 mt-0.5 shrink-0" style={{ color: 'var(--blanc-accent)' }} />
                                        <p className="text-sm">
                                            <span className="font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>Fast payouts</span>
                                            <span style={{ color: 'var(--blanc-ink-2)' }}> — Free, to your bank in ~2 business days</span>
                                        </p>
                                    </div>
                                    <div className="flex items-start gap-2.5">
                                        <ShieldCheck className="size-4 mt-0.5 shrink-0" style={{ color: 'var(--blanc-accent)' }} />
                                        <p className="text-sm">
                                            <span className="font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>No monthly fees</span>
                                            <span style={{ color: 'var(--blanc-ink-2)' }}> — Pay only when you get paid</span>
                                        </p>
                                    </div>
                                </div>
                                <div className="mt-4 flex flex-wrap gap-2">
                                    {['2.9% + 30¢ per card payment', '$0 monthly', '0% added by Albusto'].map(chip => (
                                        <span
                                            key={chip}
                                            className="rounded-full border border-[rgba(127,66,225,.2)] bg-white/70 px-3 py-1 text-[13px]"
                                            style={{ color: 'var(--blanc-ink-1)' }}
                                        >
                                            {chip}
                                        </span>
                                    ))}
                                </div>
                                <Button className="mt-5 h-11 px-6" onClick={() => connectMut.mutate()} disabled={connectMut.isPending}>
                                    {connectMut.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Connect Stripe
                                </Button>
                                <p className="mt-2.5 text-[13px]" style={{ color: 'var(--blanc-ink-3)' }}>
                                    Takes about 5 minutes. Have your business details and bank account handy.
                                </p>
                                {/* Approved exception (owner-signed STRIPE-CONNECT-UX-001 mockup): hairline top border + Stripe brand violet #635bff, inside the cloud only. */}
                                <div
                                    className="mt-5 flex items-center gap-2 border-t pt-4 text-[13px]"
                                    style={{ borderColor: 'rgba(127,66,225,.14)', color: 'var(--blanc-ink-2)' }}
                                >
                                    <Lock className="size-3.5 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                                    <span>Powered by <span className="font-bold" style={{ color: '#635bff' }}>Stripe</span> · Card data never touches Albusto</span>
                                </div>
                            </CloudBanner>
                            <WhatItCostsCard />
                        </div>
                    )}

                    {connected && readiness !== 'connected_ready' && (
                        /* R4 (§2 S-4): compact cloud absorbs the old «Resume onboarding» primary */
                        <CloudBanner variant="compact">
                            <p className="text-sm font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>
                                Almost there — finish your Stripe setup
                            </p>
                            <p className="mt-1 text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                                Stripe needs a few more business details before you can take payments.
                            </p>
                            <Button className="mt-3 h-11 px-5" onClick={() => resumeMut.mutate()} disabled={resumeMut.isPending}>
                                {resumeMut.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Finish setup
                            </Button>
                        </CloudBanner>
                    )}

                    <SettingsSection title="Setup steps">
                        {(status?.checklist ?? []).map(item => (
                            <div key={item.key} className="flex items-center justify-between py-1.5">
                                <ReadinessRow ok={item.done} label={item.label} />
                                {item.deferred && <span className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>Coming soon</span>}
                            </div>
                        ))}
                    </SettingsSection>

                    {connected && acct && (
                        <SettingsSection title="Account readiness">
                            <ReadinessRow ok={acct.details_submitted} label="Business details submitted" />
                            <ReadinessRow ok={acct.charges_enabled} label="Card payments enabled" warn={!acct.charges_enabled} />
                            <ReadinessRow ok={acct.payouts_enabled} label="Payouts enabled" warn={!acct.payouts_enabled} />
                            {acct.requirements_past_due.length > 0 && (
                                <p className="mt-2 text-sm text-[var(--blanc-warning)] flex items-start gap-2">
                                    <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                                    Stripe needs more information to keep payments active.
                                </p>
                            )}
                        </SettingsSection>
                    )}

                    {/* Actions — Connect/Resume primaries live in the clouds above; row renders only when connected */}
                    {connected && (
                        <div className="flex flex-wrap items-center gap-2.5">
                            <Button variant="outline" onClick={() => refreshMut.mutate()} disabled={refreshMut.isPending}>
                                <RefreshCw className={`h-4 w-4 mr-2 ${refreshMut.isPending ? 'animate-spin' : ''}`} /> Refresh status
                            </Button>
                            <Button variant="outline" onClick={() => window.open('https://dashboard.stripe.com/', '_blank')}>
                                <ExternalLink className="h-4 w-4 mr-2" /> Open Stripe Dashboard
                            </Button>
                            <Button variant="ghost" onClick={() => setDisconnectOpen(true)}>
                                <Unplug className="h-4 w-4 mr-2" /> Disconnect
                            </Button>
                        </div>
                    )}
                </>
            )}

            <Dialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Disconnect Stripe Payments?</DialogTitle>
                        <DialogDescription>
                            New payment collection will be turned off. Your existing payment history stays intact and remains visible.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDisconnectOpen(false)}>Cancel</Button>
                        <Button variant="destructive" onClick={() => disconnectMut.mutate()} disabled={disconnectMut.isPending}>
                            {disconnectMut.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Disconnect
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </SettingsPageShell>
    );
}
