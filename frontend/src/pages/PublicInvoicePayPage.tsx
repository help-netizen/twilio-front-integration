import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2, CheckCircle2 } from 'lucide-react';

/**
 * Public, unauthenticated Stripe Pay-now page (F018). The opaque :token is the
 * credential. Calls the public backend endpoints (no authedFetch — plain fetch).
 */
interface PayInfo {
    invoice_number: string;
    status: string;
    balance_due: number;
    currency: string;
    paid: boolean;
    payable: boolean;
}

const money = (v: number, cur = 'USD') =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(Number(v || 0));

export default function PublicInvoicePayPage() {
    const { token } = useParams<{ token: string }>();
    const [info, setInfo] = useState<PayInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [paying, setPaying] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch(`/api/public/invoices/${token}/pay-info`);
                const json = await res.json();
                if (!res.ok || json.ok === false) throw new Error(json.error?.message || 'Invoice not found');
                setInfo(json.data);
            } catch (e: any) {
                setError(e?.message || 'Invoice not found');
            } finally {
                setLoading(false);
            }
        })();
    }, [token]);

    const pay = async () => {
        setPaying(true); setError(null);
        try {
            const res = await fetch(`/api/public/invoices/${token}/pay`, { method: 'POST' });
            const json = await res.json();
            if (!res.ok || json.ok === false) throw new Error(json.error?.message || 'Could not start payment');
            window.location.href = json.data.url; // redirect to Stripe Checkout
        } catch (e: any) {
            setError(e?.message || 'Could not start payment');
            setPaying(false);
        }
    };

    return (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#faf8f4', fontFamily: 'IBM Plex Sans, system-ui, sans-serif' }}>
            <div style={{ width: 420, maxWidth: '92vw', background: '#fffdf9', border: '1px solid rgba(117,106,89,0.18)', borderRadius: 22, padding: 32 }}>
                {loading ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#8a7d68' }}>
                        <Loader2 className="h-4 w-4 animate-spin" /> Loading invoice…
                    </div>
                ) : error && !info ? (
                    <p style={{ color: '#b4453a' }}>{error}</p>
                ) : info ? (
                    <>
                        <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.14em', color: '#a99e8a', fontWeight: 700 }}>Invoice</div>
                        <h1 style={{ fontFamily: 'Manrope, sans-serif', fontSize: 26, margin: '4px 0 18px' }}>{info.invoice_number}</h1>
                        {info.paid ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#2f8a5b' }}>
                                <CheckCircle2 className="h-5 w-5" /> This invoice is paid. Thank you!
                            </div>
                        ) : (
                            <>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, marginBottom: 20 }}>
                                    <span style={{ color: '#6b5f4c' }}>Balance due</span>
                                    <span style={{ fontWeight: 700 }}>{money(info.balance_due, info.currency)}</span>
                                </div>
                                {info.payable ? (
                                    <button onClick={pay} disabled={paying}
                                        style={{ width: '100%', padding: '12px 16px', borderRadius: 12, border: 'none', background: '#635bff', color: '#fff', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                                        {paying && <Loader2 className="h-4 w-4 animate-spin" />} Pay now
                                    </button>
                                ) : (
                                    <p style={{ color: '#8a7d68' }}>Online payment is currently unavailable for this invoice.</p>
                                )}
                                {error && <p style={{ color: '#b4453a', marginTop: 12 }}>{error}</p>}
                            </>
                        )}
                    </>
                ) : null}
            </div>
        </div>
    );
}
