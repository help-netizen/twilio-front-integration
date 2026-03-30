import { useState, useEffect, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { Checkbox } from '../ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Separator } from '../ui/separator';
import { Plus, Trash2 } from 'lucide-react';
import type { Invoice, InvoiceCreateData } from '../../services/invoicesApi';

// ── Item row type ────────────────────────────────────────────────────────────

interface LineItem {
    key: string;
    name: string;
    description: string;
    quantity: string;
    unit: string;
    unit_price: string;
    taxable: boolean;
}

function emptyItem(): LineItem {
    return {
        key: crypto.randomUUID(),
        name: '',
        description: '',
        quantity: '1',
        unit: '',
        unit_price: '0',
        taxable: true,
    };
}

function calcItemAmount(item: LineItem): number {
    return (parseFloat(item.quantity) || 0) * (parseFloat(item.unit_price) || 0);
}

function money(v: number): string {
    return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Props ────────────────────────────────────────────────────────────────────

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    invoice: Invoice | null;
    defaultJobId?: number;
    onSave: (data: InvoiceCreateData) => Promise<void>;
}

// ── Component ────────────────────────────────────────────────────────────────

export function InvoiceEditorDialog({ open, onOpenChange, invoice, defaultJobId, onSave }: Props) {
    const isEdit = !!invoice;

    // ── Form state ───────────────────────────────────────────────────────
    const [contactId, setContactId] = useState('');
    const [leadId, setLeadId] = useState('');
    const [jobId, setJobId] = useState('');
    const [estimateId, setEstimateId] = useState('');
    const [title, setTitle] = useState('');
    const [notes, setNotes] = useState('');
    const [internalNote, setInternalNote] = useState('');
    const [items, setItems] = useState<LineItem[]>([emptyItem()]);
    const [taxRate, setTaxRate] = useState('0');
    const [discountAmount, setDiscountAmount] = useState('0');
    const [currency, setCurrency] = useState('USD');
    const [paymentTerms, setPaymentTerms] = useState<string>('');
    const [dueDate, setDueDate] = useState('');
    const [saving, setSaving] = useState(false);

    // ── Populate on edit ─────────────────────────────────────────────────
    useEffect(() => {
        if (!open) return;
        if (invoice) {
            setContactId(invoice.contact_id ? String(invoice.contact_id) : '');
            setLeadId(invoice.lead_id ? String(invoice.lead_id) : '');
            setJobId(invoice.job_id ? String(invoice.job_id) : '');
            setEstimateId(invoice.estimate_id ? String(invoice.estimate_id) : '');
            setTitle(invoice.title || '');
            setNotes(invoice.notes || '');
            setInternalNote(invoice.internal_note || '');
            setTaxRate(invoice.tax_rate || '0');
            setDiscountAmount(invoice.discount_amount || '0');
            setCurrency(invoice.currency || 'USD');
            setPaymentTerms(invoice.payment_terms || '');
            setDueDate(invoice.due_date ? invoice.due_date.split('T')[0] : '');
            if (invoice.items && invoice.items.length > 0) {
                setItems(invoice.items.map(it => ({
                    key: crypto.randomUUID(),
                    name: it.name,
                    description: it.description || '',
                    quantity: it.quantity,
                    unit: it.unit || '',
                    unit_price: it.unit_price,
                    taxable: it.taxable,
                })));
            } else {
                setItems([emptyItem()]);
            }
        } else {
            // Reset for create
            setContactId('');
            setLeadId('');
            setJobId(defaultJobId ? String(defaultJobId) : '');
            setEstimateId('');
            setTitle('');
            setNotes('');
            setInternalNote('');
            setItems([emptyItem()]);
            setTaxRate('0');
            setDiscountAmount('0');
            setCurrency('USD');
            setPaymentTerms('');
            setDueDate('');
        }
    }, [open, invoice]);

    // ── Calculations ─────────────────────────────────────────────────────
    const subtotal = items.reduce((sum, it) => sum + calcItemAmount(it), 0);
    const discount = parseFloat(discountAmount) || 0;
    const taxableSubtotal = items
        .filter(it => it.taxable)
        .reduce((sum, it) => sum + calcItemAmount(it), 0);
    const taxAmt = (taxableSubtotal - discount) * ((parseFloat(taxRate) || 0) / 100);
    const total = subtotal - discount + Math.max(taxAmt, 0);

    // ── Item mutations ───────────────────────────────────────────────────
    const updateItem = useCallback((key: string, field: keyof LineItem, value: string | boolean) => {
        setItems(prev => prev.map(it => it.key === key ? { ...it, [field]: value } : it));
    }, []);

    const addItem = useCallback(() => {
        setItems(prev => [...prev, emptyItem()]);
    }, []);

    const removeItem = useCallback((key: string) => {
        setItems(prev => prev.length > 1 ? prev.filter(it => it.key !== key) : prev);
    }, []);

    // ── Save ─────────────────────────────────────────────────────────────
    const handleSave = async () => {
        setSaving(true);
        try {
            const data: InvoiceCreateData = {
                contact_id: contactId ? Number(contactId) : null,
                lead_id: leadId ? Number(leadId) : null,
                job_id: jobId ? Number(jobId) : null,
                estimate_id: estimateId ? Number(estimateId) : null,
                title: title || undefined,
                notes: notes || undefined,
                internal_note: internalNote || undefined,
                tax_rate: taxRate,
                discount_amount: String(discount),
                currency,
                payment_terms: paymentTerms || null,
                due_date: dueDate || null,
                items: items.filter(it => it.name.trim()).map((it, idx) => ({
                    sort_order: idx,
                    name: it.name,
                    description: it.description || null,
                    quantity: it.quantity,
                    unit: it.unit || null,
                    unit_price: it.unit_price,
                    amount: String(calcItemAmount(it)),
                    taxable: it.taxable,
                    metadata: null,
                })),
            };
            await onSave(data);
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{isEdit ? 'Edit Invoice' : 'New Invoice'}</DialogTitle>
                </DialogHeader>

                <div className="space-y-4 py-2">
                    {/* Customer / Links */}
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <Label className="text-xs">Contact ID</Label>
                            <Input value={contactId} onChange={e => setContactId(e.target.value)} placeholder="Contact ID" />
                        </div>
                        <div>
                            <Label className="text-xs">Estimate ID</Label>
                            <Input value={estimateId} onChange={e => setEstimateId(e.target.value)} placeholder="Optional" />
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <Label className="text-xs">Lead ID</Label>
                            <Input value={leadId} onChange={e => setLeadId(e.target.value)} placeholder="Optional" />
                        </div>
                        <div>
                            <Label className="text-xs">Job ID</Label>
                            <Input value={jobId} onChange={e => setJobId(e.target.value)} placeholder="Optional" />
                        </div>
                    </div>

                    {/* Title */}
                    <div>
                        <Label className="text-xs">Title</Label>
                        <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Invoice title" />
                    </div>

                    <Separator />

                    {/* Line Items */}
                    <div>
                        <div className="flex items-center justify-between mb-2">
                            <Label className="text-xs font-medium uppercase tracking-wide">Line Items</Label>
                            <Button variant="ghost" size="sm" onClick={addItem}>
                                <Plus className="size-3.5 mr-1" />Add Item
                            </Button>
                        </div>
                        <div className="space-y-2">
                            {items.map(item => (
                                <div key={item.key} className="grid grid-cols-12 gap-2 items-end border rounded-md p-2">
                                    <div className="col-span-4">
                                        <Label className="text-xs">Name</Label>
                                        <Input
                                            value={item.name}
                                            onChange={e => updateItem(item.key, 'name', e.target.value)}
                                            placeholder="Item name"
                                        />
                                    </div>
                                    <div className="col-span-2">
                                        <Label className="text-xs">Qty</Label>
                                        <Input
                                            type="number"
                                            value={item.quantity}
                                            onChange={e => updateItem(item.key, 'quantity', e.target.value)}
                                            min="0"
                                            step="any"
                                        />
                                    </div>
                                    <div className="col-span-2">
                                        <Label className="text-xs">Unit Price</Label>
                                        <Input
                                            type="number"
                                            value={item.unit_price}
                                            onChange={e => updateItem(item.key, 'unit_price', e.target.value)}
                                            min="0"
                                            step="0.01"
                                        />
                                    </div>
                                    <div className="col-span-2 text-right">
                                        <Label className="text-xs">Amount</Label>
                                        <p className="h-9 flex items-center justify-end font-mono text-sm">
                                            ${money(calcItemAmount(item))}
                                        </p>
                                    </div>
                                    <div className="col-span-1 flex items-center gap-1">
                                        <Checkbox
                                            checked={item.taxable}
                                            onCheckedChange={(checked) => updateItem(item.key, 'taxable', !!checked)}
                                            title="Taxable"
                                        />
                                    </div>
                                    <div className="col-span-1 flex justify-end">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="size-7 p-0 text-muted-foreground hover:text-red-600"
                                            onClick={() => removeItem(item.key)}
                                        >
                                            <Trash2 className="size-3.5" />
                                        </Button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    <Separator />

                    {/* Tax & Discount */}
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <Label className="text-xs">Tax Rate (%)</Label>
                            <Input
                                type="number"
                                value={taxRate}
                                onChange={e => setTaxRate(e.target.value)}
                                min="0"
                                step="0.01"
                            />
                        </div>
                        <div>
                            <Label className="text-xs">Discount ($)</Label>
                            <Input
                                type="number"
                                value={discountAmount}
                                onChange={e => setDiscountAmount(e.target.value)}
                                min="0"
                                step="0.01"
                            />
                        </div>
                    </div>

                    {/* Totals summary */}
                    <div className="bg-muted/50 rounded-md p-3 space-y-1 text-sm">
                        <div className="flex justify-between">
                            <span>Subtotal</span>
                            <span className="font-mono">${money(subtotal)}</span>
                        </div>
                        {discount > 0 && (
                            <div className="flex justify-between text-red-600">
                                <span>Discount</span>
                                <span className="font-mono">-${money(discount)}</span>
                            </div>
                        )}
                        {taxAmt > 0 && (
                            <div className="flex justify-between">
                                <span>Tax ({taxRate}%)</span>
                                <span className="font-mono">${money(Math.max(taxAmt, 0))}</span>
                            </div>
                        )}
                        <div className="flex justify-between font-semibold border-t pt-1">
                            <span>Total</span>
                            <span className="font-mono">${money(total)}</span>
                        </div>
                    </div>

                    <Separator />

                    {/* Payment terms & Due date & Currency */}
                    <div className="grid grid-cols-3 gap-3">
                        <div>
                            <Label className="text-xs">Payment Terms</Label>
                            <Select value={paymentTerms || '_none'} onValueChange={v => setPaymentTerms(v === '_none' ? '' : v)}>
                                <SelectTrigger>
                                    <SelectValue placeholder="Select terms" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="_none">None</SelectItem>
                                    <SelectItem value="Due on Receipt">Due on Receipt</SelectItem>
                                    <SelectItem value="Net 15">Net 15</SelectItem>
                                    <SelectItem value="Net 30">Net 30</SelectItem>
                                    <SelectItem value="Net 60">Net 60</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div>
                            <Label className="text-xs">Due Date</Label>
                            <Input
                                type="date"
                                value={dueDate}
                                onChange={e => setDueDate(e.target.value)}
                            />
                        </div>
                        <div>
                            <Label className="text-xs">Currency</Label>
                            <Input value={currency} onChange={e => setCurrency(e.target.value)} placeholder="USD" />
                        </div>
                    </div>

                    <Separator />

                    {/* Notes */}
                    <div>
                        <Label className="text-xs">Notes (visible to customer)</Label>
                        <Textarea
                            value={notes}
                            onChange={e => setNotes(e.target.value)}
                            placeholder="Notes for the customer..."
                            rows={2}
                        />
                    </div>
                    <div>
                        <Label className="text-xs">Internal Note</Label>
                        <Textarea
                            value={internalNote}
                            onChange={e => setInternalNote(e.target.value)}
                            placeholder="Internal notes (not visible to customer)..."
                            rows={2}
                        />
                    </div>
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
                        Cancel
                    </Button>
                    <Button onClick={handleSave} disabled={saving}>
                        {saving ? 'Saving...' : isEdit ? 'Update Invoice' : 'Create Invoice'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
