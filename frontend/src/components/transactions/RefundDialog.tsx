import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
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
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Refund Transaction</DialogTitle>
                </DialogHeader>

                <div className="space-y-4 py-2">
                    {/* Original info */}
                    <div className="bg-muted/50 rounded p-3 space-y-1">
                        <div className="flex justify-between text-sm">
                            <span className="text-muted-foreground">Transaction</span>
                            <span className="font-mono">#{transaction.id}</span>
                        </div>
                        <div className="flex justify-between text-sm">
                            <span className="text-muted-foreground">Original Amount</span>
                            <span className="font-semibold">{money(transaction.amount)}</span>
                        </div>
                        <div className="flex justify-between text-sm">
                            <span className="text-muted-foreground">Method</span>
                            <span className="capitalize">{transaction.payment_method.replace('_', ' ')}</span>
                        </div>
                    </div>

                    {/* Refund amount */}
                    <div>
                        <Label className="text-xs">Refund Amount (max {money(transaction.amount)})</Label>
                        <Input
                            type="number"
                            step="0.01"
                            min="0.01"
                            max={transaction.amount}
                            value={amount}
                            onChange={e => setAmount(e.target.value)}
                        />
                        {currentAmount > maxAmount && (
                            <p className="text-xs text-red-500 mt-1">Amount cannot exceed original transaction</p>
                        )}
                    </div>

                    {/* Reason */}
                    <div>
                        <Label className="text-xs">Reason (optional)</Label>
                        <Textarea
                            placeholder="Reason for refund..."
                            rows={3}
                            value={reason}
                            onChange={e => setReason(e.target.value)}
                        />
                    </div>
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={processing}>
                        Cancel
                    </Button>
                    <Button variant="destructive" onClick={handleRefund} disabled={processing || !isValid}>
                        {processing ? 'Processing...' : `Refund ${money(amount)}`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
