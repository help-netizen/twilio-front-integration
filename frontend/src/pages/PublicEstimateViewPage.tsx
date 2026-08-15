import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2, Download, Check, X } from 'lucide-react';

/**
 * The estimate as the customer sees it — ESTIMATE-REDESIGN-001 screens S9/S10.
 *
 * This page is where the feature earns its keep. Until now it could only be
 * read: the customer had no way to say yes, so a dispatcher typed the answer in
 * from memory, and a no arrived as silence. Now it asks the question it exists
 * to ask, and a decline carries a reason back with it.
 *
 * The opaque token is the only credential, exactly as for the read.
 *
 * Same three layers as every estimate surface: identity (the amount and who it
 * is for), the document (summary, items, total), then the decision. Nothing of
 * ours leaks here — no workflow status, no job number, no internal parts list.
 */

interface EstimateLineItem {
    title: string;
    description?: string | null;
    qty: number;
    unit_price: number;
    line_total: number;
}

interface EstimateInfo {
    estimate_number: string;
    status: string;
    currency: string;
    company_name: string;
    company_phone?: string | null;
    contact_name: string | null;
    summary?: string | null;
    notes?: string | null;
    subtotal: number;
    discount_amount: number;
    tax_amount: number;
    total: number;
    deposit_paid: number;
    balance_due: number;
    items: EstimateLineItem[];
}

type Outcome = 'approved' | 'declined' | null;

/** Asked once, never required — but it is what turns "no" into a next step. */
const DECLINE_REASONS = [
    { key: 'price', label: 'Price is too high' },
    { key: 'chose_other', label: 'Chose someone else' },
    { key: 'not_now', label: 'Not right now' },
    { key: 'other', label: 'Something else' },
] as const;

const money = (v: number, cur = 'USD') =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(Number(v || 0));

// Doc numbers are stored with the doc-type word inside ("ESTIMATE L-53-5");
// strip it so headings don't read "Estimate ESTIMATE L-53-5".
function shortDocNumber(value: string | null | undefined): string {
    return String(value || '').replace(/^(?:ESTIMATE|INVOICE)\s+/i, '');
}

export default function PublicEstimateViewPage() {
    const { token } = useParams<{ token: string }>();
    const [info, setInfo] = useState<EstimateInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [outcome, setOutcome] = useState<Outcome>(null);
    const [decliningOpen, setDecliningOpen] = useState(false);
    const [reason, setReason] = useState<string>('');
    const [comment, setComment] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch(`/api/public/estimates/${token}`);
                const json = await res.json();
                if (!res.ok || json.ok === false) throw new Error(json.error?.message || 'This link is no longer available');
                setInfo(json.data);
                // An estimate already answered shows its answer, not the buttons.
                if (json.data?.status === 'approved') setOutcome('approved');
                if (json.data?.status === 'declined') setOutcome('declined');
            } catch (e: unknown) {
                setError(e instanceof Error ? e.message : 'This link is no longer available');
            } finally { setLoading(false); }
        })();
    }, [token]);

    async function submit(kind: 'approve' | 'decline') {
        setSubmitting(true);
        setActionError(null);
        try {
            const res = await fetch(`/api/public/estimates/${token}/${kind}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: kind === 'decline'
                    ? JSON.stringify({ reason: reason || undefined, comment: comment.trim() || undefined })
                    : '{}',
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok || json.ok === false) {
                throw new Error(json.error?.message || 'Something went wrong. Please call us and we will sort it out.');
            }
            setOutcome(kind === 'approve' ? 'approved' : 'declined');
            setDecliningOpen(false);
        } catch (e: unknown) {
            setActionError(e instanceof Error ? e.message : 'Something went wrong.');
        } finally { setSubmitting(false); }
    }

    const cur = info?.currency || 'USD';

    const page: React.CSSProperties = {
        minHeight: '100vh', background: 'var(--blanc-bg)', color: 'var(--blanc-ink-1)',
        fontFamily: 'var(--blanc-font-body)', display: 'flex', justifyContent: 'center',
        padding: '0 16px 48px',
    };
    const sheet: React.CSSProperties = {
        width: 600, maxWidth: '100%', background: 'var(--blanc-surface-strong)',
        borderRadius: 24, padding: '28px 24px 30px', marginTop: 28,
    };
    const l2: React.CSSProperties = { fontSize: 15, fontWeight: 500, lineHeight: '20px' };
    const quiet: React.CSSProperties = { ...l2, color: 'var(--blanc-ink-3)' };
    const h2: React.CSSProperties = {
        fontFamily: 'var(--blanc-font-heading)', fontSize: 20, fontWeight: 600,
        letterSpacing: '-0.02em', margin: '26px 0 8px',
    };
    const totRow: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', padding: '4px 0', ...l2 };
    const button: React.CSSProperties = {
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%',
        minHeight: 50, borderRadius: 14, fontSize: 15, fontWeight: 600, marginTop: 10,
        border: '1px solid transparent', cursor: 'pointer',
    };

    if (loading) {
        return (
            <div style={{ ...page, alignItems: 'center' }}>
                <Loader2 className="size-5 animate-spin" style={{ color: 'var(--blanc-ink-3)' }} />
            </div>
        );
    }

    if (error || !info) {
        return (
            <div style={{ ...page, alignItems: 'center' }}>
                <p style={{ ...quiet, textAlign: 'center' }} data-testid="estimate-public-error">
                    This link is no longer available.
                </p>
            </div>
        );
    }

    return (
        <div style={page}>
            <div style={sheet} data-testid="estimate-public">

                {/* ── identity ── */}
                <div style={quiet}>{info.company_name}</div>
                <h1
                    style={{
                        fontFamily: 'var(--blanc-font-heading)', fontSize: 32, fontWeight: 600,
                        letterSpacing: '-0.025em', lineHeight: 1.05, margin: '12px 0 0',
                        fontVariantNumeric: 'tabular-nums',
                    }}
                    data-testid="estimate-public-total"
                >
                    {money(info.total, cur)}
                </h1>
                <div style={{ ...quiet, marginTop: 7 }}>
                    Estimate{info.contact_name ? ` for ${info.contact_name}` : ''} · {shortDocNumber(info.estimate_number)}
                </div>

                {/* ── the document ── */}
                {info.summary && (
                    <>
                        <h2 style={h2}>Summary</h2>
                        <p style={{ ...l2, margin: 0, whiteSpace: 'pre-wrap' }}>{info.summary}</p>
                    </>
                )}

                <h2 style={h2}>Items</h2>
                {info.items.map((it, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '9px 0', ...l2 }}>
                        <span>
                            {it.title}
                            {it.description && <><br /><span style={{ color: 'var(--blanc-ink-3)' }}>{it.description}</span></>}
                            <br />
                            <span style={{ color: 'var(--blanc-ink-3)' }}>{it.qty} × {money(it.unit_price, cur)}</span>
                        </span>
                        <span style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>{money(it.line_total, cur)}</span>
                    </div>
                ))}

                <div style={{ marginTop: 12 }}>
                    <div style={totRow}><span style={{ color: 'var(--blanc-ink-3)' }}>Subtotal</span><span>{money(info.subtotal, cur)}</span></div>
                    {info.discount_amount > 0 && (
                        <div style={totRow}><span style={{ color: 'var(--blanc-ink-3)' }}>Discount</span><span>−{money(info.discount_amount, cur)}</span></div>
                    )}
                    {info.tax_amount > 0 && (
                        <div style={totRow}><span style={{ color: 'var(--blanc-ink-3)' }}>Tax</span><span>{money(info.tax_amount, cur)}</span></div>
                    )}
                    <div style={{ ...totRow, marginTop: 6 }}>
                        <span style={{ fontFamily: 'var(--blanc-font-heading)', fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em' }}>Total</span>
                        <span style={{ fontFamily: 'var(--blanc-font-heading)', fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em' }}>{money(info.total, cur)}</span>
                    </div>
                </div>

                {info.notes && (
                    <p style={{ ...l2, color: 'var(--blanc-ink-2)', marginTop: 18, whiteSpace: 'pre-wrap' }}>{info.notes}</p>
                )}

                {/* ── the decision ── */}
                {outcome === 'approved' && (
                    <div
                        style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: 'rgba(27,139,99,.10)', borderRadius: 14, padding: '14px 15px', marginTop: 24 }}
                        data-testid="estimate-public-outcome"
                    >
                        <Check className="size-5" style={{ color: 'var(--blanc-success)', flexShrink: 0 }} />
                        <span style={{ ...l2 }}>
                            Thank you — you approved this estimate. We will be in touch to book the visit.
                        </span>
                    </div>
                )}

                {outcome === 'declined' && (
                    <div
                        style={{ background: 'var(--blanc-surface-muted)', borderRadius: 14, padding: '14px 15px', marginTop: 24, ...l2, color: 'var(--blanc-ink-2)' }}
                        data-testid="estimate-public-outcome"
                    >
                        Thank you for letting us know. If anything changes, just call us.
                    </div>
                )}

                {!outcome && (
                    <>
                        <div style={{ background: 'var(--blanc-surface-muted)', borderRadius: 14, padding: '12px 13px', marginTop: 24, ...l2, color: 'var(--blanc-ink-2)' }}>
                            Approving lets us order the parts and book your visit. Nothing is charged today.
                        </div>

                        {actionError && (
                            <p style={{ ...l2, color: 'var(--blanc-danger)', marginTop: 12 }} data-testid="estimate-public-action-error">{actionError}</p>
                        )}

                        <button
                            type="button"
                            disabled={submitting}
                            onClick={() => submit('approve')}
                            style={{ ...button, background: 'var(--blanc-accent)', color: '#fff', opacity: submitting ? 0.6 : 1 }}
                            data-testid="public-estimate-approve"
                        >
                            {submitting ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                            Approve this estimate
                        </button>

                        <a
                            href={`/api/public/estimates/${token}/pdf`}
                            target="_blank"
                            rel="noreferrer"
                            style={{ ...button, background: 'var(--blanc-surface-strong)', borderColor: 'var(--blanc-line)', color: 'var(--blanc-ink-1)', textDecoration: 'none' }}
                        >
                            <Download className="size-4" /> Download PDF
                        </a>

                        <button
                            type="button"
                            disabled={submitting}
                            onClick={() => setDecliningOpen(true)}
                            style={{ ...button, background: 'transparent', color: 'var(--blanc-ink-2)', minHeight: 44, fontWeight: 500 }}
                            data-testid="public-estimate-decline"
                        >
                            Decline
                        </button>
                    </>
                )}

                {info.company_phone && (
                    <p style={{ ...quiet, textAlign: 'center', marginTop: 18 }}>Questions? {info.company_phone}</p>
                )}
            </div>

            {/* ── S10 · decline, with a reason ── */}
            {decliningOpen && (
                <div
                    style={{ position: 'fixed', inset: 0, background: 'rgba(20,20,20,.34)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 50 }}
                    onClick={() => !submitting && setDecliningOpen(false)}
                >
                    <div
                        style={{ width: 600, maxWidth: '100%', background: 'var(--blanc-surface-strong)', borderRadius: '24px 24px 0 0', padding: '10px 20px 24px' }}
                        onClick={event => event.stopPropagation()}
                        data-testid="estimate-public-decline-sheet"
                    >
                        <div style={{ width: 38, height: 4, borderRadius: 2, background: 'rgba(25,25,25,.18)', margin: '0 auto 10px' }} />
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <h2 style={{ ...h2, margin: '4px 0 0' }}>Not going ahead?</h2>
                            <button
                                type="button"
                                onClick={() => setDecliningOpen(false)}
                                style={{ background: 'none', border: 'none', color: 'var(--blanc-ink-3)', cursor: 'pointer', padding: 4 }}
                                aria-label="Close"
                            >
                                <X className="size-5" />
                            </button>
                        </div>
                        <p style={{ ...quiet, margin: '2px 0 0' }}>Telling us why takes a second and helps us do better.</p>

                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 14 }}>
                            {DECLINE_REASONS.map(option => {
                                const on = reason === option.key;
                                return (
                                    <button
                                        key={option.key}
                                        type="button"
                                        onClick={() => setReason(on ? '' : option.key)}
                                        style={{
                                            ...l2, padding: '7px 12px', borderRadius: 999, cursor: 'pointer',
                                            background: on ? 'var(--blanc-accent-soft)' : 'var(--blanc-surface-strong)',
                                            border: `1px solid ${on ? 'transparent' : 'var(--blanc-line)'}`,
                                            color: on ? 'var(--blanc-accent)' : 'var(--blanc-ink-1)',
                                        }}
                                        data-testid={`public-estimate-decline-reason-${option.key}`}
                                    >
                                        {option.label}
                                    </button>
                                );
                            })}
                        </div>

                        <textarea
                            value={comment}
                            onChange={event => setComment(event.target.value)}
                            placeholder="Anything to add (optional)"
                            rows={3}
                            style={{
                                ...l2, width: '100%', marginTop: 12, padding: '11px 13px', borderRadius: 12,
                                background: 'var(--blanc-field)', border: 'none', resize: 'none', outline: 'none',
                                fontFamily: 'var(--blanc-font-body)',
                            }}
                            data-testid="public-estimate-decline-comment"
                        />

                        {actionError && (
                            <p style={{ ...l2, color: 'var(--blanc-danger)', marginTop: 10 }}>{actionError}</p>
                        )}

                        <button
                            type="button"
                            disabled={submitting}
                            onClick={() => submit('decline')}
                            style={{ ...button, background: 'var(--blanc-ink-1)', color: '#fff', opacity: submitting ? 0.6 : 1 }}
                            data-testid="public-estimate-decline-submit"
                        >
                            {submitting && <Loader2 className="size-4 animate-spin" />}
                            Send &amp; decline
                        </button>
                        <button
                            type="button"
                            disabled={submitting}
                            onClick={() => setDecliningOpen(false)}
                            style={{ ...button, background: 'transparent', color: 'var(--blanc-ink-2)', minHeight: 44, fontWeight: 500 }}
                        >
                            Back
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
