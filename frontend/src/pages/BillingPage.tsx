/**
 * BillingPage.tsx — BILLING-UI. Subscription & billing cabinet for the company
 * owner (tenant.company.manage). Blanc design system, money-first:
 * what do I pay, what's my next bill, how much have I used, how do I change.
 * No technical IDs (customer_id / subscription_id) surface here.
 */
import { useEffect, useState } from 'react';
import { Loader2, Check, ExternalLink, CreditCard, AlertTriangle, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { billingApi, type BillingOverview, type Plan, type WalletInfo } from '../services/billingApi';

const METRIC_LABELS: Record<string, string> = {
    sms: 'Text messages',
    call_minutes: 'Call minutes',
    agent_runs: 'Automations run',
};
const METRIC_ORDER = ['sms', 'call_minutes', 'agent_runs'];

const STATUS_LABEL: Record<string, string> = {
    trialing: 'Trial', active: 'Active', past_due: 'Payment due',
    canceled: 'Canceled', unpaid: 'Unpaid', incomplete: 'Setup incomplete',
};
type Tone = 'ok' | 'info' | 'danger' | 'warn' | 'muted';
const STATUS_TONE: Record<string, Tone> = {
    active: 'ok', trialing: 'info', past_due: 'danger', unpaid: 'danger',
    canceled: 'muted', incomplete: 'warn',
};
function toneStyle(tone: Tone): React.CSSProperties {
    switch (tone) {
        case 'ok': return { background: 'rgba(27,139,99,0.12)', color: 'var(--blanc-success)' };
        case 'info': return { background: 'rgba(47,99,216,0.12)', color: 'var(--blanc-info)' };
        case 'danger': return { background: 'rgba(212,77,60,0.12)', color: 'var(--blanc-danger)' };
        case 'warn': return { background: 'rgba(178,106,29,0.12)', color: 'var(--blanc-warning)' };
        default: return { background: 'rgba(117,106,89,0.10)', color: 'var(--blanc-ink-2)' };
    }
}

function fmtDate(iso: string | null): string {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function daysLeft(iso: string | null): number | null {
    if (!iso) return null;
    return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000));
}
function usd(n: number, cents = false): string {
    return '$' + Number(n).toLocaleString(undefined, cents
        ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
        : { maximumFractionDigits: 0 });
}
function usageBarColor(pct: number): string {
    if (pct > 100) return 'var(--blanc-danger)';
    if (pct >= 80) return 'var(--blanc-warning)';
    return 'var(--blanc-success)';
}
function overageFor(plan: Plan | undefined, metric: string, used: number): number {
    if (!plan) return 0;
    const cap = Number(plan.included_units?.[metric] || 0);
    const rate = Number(plan.metered?.[metric] || 0);
    if (cap <= 0 || rate <= 0 || used <= cap) return 0;
    return (used - cap) * rate;
}

const CARD_BG = 'rgba(117,106,89,0.05)';
const KPI: React.CSSProperties = { background: CARD_BG, borderRadius: 16, padding: '14px 16px' };

export default function BillingPage() {
    const [data, setData] = useState<BillingOverview | null>(null);
    const [wallet, setWallet] = useState<WalletInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState<string | null>(null);

    useEffect(() => {
        Promise.all([billingApi.overview(), billingApi.wallet().catch(() => null)])
            .then(([ov, w]) => { setData(ov); setWallet(w); })
            .catch((e: any) => toast.error(e.message || 'Failed to load billing'))
            .finally(() => setLoading(false));
    }, []);

    const checkout = async (planId: string) => {
        setBusy(planId);
        try {
            const out = await billingApi.checkout(planId);
            if (out.url) { window.location.href = out.url; return; }
            toast.success('Plan activated');
            window.location.reload();
        } catch (e: any) {
            toast.error(e.code === 'PROVIDER_NOT_CONFIGURED' ? 'Billing is not enabled yet.' : (e.message || 'Could not change plan'));
            setBusy(null);
        }
    };

    const topUp = async (amount: number) => {
        setBusy('topup');
        try {
            const { url } = await billingApi.topup(amount);
            if (url) window.location.href = url;
            else setBusy(null);
        } catch (e: any) {
            toast.error(e.code === 'PROVIDER_NOT_CONFIGURED' ? 'Billing is not enabled yet.' : (e.message || 'Could not start top-up'));
            setBusy(null);
        }
    };

    const openPortal = async () => {
        setBusy('portal');
        try {
            const { url } = await billingApi.portal();
            window.location.href = url;
        } catch (e: any) {
            toast.error(
                e.code === 'NO_CUSTOMER' ? 'Choose a plan first to set up payment.'
                    : e.code === 'PROVIDER_NOT_CONFIGURED' ? 'Billing is not enabled yet.'
                        : (e.message || 'Could not open billing portal'),
            );
            setBusy(null);
        }
    };

    if (loading) {
        return <div style={{ padding: 48, textAlign: 'center', color: 'var(--blanc-ink-3)' }}><Loader2 className="animate-spin" /></div>;
    }
    if (!data) return null;

    const { subscription, usage, plans, invoices, billing_enabled } = data;
    const currentPlanId = subscription?.plan_id || 'trial';
    const currentPlan = plans.find(p => p.id === currentPlanId);
    const status = subscription?.status || 'trialing';
    const isTrial = status === 'trialing';
    const needsPayment = status === 'past_due' || status === 'unpaid';
    const trialDays = daysLeft(subscription?.trial_ends_at || null);
    const renews = subscription?.current_period_end || subscription?.trial_ends_at || null;
    const monthlyBase = Number(currentPlan?.monthly_base_usd || 0);

    const overageTotal = METRIC_ORDER.reduce((sum, m) => sum + overageFor(currentPlan, m, Number(usage[m] || 0)), 0);
    const nextBill = monthlyBase + overageTotal;

    const now = new Date();
    const periodResets = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const tone = STATUS_TONE[status] || 'muted';

    return (
        <div style={{ padding: '28px 24px', maxWidth: 1120, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 26 }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
                <div>
                    <div className="blanc-eyebrow">Billing</div>
                    <h1 style={{ fontSize: 26, fontWeight: 600, margin: '4px 0 0', fontFamily: 'var(--blanc-font-heading, Manrope), sans-serif', color: 'var(--blanc-ink-1)' }}>
                        {currentPlan?.name || STATUS_LABEL[status]}{!isTrial && currentPlan ? ' plan' : ''}
                    </h1>
                </div>
                <span style={{ fontSize: 12, fontWeight: 600, padding: '4px 12px', borderRadius: 999, ...toneStyle(tone) }}>
                    {STATUS_LABEL[status] || status}
                </span>
            </div>

            {/* Wallet */}
            {wallet && (
                <div style={{ background: 'var(--blanc-surface-strong, #fffdf9)', border: `1px solid ${wallet.blocked ? 'rgba(212,77,60,0.5)' : 'var(--blanc-line)'}`, borderRadius: 18, padding: 18 }}>
                    {wallet.blocked && (
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--blanc-danger)', fontSize: 13, marginBottom: 14, background: 'rgba(212,77,60,0.10)', borderRadius: 12, padding: '10px 12px' }}>
                            <AlertTriangle size={15} /> Calls and texts are paused — your balance is below {usd(wallet.grace_floor_usd)}. Top up to resume service.
                        </div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
                        <div>
                            <div className="blanc-eyebrow">Wallet balance</div>
                            <div style={{ fontSize: 30, fontWeight: 600, fontFamily: 'var(--blanc-font-heading, Manrope), sans-serif', color: wallet.balance_usd < 0 ? 'var(--blanc-danger)' : 'var(--blanc-ink-1)' }}>{usd(wallet.balance_usd, true)}</div>
                            <div style={{ fontSize: 12, color: 'var(--blanc-ink-3)', marginTop: 2 }}>
                                {wallet.auto_recharge.enabled
                                    ? `Auto top-up ${usd(wallet.auto_recharge.amount_usd)} when below ${usd(wallet.auto_recharge.threshold_usd)}`
                                    : 'Auto top-up off'}
                                {wallet.has_card ? '' : ' · no card on file'}
                            </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 12, color: 'var(--blanc-ink-3)' }}>Add funds</span>
                            {[10, 25, 50, 100].map(a => (
                                <Button key={a} size="sm" variant={a === 25 ? 'default' : 'outline'} disabled={busy === 'topup' || !billing_enabled} onClick={() => topUp(a)}>
                                    {busy === 'topup' && a === 25 ? <Loader2 size={14} className="animate-spin" /> : <CreditCard size={14} />} {usd(a)}
                                </Button>
                            ))}
                        </div>
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 13, color: 'var(--blanc-ink-2)', cursor: 'pointer' }}>
                        <input type="checkbox" checked={wallet.auto_recharge.enabled}
                            onChange={async e => {
                                const enabled = e.target.checked;
                                setWallet({ ...wallet, auto_recharge: { ...wallet.auto_recharge, enabled } });
                                await billingApi.setAutoRecharge({ enabled }).catch(() => toast.error('Could not update auto-recharge'));
                            }} />
                        Auto-recharge from my saved card when the balance runs low
                    </label>
                </div>
            )}

            {/* Money-first KPIs */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                <div style={KPI}>
                    <div style={{ fontSize: 12, color: 'var(--blanc-ink-2)' }}>Monthly cost</div>
                    <div style={{ fontSize: 23, fontWeight: 600, fontFamily: 'var(--blanc-font-heading, Manrope), sans-serif', color: 'var(--blanc-ink-1)' }}>
                        {monthlyBase > 0 ? usd(monthlyBase) : 'Free'}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--blanc-ink-3)' }}>{monthlyBase > 0 ? 'per month' : isTrial ? 'during trial' : ' '}</div>
                </div>

                <div style={KPI}>
                    <div style={{ fontSize: 12, color: 'var(--blanc-ink-2)' }}>{isTrial ? 'Trial' : 'Next bill'}</div>
                    {isTrial ? (
                        <>
                            <div style={{ fontSize: 23, fontWeight: 600, fontFamily: 'var(--blanc-font-heading, Manrope), sans-serif', color: 'var(--blanc-ink-1)' }}>
                                {trialDays != null ? `${trialDays} day${trialDays === 1 ? '' : 's'}` : '—'}
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--blanc-ink-3)' }}>{renews ? `free until ${fmtDate(renews)}` : 'left'}</div>
                        </>
                    ) : (
                        <>
                            <div style={{ fontSize: 23, fontWeight: 600, fontFamily: 'var(--blanc-font-heading, Manrope), sans-serif', color: 'var(--blanc-ink-1)' }}>{usd(nextBill)}</div>
                            <div style={{ fontSize: 12, color: 'var(--blanc-ink-3)' }}>
                                {renews ? fmtDate(renews) : 'next cycle'}{overageTotal > 0 ? ` · incl. ${usd(overageTotal)} overage` : ''}
                            </div>
                        </>
                    )}
                </div>

                <div style={{ ...KPI, ...(needsPayment ? { background: 'rgba(212,77,60,0.10)' } : {}) }}>
                    <div style={{ fontSize: 12, color: needsPayment ? 'var(--blanc-danger)' : 'var(--blanc-ink-2)', display: 'flex', alignItems: 'center', gap: 5 }}>
                        {needsPayment && <AlertTriangle size={13} />} Payment method
                    </div>
                    <div style={{ fontSize: 14, color: 'var(--blanc-ink-2)', margin: '5px 0 9px' }}>
                        {needsPayment ? 'Update your card to keep service active.' : 'Card, plan changes, and receipts.'}
                    </div>
                    <Button
                        size="sm"
                        variant={needsPayment ? 'default' : 'outline'}
                        disabled={busy === 'portal' || !billing_enabled}
                        onClick={openPortal}
                    >
                        <CreditCard size={14} /> {needsPayment ? 'Update payment method' : 'Manage'}
                    </Button>
                </div>
            </div>

            {/* Usage */}
            <section>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10, gap: 12, flexWrap: 'wrap' }}>
                    <div className="blanc-eyebrow">This month's usage</div>
                    <div style={{ fontSize: 12, color: 'var(--blanc-ink-3)' }}>resets {fmtDate(periodResets.toISOString())}</div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                    {METRIC_ORDER.map(metric => {
                        const used = Number(usage[metric] || 0);
                        const cap = Number(currentPlan?.included_units?.[metric] || 0);
                        const pct = cap > 0 ? (used / cap) * 100 : 0;
                        const overUnits = cap > 0 ? Math.max(0, used - cap) : 0;
                        const overCost = overageFor(currentPlan, metric, used);
                        const over = overUnits > 0;
                        return (
                            <div key={metric} style={{
                                background: 'var(--blanc-surface-strong, #fffdf9)',
                                border: `1px solid ${over ? 'rgba(212,77,60,0.4)' : 'var(--blanc-line)'}`,
                                borderRadius: 16, padding: 16,
                            }}>
                                <div style={{ fontSize: 13, color: 'var(--blanc-ink-2)' }}>{METRIC_LABELS[metric] || metric}</div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 3 }}>
                                    <span style={{ fontSize: 18, fontWeight: 500, color: over ? 'var(--blanc-danger)' : 'var(--blanc-ink-1)' }}>{used.toLocaleString()}</span>
                                    {cap > 0 && <span style={{ fontSize: 12, color: 'var(--blanc-ink-3)' }}>/ {cap.toLocaleString()}</span>}
                                </div>
                                <div style={{ height: 7, borderRadius: 999, background: 'rgba(117,106,89,0.12)', overflow: 'hidden', marginTop: 8 }}>
                                    <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: usageBarColor(pct), borderRadius: 999, transition: 'width .3s' }} />
                                </div>
                                {over && (
                                    <div style={{ fontSize: 12, color: 'var(--blanc-danger)', marginTop: 7, display: 'flex', alignItems: 'center', gap: 5 }}>
                                        <AlertTriangle size={12} />+{overUnits.toLocaleString()}{overCost > 0 ? ` · projected ${usd(overCost)} overage` : ''}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </section>

            {/* Plans */}
            <section>
                <div className="blanc-eyebrow" style={{ marginBottom: 10 }}>{isTrial ? 'Choose a plan' : 'Change plan'}</div>
                {!billing_enabled && (
                    <p style={{ fontSize: 13, color: 'var(--blanc-ink-3)', margin: '0 0 12px' }}>
                        Online payments aren't enabled yet — <a href="mailto:support@albusto.com" style={{ color: 'var(--blanc-ink-2)' }}>contact us</a> to change plans.
                    </p>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
                    {plans.filter(p => p.id !== 'trial').map(plan => {
                        const isCurrent = plan.id === currentPlanId;
                        const base = Number(plan.monthly_base_usd);
                        const isUpgrade = base > monthlyBase;
                        const cta = isCurrent ? 'Current plan' : isUpgrade ? 'Upgrade' : `Switch to ${plan.name}`;
                        return (
                            <div key={plan.id} style={{
                                border: `${isCurrent ? 2 : 1}px solid ${isCurrent ? 'var(--blanc-info)' : 'var(--blanc-line)'}`,
                                borderRadius: 16, padding: 18, background: 'var(--blanc-surface-strong, #fffdf9)',
                                display: 'flex', flexDirection: 'column', gap: 12,
                            }}>
                                <div>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                                        <span style={{ fontSize: 17, fontWeight: 600, color: 'var(--blanc-ink-1)', fontFamily: 'var(--blanc-font-heading, Manrope), sans-serif' }}>{plan.name}</span>
                                        {isCurrent && <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 999, ...toneStyle('info') }}>Current</span>}
                                    </div>
                                    <div style={{ fontSize: 22, fontWeight: 600, marginTop: 2, fontFamily: 'var(--blanc-font-heading, Manrope), sans-serif', color: 'var(--blanc-ink-1)' }}>
                                        {usd(base)}<span style={{ fontSize: 13, fontWeight: 500, color: 'var(--blanc-ink-3)' }}>/mo</span>
                                    </div>
                                </div>
                                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                                    {plan.max_phone_numbers != null && (
                                        <li style={{ display: 'flex', gap: 7, fontSize: 13, color: 'var(--blanc-ink-2)' }}>
                                            <Check size={15} style={{ color: 'var(--blanc-success)', flexShrink: 0, marginTop: 1 }} />
                                            Up to {plan.max_phone_numbers} phone number{plan.max_phone_numbers === 1 ? '' : 's'}
                                        </li>
                                    )}
                                    {METRIC_ORDER.map(m => plan.included_units?.[m] != null && (
                                        <li key={m} style={{ display: 'flex', gap: 7, fontSize: 13, color: 'var(--blanc-ink-2)' }}>
                                            <Check size={15} style={{ color: 'var(--blanc-success)', flexShrink: 0, marginTop: 1 }} />
                                            {Number(plan.included_units[m]).toLocaleString()} {METRIC_LABELS[m]?.toLowerCase()}
                                        </li>
                                    ))}
                                </ul>
                                <div style={{ marginTop: 'auto' }}>
                                    <Button
                                        className="w-full"
                                        variant={isCurrent ? 'secondary' : isUpgrade ? 'default' : 'outline'}
                                        disabled={isCurrent || !billing_enabled || busy === plan.id}
                                        onClick={() => checkout(plan.id)}
                                    >
                                        {!isCurrent && (isUpgrade ? <ArrowUpRight size={15} /> : <ArrowDownRight size={15} />)}
                                        {busy === plan.id ? 'Redirecting…' : cta}
                                    </Button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </section>

            {/* Billing history */}
            <section>
                <div className="blanc-eyebrow" style={{ marginBottom: 10 }}>Billing history</div>
                {invoices.length === 0 ? (
                    <p style={{ fontSize: 13.5, color: 'var(--blanc-ink-3)', margin: 0 }}>No charges yet.</p>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                        {invoices.map((inv, i) => {
                            const paid = inv.status === 'paid';
                            return (
                                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto 72px', alignItems: 'center', gap: 12, padding: '11px 2px' }}>
                                    <span style={{ fontSize: 13.5, color: 'var(--blanc-ink-1)' }}>{fmtDate(inv.date)}</span>
                                    <span style={{ fontSize: 12, fontWeight: 600, padding: '3px 10px', borderRadius: 999, textTransform: 'capitalize', ...toneStyle(paid ? 'ok' : 'muted') }}>{inv.status || 'pending'}</span>
                                    <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--blanc-ink-1)' }}>{usd(inv.amount, true)}</span>
                                    {inv.hosted_url ? (
                                        <a href={inv.hosted_url} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5, color: 'var(--blanc-ink-2)', textDecoration: 'none', justifySelf: 'end' }}>
                                            View <ExternalLink size={12} />
                                        </a>
                                    ) : <span />}
                                </div>
                            );
                        })}
                    </div>
                )}
            </section>

            {/* Wallet activity */}
            {wallet && wallet.ledger.length > 0 && (
                <section>
                    <div className="blanc-eyebrow" style={{ marginBottom: 10 }}>Wallet activity</div>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                        {wallet.ledger.slice(0, 12).map((e, i) => (
                            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 12, alignItems: 'center', padding: '10px 2px' }}>
                                <span style={{ fontSize: 13, color: 'var(--blanc-ink-1)' }}>{e.description || e.type}</span>
                                <span style={{ fontSize: 13, fontWeight: 600, color: e.amount_usd >= 0 ? 'var(--blanc-success)' : 'var(--blanc-ink-1)' }}>
                                    {e.amount_usd >= 0 ? '+' : ''}{usd(e.amount_usd, true)}
                                </span>
                                <span style={{ fontSize: 12, color: 'var(--blanc-ink-3)', justifySelf: 'end' }}>{usd(e.balance_after, true)}</span>
                            </div>
                        ))}
                    </div>
                </section>
            )}
        </div>
    );
}
