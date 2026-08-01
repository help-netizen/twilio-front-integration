import { useEffect, useState } from 'react';
import { CircleCheckBig } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import {
    Dialog, DialogContent, DialogDescription,
    DialogPanelHeader, DialogBody, DialogPanelFooter, DialogTitle,
} from '../ui/dialog';
import { FloatingField } from '../ui/floating-field';
import { maskMoneyDigits } from '../ui/MoneyInput';
import { FloatingTextField } from '../shared/FloatingTextField';
import { sendReceipt, type PaymentTransaction } from '../../services/paymentsCanonicalApi';
import { FloatingSelect } from '../ui/floating-select';
import { SelectItem } from '../ui/select';
import * as paymentsApi from '../../services/paymentsCanonicalApi';

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    jobId: number | string;
    outstanding: number;
    onSuccess?: () => void;
}

type OfflinePaymentMethod = 'cash' | 'check';

function todayLocal(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function JobRecordPaymentDialog({ open, onOpenChange, jobId, outstanding, onSuccess }: Props) {
    const [amount, setAmount] = useState('');
    const [paymentMethod, setPaymentMethod] = useState<OfflinePaymentMethod>('cash');
    const [referenceNumber, setReferenceNumber] = useState('');
    const [paymentDate, setPaymentDate] = useState(todayLocal);
    const [memo, setMemo] = useState('');
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        if (!open) return;
        setAmount(outstanding > 0 ? String(outstanding) : '');
        setPaymentMethod('cash');
        setReferenceNumber('');
        setPaymentDate(todayLocal());
        setMemo('');
        setSubmitting(false);
        setRecorded(null);
        setReceiptEmail('');
        setReceiptPhase('idle');
    }, [open, outstanding]);

    // RECORD-PAY-RECEIPT-001: success screen with Send receipt, mirroring the
    // card-payment success view — cash/check payers get a receipt too.
    const [recorded, setRecorded] = useState<PaymentTransaction | null>(null);
    const [receiptEmail, setReceiptEmail] = useState('');
    const [receiptPhase, setReceiptPhase] = useState<'idle' | 'sending' | 'sent'>('idle');

    const handleSendReceipt = async () => {
        if (!recorded || !receiptEmail.trim() || receiptPhase === 'sending') return;
        setReceiptPhase('sending');
        try {
            await sendReceipt(recorded.id, { channel: 'email', recipient: receiptEmail.trim() });
            setReceiptPhase('sent');
        } catch (err) {
            setReceiptPhase('idle');
            toast.error(err instanceof Error ? err.message : 'Could not send the receipt');
        }
    };

    const handleSubmit = async () => {
        const numericAmount = Number(amount);
        if (!(numericAmount > 0)) return;

        setSubmitting(true);
        try {
            const txn = await paymentsApi.recordJobPayment(jobId, {
                amount: numericAmount,
                payment_method: paymentMethod,
                reference_number: referenceNumber || undefined,
                payment_date: paymentDate || undefined,
                memo: memo || undefined,
            });
            toast.success('Payment recorded');
            onSuccess?.();
            setRecorded(txn);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to record payment');
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
                        Record payment
                    </DialogTitle>
                    <DialogDescription className="sr-only">
                        Record a cash or check payment for this job.
                    </DialogDescription>
                </DialogPanelHeader>

                <DialogBody className="md:px-8 md:py-7">
                    {recorded ? (
                        <div className="mx-auto flex w-full max-w-[740px] flex-col items-center py-8 text-center">
                            <CircleCheckBig className="size-16 text-[var(--blanc-success)]" strokeWidth={1.6} aria-hidden="true" />
                            <h2 className="mt-4 text-2xl font-semibold text-[var(--blanc-ink-1)]" style={{ fontFamily: 'var(--blanc-font-heading)' }}>
                                Payment recorded
                            </h2>
                            <p className="mt-3 text-xl font-semibold text-[var(--blanc-ink-1)]">Paid ${Number(recorded.amount).toFixed(2)}</p>
                            <p className="mt-1 text-sm capitalize text-[var(--blanc-ink-2)]">{String(recorded.payment_method || paymentMethod)}</p>
                            <div className="mt-6 w-full max-w-md space-y-3.5 text-left">
                                {receiptPhase === 'sent' ? (
                                    <p className="flex items-center justify-center gap-2 text-sm font-medium text-[var(--blanc-success)]" role="status">
                                        <CircleCheckBig className="size-4 shrink-0" aria-hidden="true" />
                                        <span>Receipt sent to {receiptEmail.trim()}</span>
                                    </p>
                                ) : (
                                    <>
                                        <FloatingTextField
                                            label="Customer email"
                                            inputMode="email"
                                            autoComplete="off"
                                            value={receiptEmail}
                                            onChange={event => setReceiptEmail((event.target as HTMLInputElement).value)}
                                            disabled={receiptPhase === 'sending'}
                                            onSubmit={handleSendReceipt}
                                            submitting={receiptPhase === 'sending'}
                                            canSubmit={Boolean(receiptEmail.trim())}
                                        />
                                        <Button type="button" variant="secondary" className="w-full" onClick={handleSendReceipt} disabled={receiptPhase === 'sending' || !receiptEmail.trim()}>
                                            {receiptPhase === 'sending' ? 'Sending receipt…' : 'Send receipt'}
                                        </Button>
                                    </>
                                )}
                            </div>
                        </div>
                    ) : (
                    <div className="mx-auto w-full max-w-[740px] space-y-6">
                        <div className="space-y-3.5">
                            <FloatingField
                                label="Amount"
                                type="text"
                                inputMode="numeric"
                                value={amount}
                                onChange={event => {
                                    const masked = maskMoneyDigits(event.target.value);
                                    if (masked !== null) setAmount(masked);
                                }}
                            />
                            <FloatingSelect
                                label="Payment method"
                                value={paymentMethod}
                                onValueChange={value => setPaymentMethod(value as OfflinePaymentMethod)}
                            >
                                <SelectItem value="cash">Cash</SelectItem>
                                <SelectItem value="check">Check</SelectItem>
                            </FloatingSelect>
                            <FloatingField
                                label="Reference number"
                                value={referenceNumber}
                                onChange={event => setReferenceNumber(event.target.value)}
                            />
                            <FloatingField
                                label="Payment date"
                                type="date"
                                value={paymentDate}
                                onChange={event => setPaymentDate(event.target.value)}
                            />
                            <FloatingField
                                label="Internal note"
                                textarea
                                rows={4}
                                value={memo}
                                onChange={event => setMemo(event.target.value)}
                            />
                        </div>
                    </div>
                    )}
                </DialogBody>

                <DialogPanelFooter>
                    {recorded ? (
                        <Button onClick={() => onOpenChange(false)}>Done</Button>
                    ) : (<>
                    <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
                        Cancel
                    </Button>
                    <Button type="button" onClick={handleSubmit} disabled={submitting || !(Number(amount) > 0)}>
                        {submitting ? 'Recording...' : 'Record payment'}
                    </Button>
                </>)}
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}
