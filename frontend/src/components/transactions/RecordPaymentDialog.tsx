import { useState } from 'react';
import { Dialog, DialogContent, DialogPanelHeader, DialogBody, DialogPanelFooter, DialogTitle, DialogDescription } from '../ui/dialog';
import { Button } from '../ui/button';
import { FloatingField } from '../ui/floating-field';
import { FloatingSelect } from '../ui/floating-select';
import { SelectItem } from '../ui/select';
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
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle
                        className="text-[22px] font-semibold leading-tight"
                        style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                    >
                        Record payment
                    </DialogTitle>
                    <DialogDescription className="sr-only">Record a manual payment transaction</DialogDescription>
                </DialogPanelHeader>

                <DialogBody className="md:px-8 md:py-7">
                  <div className="mx-auto w-full max-w-[740px] space-y-6">
                    <div className="space-y-3.5">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                            <FloatingField
                                id="rpd-amount"
                                label="Amount"
                                inputMode="decimal"
                                value={amount}
                                onChange={e => setAmount(e.target.value)}
                            />
                            <FloatingSelect
                                id="rpd-method"
                                label="Payment method"
                                value={paymentMethod}
                                onValueChange={v => setPaymentMethod(v as CreateTransactionData['payment_method'])}
                            >
                                <SelectItem value="cash">Cash</SelectItem>
                                <SelectItem value="check">Check</SelectItem>
                                <SelectItem value="credit_card">Credit Card</SelectItem>
                                <SelectItem value="ach">ACH</SelectItem>
                                <SelectItem value="other">Other</SelectItem>
                            </FloatingSelect>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                            <FloatingField
                                id="rpd-invoice"
                                label="Invoice number (optional)"
                                inputMode="numeric"
                                value={invoiceId}
                                onChange={e => setInvoiceId(e.target.value)}
                            />
                            <FloatingField
                                id="rpd-contact"
                                label="Customer (optional)"
                                inputMode="numeric"
                                value={contactId}
                                onChange={e => setContactId(e.target.value)}
                            />
                        </div>

                        <FloatingField
                            id="rpd-reference"
                            label="Reference number (optional)"
                            value={referenceNumber}
                            onChange={e => setReferenceNumber(e.target.value)}
                        />

                        <FloatingField
                            id="rpd-memo"
                            label="Memo / notes (optional)"
                            textarea
                            rows={3}
                            value={memo}
                            onChange={e => setMemo(e.target.value)}
                        />
                    </div>
                  </div>
                </DialogBody>

                <DialogPanelFooter>
                    <Button variant="ghost" onClick={() => { onOpenChange(false); resetForm(); }} disabled={saving}>
                        Cancel
                    </Button>
                    <Button onClick={handleSave} disabled={saving || !amount.trim() || Number(amount) <= 0}>
                        {saving ? 'Saving...' : 'Record payment'}
                    </Button>
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}
