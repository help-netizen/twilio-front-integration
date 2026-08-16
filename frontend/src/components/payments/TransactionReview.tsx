/**
 * RECEIPT-REVIEW-001 — the detailed transaction "Review / Transaction Details" body,
 * shared by the Job finance Review slide-over and the /payments ledger detail panel.
 * Fetches the enriched GET /api/payments/:id detail, shows the full field set + receipt
 * history, and offers inline Send Receipt + Void actions. Panel chrome is the caller's.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, Mail, Ban, Check } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { FloatingField } from '../ui/floating-field';
import {
    fetchTransaction,
    emailTransactionReceipt,
    voidTransaction,
    type PaymentTransaction,
} from '../../services/paymentsCanonicalApi';
import { formatSignedCurrency } from '../jobs/jobFinanceMath';
import { paymentMethodLabel } from '../../lib/paymentMethodLabels';
import { PaymentStatusChip, isVoidablePayment, isVoidedPayment, VOIDED_AMOUNT_CLASS } from './paymentStatus';
import { VoidPaymentDialog } from './VoidPaymentDialog';
import { formatCompanyTime, useCompanyTime } from '../../lib/companyTime';

interface Props {
    /** Transaction id; the enriched detail is fetched on mount. */
    transactionId: number | string;
    /** Optional already-loaded row to render instantly while the detail loads. */
    initial?: PaymentTransaction | null;
    /** Contact email fallback for the receipt recipient. */
    contactEmail?: string | null;
    /** Whether the operator may void (payments.collect_offline). */
    canVoid?: boolean;
    /** Extra action(s) rendered in the action stack (e.g. the ledger's Refund). */
    extraActions?: React.ReactNode;
    /** Called after a successful void so the parent can refresh its finance data. */
    onChanged?: () => void;
}

function money(v: string | number | null | undefined): string {
    return formatSignedCurrency(v);
}

function fmtDateTime(value: string | null | undefined, timeZone: string): string {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return formatCompanyTime(d, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }, timeZone);
}

function methodDisplay(tx: PaymentTransaction): string {
    if (tx.brand && tx.last4) {
        const brand = tx.brand.charAt(0).toUpperCase() + tx.brand.slice(1);
        return `${brand} •••• ${tx.last4}`;
    }
    return paymentMethodLabel(tx.payment_method);
}

/** One label/value row (value omitted → row not rendered). */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex items-baseline justify-between gap-4">
            <span className="blanc-eyebrow shrink-0">{label}</span>
            <span className="min-w-0 text-right text-sm text-[var(--blanc-ink-1)]">{children}</span>
        </div>
    );
}

export function TransactionReview({ transactionId, initial, contactEmail, canVoid = false, extraActions, onChanged }: Props) {
    const { timeZone } = useCompanyTime();
    const [tx, setTx] = useState<PaymentTransaction | null>(initial ?? null);
    const [voidOpen, setVoidOpen] = useState(false);

    // Receipt send: a reveal-on-click email form (prefilled), idempotent per send.
    const [receiptOpen, setReceiptOpen] = useState(false);
    const [email, setEmail] = useState('');
    const [sending, setSending] = useState(false);
    const [sentTo, setSentTo] = useState<string | null>(null);

    const load = useCallback(() => {
        let cancelled = false;
        fetchTransaction(Number(transactionId))
            .then(detail => { if (!cancelled) setTx(detail); })
            .catch(() => { /* keep the initial row if the detail fetch fails */ });
        return () => { cancelled = true; };
    }, [transactionId]);

    useEffect(() => load(), [load]);
    useEffect(() => { setEmail((contactEmail || '').trim()); }, [contactEmail]);

    const isCard = Boolean(tx?.stripe_payment_id) || (tx?.external_source === 'stripe');
    const voided = tx ? isVoidedPayment(tx) : false;
    const jobLabel = tx?.job_id != null ? `#JOB-${tx.job_id}` : tx?.invoice_number ? `#${tx.invoice_number}` : null;

    const sendReceipt = async () => {
        const to = email.trim();
        if (!to || sending || !tx) return;
        setSending(true);
        try {
            const key = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(tx.id);
            const res = await emailTransactionReceipt(Number(tx.id), to, `review-send-${tx.id}-${key}`);
            const savedTo = res.receipt_history_entry?.to || to;
            setSentTo(savedTo);
            setReceiptOpen(false);
            toast.success(`Receipt sent to ${savedTo}`);
            load();
        } catch (e: any) {
            toast.error(e?.message || 'Could not send the receipt');
        } finally {
            setSending(false);
        }
    };

    const handleVoid = async (reason: string) => {
        if (!tx) return;
        try {
            await voidTransaction(Number(tx.id), reason);
        } catch (e: any) {
            toast.error(e?.message || 'Could not void the payment');
            throw e;
        }
        toast.success('Payment voided');
        onChanged?.();
        load();
    };

    if (!tx) {
        return (
            <div className="flex items-center gap-2 p-6 text-sm text-[var(--blanc-ink-2)]">
                <Loader2 className="size-4 animate-spin" /> Loading transaction…
            </div>
        );
    }

    const receiptHistory = tx.receipt_history ?? [];

    return (
        // min-h-0 flex-1 overflow-y-auto → THIS is the scroll owner inside the flex-column
        // `.blanc-floating-panel` (which is overflow:hidden). Every other FloatingDetailPanel
        // child self-scrolls (h-full/max-h-full + overflow-y-auto); this one didn't, so a tall
        // receipt (long receipt history + the reveal form) was clipped on desktop and chained
        // to the page behind on mobile. overscroll-contain stops the boundary scroll from
        // bleeding out; the panel also locks the body on mobile (FloatingDetailPanel).
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain p-6">
            {/* Header — amount + context + status */}
            <div>
                <p className={`font-mono text-3xl font-semibold text-[var(--blanc-ink-1)] ${voided ? VOIDED_AMOUNT_CLASS : ''}`}>
                    {money(tx.amount)}
                </p>
                <p className="mt-1 text-sm text-[var(--blanc-ink-2)]">
                    {tx.transaction_type === 'refund' ? 'Refund' : 'Payment'}
                    {jobLabel && <> for <span className="text-[var(--blanc-ink-1)]">{jobLabel}</span></>}
                </p>
                <p className="mt-0.5 text-sm text-[var(--blanc-ink-3)]">{fmtDateTime(tx.processed_at || tx.created_at, timeZone)}</p>
                <div className="mt-2">
                    <PaymentStatusChip status={tx.status} transactionType={tx.transaction_type} />
                </div>
            </div>

            {/* Details */}
            <div className="space-y-3">
                <Row label="Payment method">{methodDisplay(tx)}</Row>
                {tx.customer_name && <Row label="Customer">{tx.customer_name}</Row>}
                {tx.invoice_number && <Row label="Invoice"><span className="font-mono">{tx.invoice_number}</span></Row>}
                <Row label="Memo">
                    {tx.memo ? tx.memo : <span className="text-[var(--blanc-ink-3)]">No memo</span>}
                </Row>
                {isCard && tx.stripe_payment_id && (
                    <Row label="Stripe transaction ID"><span className="break-all font-mono text-xs">{tx.stripe_payment_id}</span></Row>
                )}
                {isCard && tx.stripe_customer_id && (
                    <Row label="Stripe customer ID"><span className="break-all font-mono text-xs">{tx.stripe_customer_id}</span></Row>
                )}
                {tx.created_by_name && <Row label="Created by">{tx.created_by_name}</Row>}
                {tx.territory && <Row label="Territory">{tx.territory}</Row>}
                {voided && tx.void_reason && (
                    <Row label="Void reason"><span className="max-w-[60%]">{tx.void_reason}</span></Row>
                )}
                {voided && tx.voided_by_name && <Row label="Voided by">{tx.voided_by_name}</Row>}
            </div>

            {/* Receipt history */}
            <div className="space-y-2">
                <p className="blanc-eyebrow">Receipt history</p>
                {receiptHistory.length === 0 && !sentTo ? (
                    <p className="text-sm text-[var(--blanc-ink-3)]">No receipt sent</p>
                ) : (
                    <div className="space-y-1.5">
                        {sentTo && receiptHistory.length === 0 && (
                            <p className="flex items-center gap-1.5 text-sm text-[var(--blanc-ink-2)]">
                                <Check className="size-4 text-[var(--blanc-success)]" /> Receipt sent to {sentTo}
                            </p>
                        )}
                        {receiptHistory.map((r, i) => (
                            <p key={i} className="text-sm text-[var(--blanc-ink-2)]">
                                Receipt sent to {r.to || 'customer'} on {fmtDateTime(r.sent_at, timeZone)}
                            </p>
                        ))}
                    </div>
                )}
            </div>

            {/* Actions */}
            <div className="space-y-3 pt-1">
                {receiptOpen ? (
                    // White surface (not --blanc-field): the filled email field is itself
                    // --blanc-field, so on a matching grey card it vanished and read as plain text —
                    // techs thought the pre-filled address was un-editable. On white it clearly reads
                    // as an input.
                    <div className="space-y-3 rounded-2xl bg-[var(--blanc-surface-strong)] border border-[var(--blanc-line)] p-4">
                        {/* Focus selects the WHOLE address: a double-tap inside an email
                            input selects only one "word" — the part after @ — so techs
                            could not select it by hand. The explicit "Copy email" button
                            that used to sit under here is gone (owner, 2026-08-16): this
                            form exists to SEND the receipt, and a second, quieter verb
                            beside that one only asks the reader which they meant. */}
                        <FloatingField
                            label="Customer email"
                            type="email"
                            inputMode="email"
                            value={email}
                            onFocus={e => e.currentTarget.select()}
                            onChange={e => setEmail(e.target.value)}
                        />
                        <div className="flex gap-3">
                            <Button variant="ghost" className="flex-1" onClick={() => setReceiptOpen(false)} disabled={sending}>Cancel</Button>
                            <Button className="flex-[2]" onClick={() => void sendReceipt()} disabled={!email.trim() || sending}>
                                {sending && <Loader2 className="mr-2 size-4 animate-spin" />}
                                {sending ? 'Sending…' : 'Send receipt'}
                            </Button>
                        </div>
                    </div>
                ) : (
                    <Button variant="outline" className="w-full" onClick={() => setReceiptOpen(true)}>
                        <Mail className="mr-1.5 size-4" />{sentTo || receiptHistory.length > 0 ? 'Resend receipt' : 'Send receipt'}
                    </Button>
                )}

                {extraActions}

                {canVoid && isVoidablePayment(tx) && (
                    <Button
                        variant="ghost"
                        className="w-full text-[var(--blanc-danger)] hover:text-[var(--blanc-danger)]"
                        onClick={() => setVoidOpen(true)}
                    >
                        <Ban className="mr-1.5 size-4" />Void transaction
                    </Button>
                )}
            </div>

            <VoidPaymentDialog
                open={voidOpen}
                onOpenChange={setVoidOpen}
                bodyText="This will void the payment and recalculate the linked invoice or job balance."
                onConfirm={handleVoid}
            />
        </div>
    );
}
