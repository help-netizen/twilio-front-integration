import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { loadStripe } from '../utils/loadStripe';

/**
 * Public, unauthenticated branded payment page (F018). Shows a thank-you, the
 * technician who did the work, the amount, an optional tip, and an embedded Stripe
 * Payment Element for card / Apple Pay / Google Pay. The opaque :token is the credential.
 */
interface Technician { name: string | null; photo_url: string | null }
interface PayInfo {
    invoice_number: string;
    status: string;
    balance_due: number;
    currency: string;
    paid: boolean;
    payable: boolean;
    company_name: string;
    thank_you: string;
    technician: Technician | null;
}

const TIP_PRESETS = [0.15, 0.18, 0.20];
const money = (v: number, cur = 'USD') =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(Number(v || 0));

function initials(name?: string | null) {
    if (!name) return '🙂';
    return name.trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
}

export default function PublicInvoicePayPage() {
    const { token } = useParams<{ token: string }>();
    const [info, setInfo] = useState<PayInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [tip, setTip] = useState(0);
    const [customTip, setCustomTip] = useState('');
    const [tipMode, setTipMode] = useState<'preset' | 'custom' | 'none'>('none');

    const [step, setStep] = useState<'summary' | 'pay' | 'done'>('summary');
    const [preparing, setPreparing] = useState(false);
    const [paying, setPaying] = useState(false);
    const mountRef = useRef<HTMLDivElement>(null);
    const stripeRef = useRef<any>(null);
    const elementsRef = useRef<any>(null);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch(`/api/public/invoices/${token}/pay-info`);
                const json = await res.json();
                if (!res.ok || json.ok === false) throw new Error(json.error?.message || 'Invoice not found');
                setInfo(json.data);
            } catch (e: any) { setError(e?.message || 'Invoice not found'); }
            finally { setLoading(false); }
        })();
    }, [token]);

    const balance = info?.balance_due || 0;
    const tipValue = tipMode === 'custom' ? (parseFloat(customTip) || 0) : tip;
    const total = balance + (tipValue > 0 ? tipValue : 0);

    const continueToPayment = async () => {
        setPreparing(true); setError(null);
        try {
            const res = await fetch(`/api/public/invoices/${token}/pay-intent`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tip: tipMode === 'none' ? 0 : tipValue }),
            });
            const json = await res.json();
            if (!res.ok || json.ok === false) throw new Error(json.error?.message || 'Could not start payment');
            const stripe = await loadStripe(json.data.account_id);
            const elements = stripe.elements({ clientSecret: json.data.client_secret, appearance: { theme: 'stripe' } });
            stripeRef.current = stripe; elementsRef.current = elements;
            setStep('pay');
            requestAnimationFrame(() => { if (mountRef.current) elements.create('payment').mount(mountRef.current); });
        } catch (e: any) {
            setError(/not ready|NOT_READY/i.test(String(e?.message)) ? 'Online payment is temporarily unavailable.' : (e?.message || 'Could not start payment'));
        } finally { setPreparing(false); }
    };

    const pay = async () => {
        if (!stripeRef.current || !elementsRef.current) return;
        setPaying(true); setError(null);
        try {
            const { error: payErr } = await stripeRef.current.confirmPayment({ elements: elementsRef.current, redirect: 'if_required' });
            if (payErr) { setError(payErr.message || 'Payment failed'); return; }
            setStep('done');
        } catch (e: any) { setError(e?.message || 'Payment failed'); }
        finally { setPaying(false); }
    };

    const card = { width: 460, maxWidth: '94vw', background: '#fffdf9', border: '1px solid rgba(117,106,89,0.18)', borderRadius: 24, padding: 30 } as const;
    const wrap = { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#faf8f4', fontFamily: 'IBM Plex Sans, system-ui, sans-serif', color: '#2b2b2b', padding: 16 } as const;

    if (loading) return <div style={wrap}><div style={{ display: 'flex', gap: 8, color: '#8a7d68' }}><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div></div>;
    if (error && !info) return <div style={wrap}><div style={card}><p style={{ color: '#b4453a' }}>{error}</p></div></div>;
    if (!info) return null;

    return (
        <div style={wrap}>
            <div style={card}>
                {step === 'done' || info.paid ? (
                    <div style={{ textAlign: 'center', padding: '20px 0' }}>
                        <CheckCircle2 style={{ width: 48, height: 48, color: '#2f8a5b', margin: '0 auto 14px' }} />
                        <h1 style={{ fontFamily: 'Manrope, sans-serif', fontSize: 24, margin: 0 }}>Thank you!</h1>
                        <p style={{ color: '#6b5f4c', marginTop: 8 }}>Your payment was received{tipValue > 0 ? ' (tip included)' : ''}. We appreciate you!</p>
                    </div>
                ) : (
                    <>
                        <div style={{ fontSize: 13, color: '#a99e8a', fontWeight: 600 }}>{info.company_name}</div>
                        <h1 style={{ fontFamily: 'Manrope, sans-serif', fontSize: 22, margin: '6px 0 14px', lineHeight: 1.3 }}>{info.thank_you}</h1>

                        {info.technician && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderTop: '1px solid rgba(117,106,89,0.12)', borderBottom: '1px solid rgba(117,106,89,0.12)', marginBottom: 16 }}>
                                {info.technician.photo_url
                                    ? <img src={info.technician.photo_url} alt={info.technician.name || ''} style={{ width: 52, height: 52, borderRadius: '50%', objectFit: 'cover' }} />
                                    : <div style={{ width: 52, height: 52, borderRadius: '50%', background: '#efe7d8', color: '#8a7d68', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>{initials(info.technician.name)}</div>}
                                <div>
                                    <div style={{ fontSize: 12, color: '#a99e8a' }}>Your technician</div>
                                    <div style={{ fontWeight: 600 }}>{info.technician.name || 'Our technician'}</div>
                                </div>
                            </div>
                        )}

                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, marginBottom: 4 }}>
                            <span style={{ color: '#6b5f4c' }}>Invoice {info.invoice_number}</span>
                            <span>{money(balance, info.currency)}</span>
                        </div>

                        {step === 'summary' && info.payable && (
                            <>
                                <div style={{ marginTop: 14, fontSize: 13, color: '#a99e8a', fontWeight: 600 }}>ADD A TIP</div>
                                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                                    {TIP_PRESETS.map(p => {
                                        const amt = Number((balance * p).toFixed(2));
                                        const active = tipMode === 'preset' && tip === amt;
                                        return (
                                            <button key={p} onClick={() => { setTipMode('preset'); setTip(amt); }}
                                                style={{ flex: 1, padding: '10px 6px', borderRadius: 12, cursor: 'pointer', border: active ? '2px solid #635bff' : '1px solid rgba(117,106,89,0.25)', background: active ? '#f3f1ff' : '#fff' }}>
                                                <div style={{ fontWeight: 700 }}>{Math.round(p * 100)}%</div>
                                                <div style={{ fontSize: 12, color: '#6b5f4c' }}>{money(amt, info.currency)}</div>
                                            </button>
                                        );
                                    })}
                                </div>
                                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                                    <button onClick={() => { setTipMode('none'); setTip(0); setCustomTip(''); }}
                                        style={{ flex: 1, padding: '8px', borderRadius: 12, cursor: 'pointer', border: tipMode === 'none' ? '2px solid #635bff' : '1px solid rgba(117,106,89,0.25)', background: tipMode === 'none' ? '#f3f1ff' : '#fff' }}>No tip</button>
                                    <input inputMode="decimal" placeholder="Custom $" value={customTip}
                                        onChange={e => { setCustomTip(e.target.value); setTipMode('custom'); }}
                                        style={{ flex: 1, padding: '8px 12px', borderRadius: 12, border: tipMode === 'custom' ? '2px solid #635bff' : '1px solid rgba(117,106,89,0.25)' }} />
                                </div>

                                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 17, margin: '18px 0 14px' }}>
                                    <span>Total</span><span>{money(total, info.currency)}</span>
                                </div>
                                <button onClick={continueToPayment} disabled={preparing}
                                    style={{ width: '100%', padding: '13px', borderRadius: 12, border: 'none', background: '#635bff', color: '#fff', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                                    {preparing && <Loader2 className="h-4 w-4 animate-spin" />} Continue to payment
                                </button>
                            </>
                        )}

                        {step === 'pay' && (
                            <>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 17, margin: '14px 0' }}>
                                    <span>Total{tipValue > 0 ? ' (incl. tip)' : ''}</span><span>{money(total, info.currency)}</span>
                                </div>
                                <div ref={mountRef} style={{ minHeight: 40, marginBottom: 14 }} />
                                <button onClick={pay} disabled={paying}
                                    style={{ width: '100%', padding: '13px', borderRadius: 12, border: 'none', background: '#635bff', color: '#fff', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                                    {paying && <Loader2 className="h-4 w-4 animate-spin" />} Pay {money(total, info.currency)}
                                </button>
                            </>
                        )}

                        {step === 'summary' && !info.payable && (
                            <p style={{ color: '#8a7d68', marginTop: 14 }}>Online payment is currently unavailable for this invoice.</p>
                        )}
                        {error && <p style={{ color: '#b4453a', marginTop: 12 }}>{error}</p>}
                    </>
                )}
            </div>
        </div>
    );
}
