/**
 * BillingPage.tsx — BILLING-UI. Subscription & billing cabinet for the
 * company owner (tenant.company.manage). UX-first, Blanc design system:
 * what plan am I on, how much is left, how do I upgrade, where are my invoices.
 * No technical IDs (customer_id / subscription_id) surface here.
 */
import { useEffect, useState } from 'react';
import { Loader2, Check, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { billingApi, type BillingOverview } from '../services/billingApi';

// Friendly, decision-useful labels for the metered metrics.
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

function fmtDate(iso: string | null): string {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function daysLeft(iso: string | null): number | null {
    if (!iso) return null;
    return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000));
}
function barColor(pct: number): string {
    if (pct > 100) return '#dc2626';
    if (pct >= 80) return '#d97706';
    return '#16a34a';
}

export default function BillingPage() {
    const [data, setData] = useState<BillingOverview | null>(null);
    const [loading, setLoading] = useState(true);
    const [upgrading, setUpgrading] = useState<string | null>(null);

    useEffect(() => {
        billingApi.overview()
            .then(setData)
            .catch((e: any) => toast.error(e.message || 'Failed to load billing'))
            .finally(() => setLoading(false));
    }, []);

    const upgrade = async (planId: string) => {
        setUpgrading(planId);
        try {
            const { url } = await billingApi.checkout(planId);
            window.location.href = url;
        } catch (e: any) {
            toast.error(e.code === 'PROVIDER_NOT_CONFIGURED' ? 'Billing is not enabled yet.' : (e.message || 'Could not start checkout'));
            setUpgrading(null);
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
    const trialDays = daysLeft(subscription?.trial_ends_at || null);
    const renews = subscription?.current_period_end || subscription?.trial_ends_at || null;

    return (
        <div style={{ padding: '28px 24px', maxWidth: 880, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 28 }}>
            <div>
                <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, fontFamily: 'var(--blanc-font-heading, Manrope), sans-serif' }}>Subscription</h1>
            </div>

            {/* Status */}
            <section>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 22, fontWeight: 700, color: 'var(--blanc-ink-1)' }}>
                        {currentPlan?.name || STATUS_LABEL[status]} plan
                    </span>
                    <span style={{
                        fontSize: 12, fontWeight: 600, padding: '2px 10px', borderRadius: 999,
                        background: status === 'past_due' || status === 'unpaid' ? '#fef2f2' : 'rgba(117,106,89,0.08)',
                        color: status === 'past_due' || status === 'unpaid' ? '#dc2626' : 'var(--blanc-ink-2)',
                    }}>{STATUS_LABEL[status] || status}</span>
                </div>
                <p style={{ margin: '6px 0 0', fontSize: 14, color: 'var(--blanc-ink-2)' }}>
                    {isTrial && trialDays !== null
                        ? <>Free trial — <strong>{trialDays} day{trialDays === 1 ? '' : 's'} left</strong>. Free until {fmtDate(renews)}.</>
                        : renews ? <>Renews {fmtDate(renews)}.</> : null}
                </p>
            </section>

            {/* Usage */}
            <section>
                <div className="blanc-eyebrow" style={{ marginBottom: 12 }}>This month's usage</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {METRIC_ORDER.map(metric => {
                        const used = Number(usage[metric] || 0);
                        const cap = Number(currentPlan?.included_units?.[metric] || 0);
                        const pct = cap > 0 ? (used / cap) * 100 : 0;
                        const over = cap > 0 && used > cap;
                        return (
                            <div key={metric}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5, marginBottom: 6 }}>
                                    <span style={{ color: 'var(--blanc-ink-1)' }}>{METRIC_LABELS[metric] || metric}</span>
                                    <span style={{ color: over ? '#dc2626' : 'var(--blanc-ink-2)' }}>
                                        {used.toLocaleString()}{cap > 0 && <span style={{ color: 'var(--blanc-ink-3)' }}> / {cap.toLocaleString()}</span>}
                                    </span>
                                </div>
                                <div style={{ height: 8, borderRadius: 999, background: 'rgba(117,106,89,0.1)', overflow: 'hidden' }}>
                                    <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: barColor(pct), borderRadius: 999, transition: 'width .3s' }} />
                                </div>
                            </div>
                        );
                    })}
                </div>
            </section>

            {/* Plans */}
            <section>
                <div className="blanc-eyebrow" style={{ marginBottom: 12 }}>{isTrial ? 'Choose a plan' : 'Change plan'}</div>
                {!billing_enabled && (
                    <p style={{ fontSize: 13, color: 'var(--blanc-ink-3)', margin: '0 0 12px' }}>Online payments aren't enabled yet — contact us to upgrade.</p>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
                    {plans.filter(p => p.id !== 'trial').map(plan => {
                        const isCurrent = plan.id === currentPlanId;
                        const popular = plan.id === 'pro';
                        return (
                            <div key={plan.id} style={{
                                border: `1px solid ${popular ? 'rgba(117,106,89,0.4)' : 'var(--blanc-line)'}`,
                                borderRadius: 16, padding: 18, background: 'var(--blanc-surface-strong, #fffdf9)',
                                display: 'flex', flexDirection: 'column', gap: 12, position: 'relative',
                            }}>
                                {popular && <span style={{ position: 'absolute', top: -10, right: 14, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', background: 'var(--blanc-ink-1, #3c362c)', color: '#fff', padding: '3px 9px', borderRadius: 999 }}>Most popular</span>}
                                <div>
                                    <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--blanc-ink-1)' }}>{plan.name}</div>
                                    <div style={{ fontSize: 22, fontWeight: 700, marginTop: 2 }}>
                                        ${Number(plan.monthly_base_usd).toLocaleString()}<span style={{ fontSize: 13, fontWeight: 500, color: 'var(--blanc-ink-3)' }}>/mo</span>
                                    </div>
                                </div>
                                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                                    {METRIC_ORDER.map(m => plan.included_units?.[m] != null && (
                                        <li key={m} style={{ display: 'flex', gap: 7, fontSize: 13, color: 'var(--blanc-ink-2)' }}>
                                            <Check size={15} style={{ color: '#16a34a', flexShrink: 0, marginTop: 1 }} />
                                            {Number(plan.included_units[m]).toLocaleString()} {METRIC_LABELS[m]?.toLowerCase()}
                                        </li>
                                    ))}
                                </ul>
                                <button
                                    disabled={isCurrent || !billing_enabled || upgrading === plan.id}
                                    onClick={() => upgrade(plan.id)}
                                    title={!billing_enabled ? 'Billing not enabled yet' : undefined}
                                    style={{
                                        marginTop: 'auto', padding: '10px 14px', borderRadius: 10, fontSize: 13.5, fontWeight: 600,
                                        cursor: isCurrent || !billing_enabled ? 'default' : 'pointer',
                                        border: isCurrent ? '1px solid var(--blanc-line)' : 'none',
                                        background: isCurrent ? 'transparent' : 'var(--blanc-ink-1, #3c362c)',
                                        color: isCurrent ? 'var(--blanc-ink-3)' : '#fff',
                                        opacity: !billing_enabled && !isCurrent ? 0.5 : 1,
                                    }}>
                                    {isCurrent ? 'Current plan' : upgrading === plan.id ? 'Redirecting…' : 'Upgrade'}
                                </button>
                            </div>
                        );
                    })}
                </div>
            </section>

            {/* Invoices */}
            <section>
                <div className="blanc-eyebrow" style={{ marginBottom: 12 }}>Invoices</div>
                {invoices.length === 0 ? (
                    <p style={{ fontSize: 13.5, color: 'var(--blanc-ink-3)', margin: 0 }}>No invoices yet.</p>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                        {invoices.map((inv, i) => (
                            <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', gap: 12 }}>
                                <span style={{ fontSize: 13.5, color: 'var(--blanc-ink-1)', minWidth: 110 }}>{fmtDate(inv.date)}</span>
                                <span style={{ fontSize: 13.5, fontWeight: 600 }}>${inv.amount.toFixed(2)}</span>
                                <span style={{ fontSize: 12.5, fontWeight: 600, color: inv.status === 'paid' ? '#16a34a' : 'var(--blanc-ink-3)', textTransform: 'capitalize', flex: 1, textAlign: 'right' }}>{inv.status}</span>
                                {inv.hosted_url && (
                                    <a href={inv.hosted_url} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5, color: 'var(--blanc-ink-2)', textDecoration: 'none' }}>
                                        View <ExternalLink size={12} />
                                    </a>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </section>
        </div>
    );
}
