import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import {
    Dialog, DialogContent, DialogDescription,
    DialogPanelHeader, DialogBody, DialogPanelFooter, DialogTitle,
} from '../ui/dialog';
import { FloatingField } from '../ui/floating-field';
import { maskMoneyDigits } from '../ui/MoneyInput';
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
    }, [open, outstanding]);

    const handleSubmit = async () => {
        const numericAmount = Number(amount);
        if (!(numericAmount > 0)) return;

        setSubmitting(true);
        try {
            await paymentsApi.recordJobPayment(jobId, {
                amount: numericAmount,
                payment_method: paymentMethod,
                reference_number: referenceNumber || undefined,
                payment_date: paymentDate || undefined,
                memo: memo || undefined,
            });
            toast.success('Payment recorded');
            onSuccess?.();
            onOpenChange(false);
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
                </DialogBody>

                <DialogPanelFooter>
                    <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
                        Cancel
                    </Button>
                    <Button type="button" onClick={handleSubmit} disabled={submitting || !(Number(amount) > 0)}>
                        {submitting ? 'Recording...' : 'Record payment'}
                    </Button>
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}
