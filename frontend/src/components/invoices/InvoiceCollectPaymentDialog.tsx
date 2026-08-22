import { useEffect, useMemo, useRef, useState } from 'react';
import { CreditCard, DollarSign, FileText, Link2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { InvoiceCapabilities } from '../../hooks/useInvoice';
import type { Invoice } from '../../services/invoicesApi';
import { recordInvoicePayment } from '../../services/paymentsCanonicalApi';
import { invoiceStripeApi } from '../../services/stripePaymentsApi';
import { Button } from '../ui/button';
import {
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogPanelFooter,
    DialogPanelHeader,
    DialogTitle,
} from '../ui/dialog';
import { FloatingLabel } from '../ui/floating-field';
import { MoneyInput } from '../ui/MoneyInput';
import ManualCardDialog from './ManualCardDialog';

export type InvoiceCollectionMethod = 'card' | 'cash' | 'check' | 'link';

type CollectionCapabilities = Pick<
    InvoiceCapabilities,
    'canCollectKeyed' | 'canCollectOffline' | 'canCollectOnline'
>;

export function invoiceCollectionMethods(
    capabilities: CollectionCapabilities,
): InvoiceCollectionMethod[] {
    return [
        ...(capabilities.canCollectKeyed ? ['card' as const] : []),
        ...(capabilities.canCollectOffline ? ['cash' as const, 'check' as const] : []),
        ...(capabilities.canCollectOnline ? ['link' as const] : []),
    ];
}

export function validateInvoiceCollectionAmount(amount: string, balanceDue: number): string | null {
    const numeric = Number(amount);
    const amountCents = Number.isFinite(numeric) ? Math.round(numeric * 100) : NaN;
    const balanceCents = Math.round(balanceDue * 100);
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
        return 'Enter an amount greater than $0.00.';
    }
    if (amountCents > balanceCents) {
        return 'Amount cannot exceed the invoice balance.';
    }
    return null;
}

function money(value: number): string {
    return '$' + value.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

const METHOD_OPTIONS: Array<{
    id: InvoiceCollectionMethod;
    label: string;
    Icon: typeof CreditCard;
}> = [
    { id: 'card', label: 'Card', Icon: CreditCard },
    { id: 'cash', label: 'Cash', Icon: DollarSign },
    { id: 'check', label: 'Check', Icon: FileText },
    { id: 'link', label: 'Pay link', Icon: Link2 },
];

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    invoice: Invoice;
    capabilities: CollectionCapabilities;
    onPaymentConfirmed?: () => boolean | void | Promise<boolean | void>;
}

export function InvoiceCollectPaymentDialog({
    open,
    onOpenChange,
    invoice,
    capabilities,
    onPaymentConfirmed,
}: Props) {
    const balanceDue = Math.max(0, Number(invoice.balance_due) || 0);
    const methods = useMemo(() => invoiceCollectionMethods(capabilities), [
        capabilities.canCollectKeyed,
        capabilities.canCollectOffline,
        capabilities.canCollectOnline,
    ]);
    const initializedRef = useRef(false);
    const submitLockRef = useRef(false);
    const [amount, setAmount] = useState('0.00');
    const [method, setMethod] = useState<InvoiceCollectionMethod>('card');
    const [submitting, setSubmitting] = useState(false);
    const [manualCardOpen, setManualCardOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) {
            initializedRef.current = false;
            setManualCardOpen(false);
            return;
        }
        if (initializedRef.current) return;
        initializedRef.current = true;
        setAmount(balanceDue.toFixed(2));
        setMethod(methods[0] || 'card');
        setSubmitting(false);
        submitLockRef.current = false;
        setError(null);
    }, [
        balanceDue,
        methods,
        open,
    ]);

    const amountError = validateInvoiceCollectionAmount(amount, balanceDue);
    const numericAmount = Number(amount) || 0;

    const finishPayment = async () => {
        await onPaymentConfirmed?.();
        onOpenChange(false);
    };

    const submit = async () => {
        if (submitLockRef.current) return;
        if (amountError) {
            setError(amountError);
            return;
        }
        if (!methods.includes(method)) {
            setError('Choose an available payment method.');
            return;
        }
        if (method === 'card') {
            setManualCardOpen(true);
            return;
        }

        submitLockRef.current = true;
        setSubmitting(true);
        setError(null);
        try {
            if (method === 'cash' || method === 'check') {
                await recordInvoicePayment(invoice.id, {
                    amount: numericAmount,
                    payment_method: method,
                });
                toast.success('Payment recorded');
                await finishPayment();
                return;
            }

            const link = await invoiceStripeApi.createLink(invoice.id, numericAmount);
            if (!navigator.clipboard?.writeText) {
                throw new Error('Payment link created, but this browser cannot copy it. Try again to retrieve the same link.');
            }
            await navigator.clipboard.writeText(link.url);
            toast.success('Payment link copied');
            onOpenChange(false);
        } catch (caught) {
            const message = caught instanceof Error ? caught.message : 'Could not collect payment';
            setError(message);
            toast.error(message);
        } finally {
            submitLockRef.current = false;
            setSubmitting(false);
        }
    };

    const selectedAction = method === 'card'
        ? `Charge ${money(numericAmount)}`
        : method === 'link'
            ? `Create pay link for ${money(numericAmount)}`
            : `Record ${money(numericAmount)}`;
    const SelectedIcon = METHOD_OPTIONS.find(option => option.id === method)?.Icon || CreditCard;
    const displayedError = error || amountError;

    const actionButtons = (
        <div className="space-y-2.5">
            <Button
                type="button"
                size="action" className="h-[52px] w-full rounded-[15px] text-[16px]"
                onClick={() => void submit()}
                disabled={submitting || !!amountError || methods.length === 0}
                data-testid="collect-charge"
            >
                {submitting ? <Loader2 className="size-5 animate-spin" /> : <SelectedIcon className="size-5" />}
                {submitting ? 'Working…' : selectedAction}
            </Button>
            <Button
                type="button"
                variant="outline"
                size="action" className="h-[46px] w-full rounded-[14px] text-[15px]"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
            >
                Cancel
            </Button>
        </div>
    );

    return (
        <>
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent variant="panel" size="default" data-testid="invoice-collect-dialog">
                    <DialogPanelHeader className="max-md:hidden">
                        <DialogTitle
                            className="text-[22px] font-semibold leading-tight text-[var(--blanc-ink-1)]"
                            style={{ fontFamily: 'var(--blanc-font-heading)' }}
                        >
                            Collect payment
                        </DialogTitle>
                        <DialogDescription>
                            {invoice.invoice_number} · {invoice.contact_name || 'Customer'}
                        </DialogDescription>
                    </DialogPanelHeader>

                    <DialogBody className="px-5 pb-6 pt-9 md:px-8 md:py-7">
                        <div className="mx-auto w-full max-w-[520px]">
                            <div className="mb-3 md:hidden">
                                <h3
                                    className="text-[20px] font-semibold leading-tight text-[var(--blanc-ink-1)]"
                                    style={{ fontFamily: 'var(--blanc-font-heading)' }}
                                >
                                    Collect payment
                                </h3>
                                <p className="mt-1 text-[12px] text-[var(--blanc-ink-3)]">
                                    {invoice.invoice_number} · {invoice.contact_name || 'Customer'}
                                </p>
                            </div>

                            <FloatingLabel label="Amount" filled>
                                <span
                                    className="pointer-events-none absolute left-3.5 top-[33px] z-[1] -translate-y-1/2 text-[15px] font-medium text-[var(--blanc-ink-1)]"
                                    aria-hidden="true"
                                >
                                    $
                                </span>
                                <MoneyInput
                                    value={amount}
                                    onValueChange={next => {
                                        setAmount(next || '0.00');
                                        setError(null);
                                    }}
                                    className="h-[50px] w-full rounded-xl border-[1.5px] border-transparent bg-transparent pl-7 pr-3.5 text-[15px] font-medium text-[var(--blanc-ink-1)] outline-none focus:border-[var(--blanc-line-strong)]"
                                    disabled={submitting}
                                    data-testid="collect-amount"
                                    aria-invalid={!!displayedError}
                                />
                            </FloatingLabel>
                            {displayedError ? (
                                <p className="mt-2 text-[12px] text-[var(--blanc-danger)]" role="alert">
                                    {displayedError}
                                </p>
                            ) : null}

                            <p className="blanc-eyebrow mx-0.5 mb-0 mt-4">Method</p>
                            <div className="mt-2.5 grid grid-cols-2 gap-2.5" data-testid="collect-method">
                                {METHOD_OPTIONS.filter(option => methods.includes(option.id)).map(option => {
                                    const selected = option.id === method;
                                    const Icon = option.Icon;
                                    return (
                                        <button
                                            key={option.id}
                                            type="button"
                                            className={`flex h-[50px] items-center gap-2.5 rounded-[13px] border-[1.5px] px-3 text-[14px] font-semibold ${selected
                                                ? 'border-[var(--blanc-accent)] bg-[var(--blanc-accent-soft)] text-[var(--blanc-ink-1)]'
                                                : 'border-[var(--blanc-line)] text-[var(--blanc-ink-2)]'}`}
                                            onClick={() => {
                                                setMethod(option.id);
                                                setError(null);
                                            }}
                                            aria-pressed={selected}
                                            data-testid={`collect-method-${option.id}`}
                                        >
                                            <Icon className="size-[18px] text-[var(--blanc-accent)]" />
                                            {option.label}
                                        </button>
                                    );
                                })}
                            </div>

                            <div className="mt-4 md:hidden">{actionButtons}</div>
                        </div>
                    </DialogBody>

                    <DialogPanelFooter className="max-md:hidden">
                        <div className="ml-auto w-full max-w-[360px]">{actionButtons}</div>
                    </DialogPanelFooter>
                </DialogContent>
            </Dialog>

            <ManualCardDialog
                open={manualCardOpen}
                onOpenChange={setManualCardOpen}
                invoiceId={invoice.id}
                amount={numericAmount}
                balanceBefore={balanceDue}
                contactEmail={invoice.contact_email}
                hasContact={invoice.contact_id != null}
                onPaymentConfirmed={async () => {
                    return await onPaymentConfirmed?.();
                }}
                onDone={() => onOpenChange(false)}
            />
        </>
    );
}
