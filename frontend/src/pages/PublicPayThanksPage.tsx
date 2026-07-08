import { CheckCircle2, XCircle } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';

/**
 * SAP-02: public, unauthenticated confirmation page for the ad-hoc job
 * Stripe Checkout link. Checkout is Stripe-hosted, so success/cancel simply
 * redirect the browser here — this page fetches NO data and needs NO auth.
 * It renders standalone (no app chrome) since it is opened inside Stripe's
 * redirect. `?status=cancel` shows a neutral canceled state; default = thanks.
 */
export default function PublicPayThanksPage() {
    const [params] = useSearchParams();
    const canceled = (params.get('status') || '').toLowerCase() === 'cancel';

    const wrap = {
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#faf8f4',
        fontFamily: 'IBM Plex Sans, system-ui, sans-serif',
        color: '#2b2b2b',
        padding: 16,
    } as const;
    const card = {
        width: 460,
        maxWidth: '94vw',
        background: '#fffdf9',
        border: '1px solid var(--blanc-line)',
        borderRadius: 24,
        padding: 30,
        textAlign: 'center',
    } as const;

    return (
        <div style={wrap}>
            <div style={card}>
                {canceled ? (
                    <>
                        <XCircle style={{ width: 48, height: 48, color: '#a99e8a', margin: '0 auto 14px' }} />
                        <h1 style={{ fontFamily: 'Manrope, sans-serif', fontSize: 24, margin: 0 }}>Payment canceled</h1>
                        <p style={{ color: '#6b5f4c', marginTop: 8 }}>You can close this page.</p>
                    </>
                ) : (
                    <>
                        <CheckCircle2 style={{ width: 48, height: 48, color: '#2f8a5b', margin: '0 auto 14px' }} />
                        <h1 style={{ fontFamily: 'Manrope, sans-serif', fontSize: 24, margin: 0 }}>Payment received</h1>
                        <p style={{ color: '#6b5f4c', marginTop: 8 }}>Thank you! You can close this page.</p>
                    </>
                )}
            </div>
        </div>
    );
}
