import { useState } from 'react';
import { Dialog, DialogContent, DialogPanelHeader, DialogBody, DialogPanelFooter, DialogTitle, DialogDescription } from '../ui/dialog';
import { Button } from '../ui/button';
import { FloatingField } from '../ui/floating-field';
import type { PaymentTransaction, RefundData } from '../../services/paymentsCanonicalApi';

// -- Helpers ------------------------------------------------------------------

function money(value: string | number | null | undefined): string {
    if (value == null) return '$0.00';
    return '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// -- Props --------------------------------------------------------------------

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    transaction: PaymentTransaction;
    onRefund: (data: RefundData) => Promise<any>;
}

// -- Component ----------------------------------------------------------------

export function RefundDialog({ open, onOpenChange, transaction, onRefund }: Props) {
    const [amount, setAmount] = useState(transaction.amount);
    const [reason, setReason] = useState('');
    const [processing, setProcessing] = useState(false);

    const maxAmount = Number(transaction.amount);
    const currentAmount = Number(amount);
    const isValid = currentAmount > 0 && currentAmount <= maxAmount;

    const handleRefund = async () => {
        if (!isValid) return;
        setProcessing(true);
        try {
            const data: RefundData = { amount: amount.trim() };
            if (reason.trim()) data.reason = reason.trim();
            await onRefund(data);
            onOpenChange(false);
            setAmount(transaction.amount);
            setReason('');
        } catch {
            // error toast handled upstream
        } finally {
            setProcessing(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={v => { onOpenChange(v); if (!v) { setAmount(transaction.amount); setReason(''); } }}>
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle
                        className="text-[22px] font-semibold leading-tight"
                        style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                    >
                        Refund payment
                    </DialogTitle>
                    <DialogDescription className="sr-only">Refund part or all of a payment transaction</DialogDescription>
                </DialogPanelHeader>

                <DialogBody className="md:px-8 md:py-7">
                  <div className="mx-auto w-full max-w-[740px] space-y-6">
                    {/* Original info */}
                    <div
                        className="rounded-2xl p-4 space-y-1"
                        style={{ background: 'rgba(117, 106, 89, 0.04)' }}
                    >
                        <div className="flex justify-between text-sm">
                            <span style={{ color: 'var(--blanc-ink-3)' }}>Payment</span>
                            <span className="font-mono">#{transaction.id}</span>
                        </div>
                        <div className="flex justify-between text-sm">
                            <span style={{ color: 'var(--blanc-ink-3)' }}>Original amount</span>
                            <span className="font-semibold">{money(transaction.amount)}</span>
                        </div>
                        <div className="flex justify-between text-sm">
                            <span style={{ color: 'var(--blanc-ink-3)' }}>Method</span>
                            <span className="capitalize">{transaction.payment_method.replace('_', ' ')}</span>
                        </div>
                    </div>

                    {/* Refund amount + reason */}
                    <div className="space-y-3.5">
                        <div>
                            <FloatingField
                                id="rfd-amount"
                                label={`Refund amount (max ${money(transaction.amount)})`}
                                inputMode="decimal"
                                value={amount}
                                onChange={e => setAmount(e.target.value)}
                            />
                            {currentAmount > maxAmount && (
                                <p className="text-xs text-red-500 mt-1">Amount cannot exceed original transaction</p>
                            )}
                        </div>

                        <FloatingField
                            id="rfd-reason"
                            label="Reason (optional)"
                            textarea
                            rows={3}
                            value={reason}
                            onChange={e => setReason(e.target.value)}
                        />
                    </div>
                  </div>
                </DialogBody>

                <DialogPanelFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={processing}>
                        Cancel
                    </Button>
                    <Button variant="destructive" onClick={handleRefund} disabled={processing || !isValid}>
                        {processing ? 'Processing...' : `Refund ${money(amount)}`}
                    </Button>
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}
