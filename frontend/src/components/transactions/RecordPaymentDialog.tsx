import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import type { CreateTransactionData } from '../../services/paymentsCanonicalApi';

// -- Props --------------------------------------------------------------------

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSave: (data: CreateTransactionData) => Promise<any>;
    defaultInvoiceId?: number | null;
    defaultContactId?: number | null;
}

// -- Component ----------------------------------------------------------------

export function RecordPaymentDialog({ open, onOpenChange, onSave, defaultInvoiceId, defaultContactId }: Props) {
    const [amount, setAmount] = useState('');
    const [paymentMethod, setPaymentMethod] = useState<CreateTransactionData['payment_method']>('cash');
    const [invoiceId, setInvoiceId] = useState(defaultInvoiceId ? String(defaultInvoiceId) : '');
    const [contactId, setContactId] = useState(defaultContactId ? String(defaultContactId) : '');
    const [referenceNumber, setReferenceNumber] = useState('');
    const [memo, setMemo] = useState('');
    const [saving, setSaving] = useState(false);

    const resetForm = () => {
        setAmount('');
        setPaymentMethod('cash');
        setInvoiceId(defaultInvoiceId ? String(defaultInvoiceId) : '');
        setContactId(defaultContactId ? String(defaultContactId) : '');
        setReferenceNumber('');
        setMemo('');
    };

    const handleSave = async () => {
        if (!amount.trim() || Number(amount) <= 0) return;
        setSaving(true);
        try {
            const data: CreateTransactionData = {
                transaction_type: 'payment',
                payment_method: paymentMethod,
                amount: amount.trim(),
            };
            if (invoiceId.trim()) data.invoice_id = Number(invoiceId);
            if (contactId.trim()) data.contact_id = Number(contactId);
            if (referenceNumber.trim()) data.reference_number = referenceNumber.trim();
            if (memo.trim()) data.memo = memo.trim();

            await onSave(data);
            resetForm();
            onOpenChange(false);
        } catch {
            // error toast handled upstream
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={v => { onOpenChange(v); if (!v) resetForm(); }}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Record Payment</DialogTitle>
                </DialogHeader>

                <div className="space-y-4 py-2">
                    {/* Amount */}
                    <div>
                        <Label className="text-xs">Amount *</Label>
                        <Input
                            type="number"
                            step="0.01"
                            min="0.01"
                            placeholder="0.00"
                            value={amount}
                            onChange={e => setAmount(e.target.value)}
                        />
                    </div>

                    {/* Payment Method */}
                    <div>
                        <Label className="text-xs">Payment Method</Label>
                        <Select value={paymentMethod} onValueChange={v => setPaymentMethod(v as CreateTransactionData['payment_method'])}>
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="cash">Cash</SelectItem>
                                <SelectItem value="check">Check</SelectItem>
                                <SelectItem value="credit_card">Credit Card</SelectItem>
                                <SelectItem value="ach">ACH</SelectItem>
                                <SelectItem value="other">Other</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    {/* Invoice ID */}
                    <div>
                        <Label className="text-xs">Invoice ID (optional)</Label>
                        <Input
                            type="number"
                            placeholder="e.g. 1234"
                            value={invoiceId}
                            onChange={e => setInvoiceId(e.target.value)}
                        />
                    </div>

                    {/* Contact ID */}
                    <div>
                        <Label className="text-xs">Contact ID (optional)</Label>
                        <Input
                            type="number"
                            placeholder="e.g. 567"
                            value={contactId}
                            onChange={e => setContactId(e.target.value)}
                        />
                    </div>

                    {/* Reference Number */}
                    <div>
                        <Label className="text-xs">Reference Number (optional)</Label>
                        <Input
                            placeholder="Check #, confirmation code, etc."
                            value={referenceNumber}
                            onChange={e => setReferenceNumber(e.target.value)}
                        />
                    </div>

                    {/* Memo */}
                    <div>
                        <Label className="text-xs">Memo / Notes (optional)</Label>
                        <Textarea
                            placeholder="Add notes about this payment..."
                            rows={3}
                            value={memo}
                            onChange={e => setMemo(e.target.value)}
                        />
                    </div>
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => { onOpenChange(false); resetForm(); }} disabled={saving}>
                        Cancel
                    </Button>
                    <Button onClick={handleSave} disabled={saving || !amount.trim() || Number(amount) <= 0}>
                        {saving ? 'Saving...' : 'Record Payment'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
