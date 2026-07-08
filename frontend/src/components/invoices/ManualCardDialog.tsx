import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogPanelHeader, DialogBody, DialogPanelFooter, DialogTitle } from '../ui/dialog';
import { invoiceStripeApi, jobStripeApi } from '../../services/stripePaymentsApi';
import { loadStripe } from '../../utils/loadStripe';

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    invoiceId?: number;
    jobId?: number | string;
    amount?: number;
    onSuccess?: () => void;
}

/**
 * Keyed/manual card entry via Stripe Payment Element (PCI-minimizing: card fields are
 * Stripe-rendered, never touch Albusto). The backend creates a direct-charge
 * PaymentIntent; the canonical ledger is updated by the webhook on success.
 */
export default function ManualCardDialog({ open, onOpenChange, invoiceId, jobId, amount, onSuccess }: Props) {
    const mountRef = useRef<HTMLDivElement>(null);
    const stripeRef = useRef<any>(null);
    const elementsRef = useRef<any>(null);
    const [loading, setLoading] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        if (!open) { setReady(false); setError(null); return; }
        let cancelled = false;
        (async () => {
            setLoading(true); setError(null);
            try {
                const session = jobId != null
                    ? await jobStripeApi.manualCardSession(jobId, amount)
                    : await invoiceStripeApi.manualCardSession(invoiceId!, amount);
                const stripe = await loadStripe(session.account_id);
                if (cancelled) return;
                const elements = stripe.elements({ clientSecret: session.client_secret });
                const paymentElement = elements.create('payment');
                stripeRef.current = stripe;
                elementsRef.current = elements;
                // Defer mount until the node exists in the DOM.
                requestAnimationFrame(() => { if (mountRef.current) { paymentElement.mount(mountRef.current); setReady(true); } });
            } catch (e: any) {
                if (!cancelled) setError(/not ready|NOT_READY/i.test(String(e?.message)) ? 'Connect Stripe in Integrations first.' : (e?.message || 'Could not start card entry'));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [open, invoiceId, jobId, amount]);

    const submit = async () => {
        if (!stripeRef.current || !elementsRef.current) return;
        setSubmitting(true); setError(null);
        try {
            const { error: payError } = await stripeRef.current.confirmPayment({ elements: elementsRef.current, redirect: 'if_required' });
            if (payError) { setError(payError.message || 'Payment failed'); return; }
            toast.success('Payment submitted');
            onOpenChange(false);
            onSuccess?.();
        } catch (e: any) {
            setError(e?.message || 'Payment failed');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle
                        className="text-[22px] font-semibold leading-tight"
                        style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                    >
                        Enter card manually
                    </DialogTitle>
                    <DialogDescription className="sr-only">Charge a card via Stripe's secure form</DialogDescription>
                </DialogPanelHeader>

                <DialogBody className="md:px-8 md:py-7">
                  <div className="mx-auto w-full max-w-[740px] space-y-6">
                    <p className="text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                        Card details are entered securely in Stripe's form. Albusto never sees the card number.
                        Keyed entry may carry different fees/risk than a card-present payment.
                    </p>
                    {loading && <div className="flex items-center gap-2 text-sm text-muted-foreground py-6"><Loader2 className="h-4 w-4 animate-spin" /> Preparing secure form…</div>}
                    <div ref={mountRef} className="min-h-[40px]" />
                    {error && <p className="text-sm text-red-600">{error}</p>}
                  </div>
                </DialogBody>

                <DialogPanelFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
                    <Button onClick={submit} disabled={!ready || submitting}>
                        {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Charge card
                    </Button>
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}
