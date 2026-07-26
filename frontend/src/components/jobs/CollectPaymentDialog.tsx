import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ArrowLeft, Copy, CreditCard, Loader2, Mail, MessageSquare, Send } from 'lucide-react';
import { Button } from '../ui/button';
import {
    Dialog, DialogContent, DialogDescription,
    DialogPanelHeader, DialogBody, DialogPanelFooter, DialogTitle,
} from '../ui/dialog';
import { FloatingField } from '../ui/floating-field';
import { PhoneInput, formatUSPhone, isValidUSPhone, toE164 } from '../ui/PhoneInput';
import { maskMoneyDigits } from '../ui/MoneyInput';
import { jobStripeApi, type ManualCardSessionResult } from '../../services/stripePaymentsApi';
import ManualCardDialog from '../invoices/ManualCardDialog';

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    jobId: number | string;
    /** Job outstanding balance (dollars). Prefilled iff > 0, else the field starts blank. */
    outstanding: number;
    hasInvoices?: boolean;
    contactEmail?: string | null;
    contactPhone?: string | null;
    hasContact?: boolean;
    onSuccess?: () => void;
    onPaymentConfirmed?: (payment: ManualCardSessionResult) => boolean | void | Promise<boolean | void>;
    onDone?: () => void;
}

interface ManualCardCollectionCallbacksArgs {
    setManualCardOpen: (open: boolean) => void;
    setCollectionOpen: (open: boolean) => void;
    onPaymentConfirmed?: (payment: ManualCardSessionResult) => boolean | void | Promise<boolean | void>;
    onDone?: () => void;
}

export function createManualCardCollectionCallbacks({
    setManualCardOpen,
    setCollectionOpen,
    onPaymentConfirmed,
    onDone,
}: ManualCardCollectionCallbacksArgs) {
    return {
        onPaymentConfirmed: (payment: ManualCardSessionResult) => onPaymentConfirmed?.(payment),
        onDone: () => {
            setManualCardOpen(false);
            setCollectionOpen(false);
            onDone?.();
        },
    };
}

// Client mirror of the server-side `assertAdhocAmount` (STRIPE-ADHOC-PAY-001 §4.4).
// Source of truth is the server; this is UX-only. Returns an error string or null.
const MIN_AMOUNT = 0.5;
const MAX_AMOUNT = 100000;
function validateAmount(raw: string): string | null {
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n) || n < MIN_AMOUNT) return 'Amount must be at least $0.50';
    if (n > MAX_AMOUNT) return 'Amount exceeds the $100,000 limit';
    return null;
}

// Client mirror of the server email shape (stripePaymentsService RECEIPT_EMAIL_SHAPE). UX-only.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type SendChannel = 'email' | 'sms';

/**
 * CollectPaymentDialog (STRIPE-ADHOC-PAY-001, FR-DLG) — collect an arbitrary card amount
 * on a job with NO invoice. FORM-CANON right-side panel (auto bottom-sheet on mobile):
 * amount step (prefilled to the job outstanding, editable) → method chooser:
 *   • Enter card manually → generalized ManualCardDialog with { jobId, amount }
 *   • Send payment link   → opens the send sub-form (PAYLINK-SEND-001): pick email/text,
 *                           edit the prefilled+masked recipient, then Send.
 *   • Copy payment link   → jobStripeApi.createLink → clipboard
 */
export function CollectPaymentDialog({
    open,
    onOpenChange,
    jobId,
    outstanding,
    hasInvoices,
    contactEmail,
    contactPhone,
    hasContact,
    onSuccess,
    onPaymentConfirmed,
    onDone,
}: Props) {
    const [amount, setAmount] = useState('');
    const [busy, setBusy] = useState<null | 'send' | 'copy'>(null);
    const [manualCardOpen, setManualCardOpen] = useState(false);

    // PAYLINK-SEND-001: the "Send payment link" card opens a send sub-form instead of
    // dispatching immediately — the operator picks the channel and edits the recipient.
    const [mode, setMode] = useState<'choose' | 'send'>('choose');
    const [channel, setChannel] = useState<SendChannel>('email');
    const [email, setEmail] = useState('');
    const [phone, setPhone] = useState('');

    // Prefill on each open: amount from outstanding (editable), recipient from the job
    // contact, and default the channel to whichever contact field we actually have.
    useEffect(() => {
        if (!open) return;
        setAmount(outstanding > 0 ? outstanding.toFixed(2) : '');
        setMode('choose');
        setBusy(null);
        const em = (contactEmail || '').trim();
        const ph = contactPhone ? formatUSPhone(contactPhone) : '';
        setEmail(em);
        setPhone(ph);
        setChannel(em ? 'email' : (ph ? 'sms' : 'email'));
    }, [open, outstanding, contactEmail, contactPhone]);

    const error = validateAmount(amount);
    const amountNum = error ? undefined : Number(amount);
    const manualCardCallbacks = createManualCardCollectionCallbacks({
        setManualCardOpen,
        setCollectionOpen: onOpenChange,
        onPaymentConfirmed,
        onDone,
    });

    // Round to 2dp on blur so the value submitted matches server expectations.
    const roundOnBlur = () => {
        const n = Number(amount);
        if (amount.trim() !== '' && Number.isFinite(n)) setAmount(n.toFixed(2));
    };

    // Shared error handling for the link flows: honest toast + always offer "Copy link instead".
    const offerCopyInstead = () => {
        toast.error('Copy the link instead — that hand-off always works.', {
            action: { label: 'Copy link instead', onClick: () => copyLink() },
        });
    };

    const copyLink = async () => {
        if (error || amountNum == null) return;
        setBusy('copy');
        try {
            const link = await jobStripeApi.createLink(jobId, amountNum);
            await navigator.clipboard.writeText(link.url).catch(() => {});
            toast.success('Payment link copied');
            onSuccess?.();
        } catch (e: any) {
            const msg = String(e?.message || '');
            toast.error(/not ready|NOT_READY/i.test(msg) ? 'Connect Stripe in Integrations to collect online payments' : (msg || 'Could not create payment link'));
        } finally {
            setBusy(null);
        }
    };

    const recipientError = (): string | null => {
        if (channel === 'email') return EMAIL_SHAPE.test(email.trim()) ? null : 'Enter a valid email address';
        return isValidUSPhone(phone) ? null : 'Enter a valid phone number';
    };

    const doSend = async () => {
        if (error || amountNum == null) return;
        const rErr = recipientError();
        if (rErr) { toast.error(rErr); return; }
        const recipient = channel === 'email' ? email.trim() : toE164(phone);
        setBusy('send');
        try {
            // Send at the chosen amount to the operator-picked channel + recipient.
            await jobStripeApi.sendLink(jobId, { amount: amountNum, channel, recipient });
            toast.success(channel === 'email'
                ? `Payment link sent to ${email.trim()}`
                : `Payment link texted to ${formatUSPhone(phone)}`);
            onSuccess?.();
            onOpenChange(false);
        } catch (e: any) {
            const msg = String(e?.message || '');
            const code = /NO_CONTACT|NO_PROXY|NO_PHONE|MAILBOX_NOT_CONNECTED|WALLET_BLOCKED/i.test(msg);
            if (code) {
                toast.error(msg, { action: { label: 'Copy link instead', onClick: () => copyLink() } });
            } else if (/not ready|NOT_READY/i.test(msg)) {
                toast.error('Connect Stripe in Integrations to collect online payments');
            } else {
                // Unknown failure — the reliable hand-off is always a copied link.
                offerCopyInstead();
            }
        } finally {
            setBusy(null);
        }
    };

    return (
        <>
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent variant="panel">
                    <DialogPanelHeader>
                        <DialogTitle
                            className="text-[22px] font-semibold leading-tight"
                            style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                        >
                            Collect payment
                        </DialogTitle>
                        <DialogDescription className="sr-only">
                            Charge a card or send a payment link for this job — no invoice required.
                        </DialogDescription>
                    </DialogPanelHeader>

                    <DialogBody className="md:px-8 md:py-7">
                        <div className="mx-auto w-full max-w-[740px] space-y-6">
                            {/* Amount step */}
                            <div className="space-y-3.5">
                                <FloatingField
                                    label="Amount (USD)"
                                    type="text"
                                    inputMode="numeric"
                                    value={amount}
                                    onChange={e => {
                                        const masked = maskMoneyDigits(e.target.value);
                                        if (masked !== null) setAmount(masked);
                                    }}
                                    onBlur={roundOnBlur}
                                    className="tabular-nums"
                                />
                                {amount.trim() !== '' && error && (
                                    <p className="text-sm text-red-600">{error}</p>
                                )}
                            </div>

                            {mode === 'choose' ? (
                                /* Method chooser */
                                <div className="space-y-3.5">
                                    <p className="blanc-eyebrow">Choose a method</p>
                                    <div className="space-y-3.5">
                                        <button
                                            type="button"
                                            disabled={!!error || busy != null}
                                            onClick={() => setManualCardOpen(true)}
                                            className="flex w-full items-center gap-3 rounded-2xl border border-[var(--blanc-line)] px-4 py-4 text-left transition-colors hover:border-[var(--blanc-ink-3)] disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            <CreditCard className="size-4 shrink-0 text-[var(--blanc-ink-3)]" />
                                            <span className="min-w-0">
                                                <span className="block text-sm font-medium text-[var(--blanc-ink-1)]">Enter card manually</span>
                                                <span className="block text-xs text-[var(--blanc-ink-2)]">Key the card into Stripe's secure form now.</span>
                                            </span>
                                        </button>

                                        <button
                                            type="button"
                                            disabled={!!error || busy != null}
                                            onClick={() => setMode('send')}
                                            className="flex w-full items-center gap-3 rounded-2xl border border-[var(--blanc-line)] px-4 py-4 text-left transition-colors hover:border-[var(--blanc-ink-3)] disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            <Send className="size-4 shrink-0 text-[var(--blanc-ink-3)]" />
                                            <span className="min-w-0">
                                                <span className="block text-sm font-medium text-[var(--blanc-ink-1)]">Send payment link</span>
                                                <span className="block text-xs text-[var(--blanc-ink-2)]">Text or email the customer a hosted Stripe link.</span>
                                            </span>
                                        </button>

                                        <button
                                            type="button"
                                            disabled={!!error || busy != null}
                                            onClick={copyLink}
                                            className="flex w-full items-center gap-3 rounded-2xl border border-[var(--blanc-line)] px-4 py-4 text-left transition-colors hover:border-[var(--blanc-ink-3)] disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            {busy === 'copy'
                                                ? <Loader2 className="size-4 shrink-0 animate-spin text-[var(--blanc-ink-3)]" />
                                                : <Copy className="size-4 shrink-0 text-[var(--blanc-ink-3)]" />}
                                            <span className="min-w-0">
                                                <span className="block text-sm font-medium text-[var(--blanc-ink-1)]">Copy payment link</span>
                                                <span className="block text-xs text-[var(--blanc-ink-2)]">Copy a hosted Stripe link to your clipboard.</span>
                                            </span>
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                /* PAYLINK-SEND-001 — send sub-form: pick channel, edit recipient, send. */
                                <div className="space-y-3.5">
                                    <p className="blanc-eyebrow">Send payment link</p>

                                    {/* Channel segmented control */}
                                    <div className="grid grid-cols-2 gap-1 rounded-full bg-[var(--blanc-field)] p-1">
                                        {([
                                            { key: 'email' as const, label: 'Email', Icon: Mail },
                                            { key: 'sms' as const, label: 'Text message', Icon: MessageSquare },
                                        ]).map(({ key, label, Icon }) => {
                                            const active = channel === key;
                                            return (
                                                <button
                                                    key={key}
                                                    type="button"
                                                    disabled={busy != null}
                                                    onClick={() => setChannel(key)}
                                                    className={`flex items-center justify-center gap-2 rounded-full py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
                                                        active
                                                            ? 'bg-[var(--blanc-surface-strong)] text-[var(--blanc-ink-1)] shadow-sm'
                                                            : 'text-[var(--blanc-ink-2)] hover:text-[var(--blanc-ink-1)]'
                                                    }`}
                                                >
                                                    <Icon className="size-4" />
                                                    {label}
                                                </button>
                                            );
                                        })}
                                    </div>

                                    {/* Recipient — prefilled from the contact, editable, masked (phone) */}
                                    {channel === 'email' ? (
                                        <FloatingField
                                            label="Send to email"
                                            type="email"
                                            inputMode="email"
                                            value={email}
                                            onChange={e => setEmail(e.target.value)}
                                        />
                                    ) : (
                                        <PhoneInput
                                            id="collect-pay-phone"
                                            label="Send to phone"
                                            value={phone}
                                            onChange={setPhone}
                                        />
                                    )}

                                    <p className="text-xs text-[var(--blanc-ink-2)]">
                                        The customer gets a hosted Stripe link{amountNum != null ? ` for $${amountNum.toFixed(2)}` : ''}.
                                    </p>

                                    <div className="flex items-center gap-2 pt-1">
                                        <Button
                                            variant="ghost"
                                            onClick={() => setMode('choose')}
                                            disabled={busy != null}
                                            className="gap-1.5"
                                        >
                                            <ArrowLeft className="size-4" /> Back
                                        </Button>
                                        <Button
                                            onClick={doSend}
                                            disabled={!!error || busy != null || !!recipientError()}
                                            className="ml-auto gap-1.5"
                                        >
                                            {busy === 'send'
                                                ? <Loader2 className="size-4 animate-spin" />
                                                : <Send className="size-4" />}
                                            Send link
                                        </Button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </DialogBody>

                    <DialogPanelFooter>
                        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy != null}>Close</Button>
                    </DialogPanelFooter>
                </DialogContent>
            </Dialog>

            {/* Keyed card entry — reuses the generalized ManualCardDialog with { jobId, amount } */}
            <ManualCardDialog
                open={manualCardOpen}
                onOpenChange={setManualCardOpen}
                jobId={jobId}
                amount={amountNum}
                balanceBefore={outstanding}
                jobHasInvoices={hasInvoices}
                contactEmail={contactEmail}
                hasContact={hasContact}
                onPaymentConfirmed={manualCardCallbacks.onPaymentConfirmed}
                onDone={manualCardCallbacks.onDone}
            />
        </>
    );
}
