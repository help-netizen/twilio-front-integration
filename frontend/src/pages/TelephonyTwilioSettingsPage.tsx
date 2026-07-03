/**
 * TelephonyTwilioSettingsPage — ONBTEL-T9 (spec ONBTEL-001 §2.3/§2.4).
 *
 * 3-step "Telephony — Twilio" marketplace setup wizard:
 *   1 Connect → POST /api/telephony/numbers/connect (+ best-effort softphone/setup)
 *   2 Plan    → POST /api/billing/checkout (payg activates in place; packages → Stripe)
 *   3 Number  → GET /api/telephony/numbers/search + POST /api/telephony/numbers/buy
 *
 * The ACTIVE step is DERIVED from server state (refresh/re-entry safe):
 *   done1 = GET /api/telephony/numbers/status → state.connected === true
 *   done2 = GET /api/billing → subscription != null && plan_id !== 'trial'
 *   done3 = GET /api/telephony/numbers → numbers.length ≥ 1
 *           ({ ok, numbers: [], not_connected: true } reads as 0 — NOT an error)
 * ?step= is only a hint — the derived step wins when it is smaller. Completed
 * steps are clickable back (connect/subscribe are idempotent); forward is locked.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
    ArrowLeft, AlertCircle, Check, CheckCircle2, ChevronRight,
    Loader2, MapPin, Phone, Search,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Checkbox } from '../components/ui/checkbox';
import { FloatingField } from '../components/ui/floating-field';
import { authedFetch } from '../services/apiClient';
import type { BillingOverview, Plan } from '../services/billingApi';

const RETURN_PATH = '/settings/integrations/telephony-twilio?step=3&billing=success';

// PAYG card contract (§2.4) — normative copy.
const PAYG_BULLETS = [
    'Calls $0.04 per minute',
    'Texts $0.03 each',
    '1 phone number',
    'Usage is paid from your wallet',
];

const sectionCard = { background: 'rgba(25,25,25,0.03)', borderRadius: 16, padding: '20px 22px' } as const;

interface TelephonyState {
    connected: boolean;
    mode?: string;
    status?: string;
}

interface FoundNumber {
    phone_number: string;
    locality: string | null;
    region: string | null;
    capabilities?: { voice?: boolean; sms?: boolean };
    monthly_price_usd?: number | string | null;
}

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
                <Button className="w-full" disabled={disabled || isCurrent} onClick={onChoose}>
                    {busy && <Loader2 size={14} className="mr-1.5 animate-spin" />}
                    {isCurrent ? 'Current plan' : cta}
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

    // ?step= is only a hint; Math.min against the derived step makes it safe (E-B16).
    const [stepOverride, setStepOverride] = useState<number | null>(() => {
        const hint = Number(searchParams.get('step'));
        return Number.isInteger(hint) && hint >= 1 && hint <= 3 ? hint : null;
    });

    // ── Step derivation queries — the server is the single source of truth ────
    const statusQ = useQuery({
        queryKey: ['telephony-twilio-wizard', 'status'],
        queryFn: async (): Promise<TelephonyState> => {
            const r = await authedFetch('/api/telephony/numbers/status');
            const j = await r.json().catch(() => ({}));
            if (!r.ok) return { connected: false };
            return j.state || { connected: false };
        },
    });
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

    const done1 = statusQ.data?.connected === true;
    const subscription = billingQ.data?.subscription ?? null;
    const done2 = subscription != null && subscription.plan_id !== 'trial';
    const done3 = (numbersQ.data?.length ?? 0) >= 1;
    const derivedStep = !done1 ? 1 : !done2 ? 2 : !done3 ? 3 : 4; // 4 = completion
    const activeStep = stepOverride != null ? Math.min(stepOverride, derivedStep) : derivedStep;
    const bootLoading = statusQ.isLoading || billingQ.isLoading || numbersQ.isLoading;

    // ── Step 2: Stripe return — poll billing until the webhook flips the plan ─
    const awaitingPayment = billingSuccess && !done2;
    const [pollTimedOut, setPollTimedOut] = useState(false);
    const refetchBilling = billingQ.refetch;
    useEffect(() => {
        if (!awaitingPayment) return;
        const iv = setInterval(() => { refetchBilling(); }, 3000);
        const to = setTimeout(() => setPollTimedOut(true), 60000);
        return () => { clearInterval(iv); clearTimeout(to); };
    }, [awaitingPayment, refetchBilling]);

    // ── Step 1: Connect ────────────────────────────────────────────────────────
    const [connecting, setConnecting] = useState(false);
    const [connectError, setConnectError] = useState<string | null>(null);
    const connectTelephony = async () => {
        setConnecting(true);
        setConnectError(null);
        try {
            const r = await authedFetch('/api/telephony/numbers/connect', { method: 'POST' });
            if (!r.ok) {
                setConnectError(r.status === 403
                    ? "You don't have permission to manage telephony — ask your administrator."
                    : 'Could not connect telephony — try again.');
                return;
            }
            // Provision browser-softphone creds in the new subaccount — best-effort,
            // fire-and-forget (mirrors PhoneNumbersPage.connectTelephony).
            authedFetch('/api/telephony/numbers/softphone/setup', { method: 'POST' }).catch(() => {});
            setStepOverride(null);
            await statusQ.refetch();
        } catch {
            setConnectError('Could not connect telephony — try again.');
        } finally {
            setConnecting(false);
        }
    };

    // ── Step 2: Plan ───────────────────────────────────────────────────────────
    const [planBusy, setPlanBusy] = useState<string | null>(null);
    const [planError, setPlanError] = useState<string | null>(null);
    const choosePlan = async (planId: string) => {
        setPlanBusy(planId);
        setPlanError(null);
        try {
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
                return;
            }
            if (j.url) {
                window.location.href = j.url; // Stripe hosted checkout → returns to ?step=3&billing=success
                return;
            }
            if (j.activated) {
                toast.success('Plan activated');
                setStepOverride(null);
                await refetchBilling();
            }
        } catch {
            toast.error('Could not change plan');
        } finally {
            setPlanBusy(null);
        }
    };

    // ── Step 3: Number ─────────────────────────────────────────────────────────
    const [areaCode, setAreaCode] = useState('');
    const [city, setCity] = useState('');
    const [containsDigits, setContainsDigits] = useState('');
    const [tollFree, setTollFree] = useState(false);
    const [searching, setSearching] = useState(false);
    const [searched, setSearched] = useState(false);
    const [results, setResults] = useState<FoundNumber[]>([]);
    const [buying, setBuying] = useState<string | null>(null);
    const [limitUpsell, setLimitUpsell] = useState<string | null>(null); // 422 NUMBER_LIMIT server text

    const runSearch = async () => {
        setSearching(true);
        try {
            const qs = new URLSearchParams();
            if (areaCode.trim()) qs.set('area_code', areaCode.trim());
            if (containsDigits.trim()) qs.set('contains', containsDigits.trim());
            if (city.trim()) qs.set('locality', city.trim());
            if (tollFree) qs.set('toll_free', 'true');
            const r = await authedFetch(`/api/telephony/numbers/search?${qs}`);
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || 'Number search failed');
            setResults(j.results || []);
            setSearched(true);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Number search failed');
        } finally {
            setSearching(false);
        }
    };

    const buyNumber = async (phone: string) => {
        setBuying(phone);
        try {
            const r = await authedFetch('/api/telephony/numbers/buy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone_number: phone }),
            });
            const j = await r.json().catch(() => ({}));
            if (r.ok) {
                setLimitUpsell(null);
                setStepOverride(null);
                await numbersQ.refetch(); // done3 flips → Completion
                return;
            }
            if (r.status === 422 && j.code === 'NUMBER_LIMIT') {
                // Mandatory upsell: the server message verbatim + switch-plan CTA (E-B8).
                setLimitUpsell(j.error || 'Your plan does not include more phone numbers.');
                return;
            }
            if (r.status === 409) {
                toast.error(j.error || 'This number was just taken — pick another one');
                await runSearch(); // refresh the availability list
                return;
            }
            toast.error('Failed to buy the number');
        } catch {
            toast.error('Failed to buy the number');
        } finally {
            setBuying(null);
        }
    };

    const priceFor = (f: FoundNumber) =>
        `$${Number(f.monthly_price_usd ?? (tollFree ? 2.15 : 1.15)).toFixed(2)}/mo`;

    const plans = billingQ.data?.plans ?? [];
    const packagePlans: Plan[] = plans.filter(p => p.id !== 'trial' && p.id !== 'payg');
    const currentPlanId = subscription?.plan_id ?? null;
    const plansLocked = (awaitingPayment && !pollTimedOut) || planBusy != null;

    const stepsMeta = [
        { n: 1, label: 'Connect', done: done1 },
        { n: 2, label: 'Choose your plan', done: done2 },
        { n: 3, label: 'Get a number', done: done3 },
    ];

    return (
        <div className="max-w-4xl px-6 py-8" style={{ color: 'var(--blanc-ink-1)' }}>
            <Button variant="ghost" onClick={() => navigate('/settings/integrations')} className="mb-6 h-auto px-0 hover:bg-transparent">
                <ArrowLeft className="h-4 w-4" /> Integrations
            </Button>

            {/* Header */}
            <div className="flex items-center gap-3 mb-8">
                <div className="flex items-center justify-center h-11 w-11 rounded-xl" style={{ background: '#f22f46', flexShrink: 0 }}>
                    <Phone className="h-5 w-5 text-white" />
                </div>
                <div>
                    <h2 className="text-2xl font-semibold" style={{ fontFamily: 'var(--blanc-font-heading, inherit)' }}>
                        Telephony — Twilio
                    </h2>
                    <p className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>
                        Connect your business phone: create a workspace, choose a plan, and get a number.
                    </p>
                </div>
            </div>

            {bootLoading ? (
                <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--blanc-ink-3)' }}>
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
            ) : (
                <>
                    {/* Stepper: completed → check + clickable BACK; forward of active → locked */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 26 }}>
                        {stepsMeta.map((s, i) => {
                            const isActive = s.n === activeStep;
                            const clickable = s.done && s.n < activeStep;
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
                                        <span style={{
                                            fontSize: 13.5,
                                            fontWeight: isActive ? 600 : 500,
                                            color: isActive ? 'var(--blanc-ink-1)' : s.done ? 'var(--blanc-ink-2)' : 'var(--blanc-ink-3)',
                                        }}>
                                            {s.label}
                                        </span>
                                    </button>
                                </div>
                            );
                        })}
                    </div>

                    {/* Step 1 — Connect */}
                    {activeStep === 1 && (
                        <div style={sectionCard}>
                            <p style={{ fontSize: 14, color: 'var(--blanc-ink-2)', margin: '0 0 16px', lineHeight: 1.55, maxWidth: 560 }}>
                                Albusto will create a dedicated Twilio workspace (subaccount) for your company.
                                Your numbers, calls and texts stay isolated.
                            </p>
                            {connectError && (
                                <div style={{ marginBottom: 12 }}>
                                    <InlineError text={connectError} />
                                </div>
                            )}
                            <Button onClick={connectTelephony} disabled={connecting}>
                                {connecting && <Loader2 size={14} className="mr-1.5 animate-spin" />}
                                Connect telephony
                            </Button>
                        </div>
                    )}

                    {/* Step 2 — Choose your plan */}
                    {activeStep === 2 && (
                        <>
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
                            {planError && (
                                <div style={{ marginBottom: 14 }}>
                                    <InlineError text={planError} />
                                </div>
                            )}
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
                                <PlanCard
                                    name="Pay as you go"
                                    priceLabel="$0/mo"
                                    bullets={PAYG_BULLETS}
                                    cta="Choose Pay as you go"
                                    isCurrent={currentPlanId === 'payg'}
                                    busy={planBusy === 'payg'}
                                    disabled={plansLocked}
                                    onChoose={() => choosePlan('payg')}
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
                                        onChoose={() => choosePlan(p.id)}
                                    />
                                ))}
                            </div>
                        </>
                    )}

                    {/* Step 3 — Get a number */}
                    {activeStep === 3 && (
                        <>
                            {limitUpsell && (
                                <div style={{
                                    border: '1px solid rgba(178,106,29,0.4)', background: 'rgba(178,106,29,0.06)',
                                    borderRadius: 16, padding: '14px 16px', marginBottom: 16,
                                }}>
                                    <div style={{ fontSize: 13.5, color: 'var(--blanc-ink-1)' }}>{limitUpsell}</div>
                                    <div style={{ fontSize: 13, color: 'var(--blanc-ink-2)', marginTop: 4 }}>
                                        Need more numbers? Switch to a package plan.
                                    </div>
                                    <Button size="sm" style={{ marginTop: 10 }} onClick={() => { setLimitUpsell(null); setStepOverride(2); }}>
                                        View plans
                                    </Button>
                                </div>
                            )}
                            <div style={sectionCard}>
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
                                    <FloatingField
                                        label="Area code"
                                        value={areaCode}
                                        inputMode="numeric"
                                        onChange={e => setAreaCode(e.target.value.replace(/\D/g, '').slice(0, 3))}
                                    />
                                    <FloatingField
                                        label="City"
                                        value={city}
                                        onChange={e => setCity(e.target.value)}
                                    />
                                    <FloatingField
                                        label="Contains digits"
                                        value={containsDigits}
                                        onChange={e => setContainsDigits(e.target.value)}
                                    />
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 14, flexWrap: 'wrap' }}>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, color: 'var(--blanc-ink-1)', cursor: 'pointer' }}>
                                        <Checkbox checked={tollFree} onCheckedChange={c => setTollFree(c === true)} />
                                        Toll-free
                                    </label>
                                    <Button onClick={runSearch} disabled={searching}>
                                        {searching
                                            ? <Loader2 size={14} className="mr-1.5 animate-spin" />
                                            : <Search size={14} className="mr-1.5" />}
                                        Search
                                    </Button>
                                </div>
                            </div>
                            {searched && !searching && results.length === 0 && (
                                <p style={{ fontSize: 13.5, color: 'var(--blanc-ink-3)', margin: '18px 2px 0' }}>
                                    No numbers found — try another area code or city.
                                </p>
                            )}
                            {results.length > 0 && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
                                    {results.map(f => (
                                        <div key={f.phone_number} style={{
                                            border: '1px solid var(--blanc-line)', borderRadius: 12,
                                            background: 'var(--blanc-surface-strong, #fffdf9)',
                                            padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                                        }}>
                                            <div style={{ flex: '1 1 200px', minWidth: 200 }}>
                                                <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--blanc-ink-1)' }}>{f.phone_number}</div>
                                                <div style={{ fontSize: 12, color: 'var(--blanc-ink-2)', display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, flexWrap: 'wrap' }}>
                                                    <MapPin size={11} style={{ color: 'var(--blanc-ink-3)', flexShrink: 0 }} />
                                                    <span>{[f.locality, f.region].filter(Boolean).join(', ') || 'US'}</span>
                                                    {f.capabilities?.voice && <Badge variant="outline" style={{ fontSize: 10 }}>Voice</Badge>}
                                                    {f.capabilities?.sms && <Badge variant="outline" style={{ fontSize: 10 }}>SMS</Badge>}
                                                </div>
                                            </div>
                                            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--blanc-ink-2)' }}>{priceFor(f)}</span>
                                            <Button size="sm" onClick={() => buyNumber(f.phone_number)} disabled={buying != null}>
                                                {buying === f.phone_number && <Loader2 size={13} className="mr-1.5 animate-spin" />}
                                                Buy
                                            </Button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </>
                    )}

                    {/* Completion — all three steps derived-done */}
                    {activeStep === 4 && (
                        <div style={{ textAlign: 'center', padding: '40px 16px' }}>
                            <div style={{
                                width: 56, height: 56, borderRadius: 28, background: 'rgba(27,139,99,0.12)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px',
                            }}>
                                <CheckCircle2 size={28} style={{ color: 'var(--blanc-success)' }} />
                            </div>
                            <h3 style={{ fontSize: 20, fontWeight: 600, fontFamily: 'var(--blanc-font-heading, Manrope), sans-serif', color: 'var(--blanc-ink-1)', margin: 0 }}>
                                Telephony is connected
                            </h3>
                            <p style={{ fontSize: 14, color: 'var(--blanc-ink-2)', margin: '8px auto 20px', maxWidth: 420 }}>
                                Your number is active. Incoming calls and texts will appear in Albusto.
                            </p>
                            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
                                <Button onClick={() => navigate('/settings/telephony')}>Manage telephony</Button>
                                <Button variant="outline" onClick={() => navigate('/settings/integrations')}>Back to Integrations</Button>
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
