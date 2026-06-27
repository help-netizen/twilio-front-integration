import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2, Download } from 'lucide-react';

/**
 * Public, unauthenticated branded estimate page (SEND-DOC-001). VIEW-ONLY — mirrors
 * PublicInvoicePayPage minus every payment control. Shows the company header, estimate
 * number + status, line items, totals and a "Download PDF" link. The opaque :token is
 * the only credential. No tip / Stripe / accept / decline in v1.
 */
interface EstimateLineItem {
    title: string;
    qty: number;
    unit_price: number;
    line_total: number;
}
interface EstimateInfo {
    estimate_number: string;
    status: string;
    currency: string;
    company_name: string;
    contact_name: string | null;
    notes?: string | null;
    subtotal: number;
    discount_amount: number;
    tax_amount: number;
    total: number;
    items: EstimateLineItem[];
}

const money = (v: number, cur = 'USD') =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(Number(v || 0));

function statusLabel(status: string): string {
    if (!status) return '';
    return status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' ');
}

export default function PublicEstimateViewPage() {
    const { token } = useParams<{ token: string }>();
    const [info, setInfo] = useState<EstimateInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch(`/api/public/estimates/${token}`);
                const json = await res.json();
                if (!res.ok || json.ok === false) throw new Error(json.error?.message || 'This link is no longer available');
                setInfo(json.data);
            } catch (e: any) { setError(e?.message || 'This link is no longer available'); }
            finally { setLoading(false); }
        })();
    }, [token]);

    const cur = info?.currency || 'USD';
    const card = { width: 560, maxWidth: '94vw', background: '#fffdf9', border: '1px solid rgba(117,106,89,0.18)', borderRadius: 24, padding: 30 } as const;
    const wrap = { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#faf8f4', fontFamily: 'IBM Plex Sans, system-ui, sans-serif', color: '#2b2b2b', padding: 16 } as const;
    const row = { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 14 } as const;

    if (loading) return <div style={wrap}><div style={{ display: 'flex', gap: 8, color: '#8a7d68' }}><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div></div>;
    if (error || !info) return <div style={wrap}><div style={card}><p style={{ color: '#8a7d68', margin: 0 }}>This link is no longer available.</p></div></div>;

    return (
        <div style={wrap}>
            <div style={card}>
                <div style={{ fontSize: 13, color: '#a99e8a', fontWeight: 600 }}>{info.company_name}</div>
                <h1 style={{ fontFamily: 'Manrope, sans-serif', fontSize: 22, margin: '6px 0 4px', lineHeight: 1.3 }}>Estimate {info.estimate_number}</h1>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#8a7d68', background: 'rgba(117,106,89,0.08)', borderRadius: 999, padding: '3px 10px' }}>{statusLabel(info.status)}</span>
                    {info.contact_name && <span style={{ fontSize: 13, color: '#a99e8a' }}>For {info.contact_name}</span>}
                </div>

                <div style={{ borderTop: '1px solid rgba(117,106,89,0.12)', paddingTop: 14 }}>
                    {info.items.map((it, i) => (
                        <div key={i} style={{ ...row, marginBottom: 10 }}>
                            <span style={{ color: '#3a342b' }}>
                                {it.title}
                                {it.qty > 1 && <span style={{ color: '#a99e8a' }}> · {it.qty} × {money(it.unit_price, cur)}</span>}
                            </span>
                            <span style={{ whiteSpace: 'nowrap' }}>{money(it.line_total, cur)}</span>
                        </div>
                    ))}
                </div>

                <div style={{ borderTop: '1px solid rgba(117,106,89,0.12)', marginTop: 6, paddingTop: 14 }}>
                    <div style={{ ...row, color: '#6b5f4c', marginBottom: 6 }}><span>Subtotal</span><span>{money(info.subtotal, cur)}</span></div>
                    {info.discount_amount > 0 && <div style={{ ...row, color: '#6b5f4c', marginBottom: 6 }}><span>Discount</span><span>−{money(info.discount_amount, cur)}</span></div>}
                    {info.tax_amount > 0 && <div style={{ ...row, color: '#6b5f4c', marginBottom: 6 }}><span>Tax</span><span>{money(info.tax_amount, cur)}</span></div>}
                    <div style={{ ...row, fontWeight: 700, fontSize: 17, marginTop: 8 }}><span>Total</span><span>{money(info.total, cur)}</span></div>
                </div>

                {info.notes && <p style={{ marginTop: 18, fontSize: 13, color: '#6b5f4c', whiteSpace: 'pre-wrap' }}>{info.notes}</p>}

                <a
                    href={`/api/public/estimates/${token}/pdf`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 22, padding: '11px 16px', borderRadius: 12, border: '1px solid rgba(117,106,89,0.25)', background: '#fff', color: '#3a342b', fontWeight: 600, textDecoration: 'none' }}
                >
                    <Download className="h-4 w-4" /> Download PDF
                </a>
            </div>
        </div>
    );
}
