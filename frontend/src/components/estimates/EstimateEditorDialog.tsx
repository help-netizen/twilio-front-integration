/**
 * EstimateEditorDialog — clean form for creating/editing estimates.
 *
 * When opened from a Job context (defaultJobId), hides ID fields and shows context.
 * Backend auto-resolves contact_id/lead_id from job_id.
 */
import { useState, useEffect, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { Checkbox } from '../ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Plus, Trash2, ChevronDown } from 'lucide-react';
import type { Estimate, EstimateCreateData } from '../../services/estimatesApi';

// ── Line item type ───────────────────────────────────────────────────────────

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
    return { key: crypto.randomUUID(), name: '', description: '', quantity: '1', unit: '', unit_price: '0', taxable: true };
}

function calcAmount(item: LineItem): number {
    return (parseFloat(item.quantity) || 0) * (parseFloat(item.unit_price) || 0);
}

function money(v: number): string {
    return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Props ────────────────────────────────────────────────────────────────────

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    estimate: Estimate | null;
    defaultJobId?: number;
    defaultLeadId?: number;
    defaultContext?: string;
    onSave: (data: EstimateCreateData) => Promise<void>;
}

// ── Component ────────────────────────────────────────────────────────────────

export function EstimateEditorDialog({ open, onOpenChange, estimate, defaultJobId, defaultLeadId, defaultContext, onSave }: Props) {
    const isEdit = !!estimate;
    const hasJobContext = !!defaultJobId && !isEdit;

    // Form state
    const [contactId, setContactId] = useState('');
    const [leadId, setLeadId] = useState('');
    const [jobId, setJobId] = useState('');
    const [title, setTitle] = useState('');
    const [notes, setNotes] = useState('');
    const [internalNote, setInternalNote] = useState('');
    const [items, setItems] = useState<LineItem[]>([emptyItem()]);
    const [taxRate, setTaxRate] = useState('0');
    const [discountAmount, setDiscountAmount] = useState('0');
    const [depositRequired, setDepositRequired] = useState(false);
    const [depositType, setDepositType] = useState<string>('fixed');
    const [depositValue, setDepositValue] = useState('0');
    const [validUntil, setValidUntil] = useState('');
    const [signatureRequired, setSignatureRequired] = useState(false);
    const [showOptions, setShowOptions] = useState(false);
    const [saving, setSaving] = useState(false);

    // Populate on open
    useEffect(() => {
        if (!open) return;
        if (estimate) {
            setContactId(estimate.contact_id ? String(estimate.contact_id) : '');
            setLeadId(estimate.lead_id ? String(estimate.lead_id) : '');
            setJobId(estimate.job_id ? String(estimate.job_id) : '');
            setTitle(estimate.title || '');
            setNotes(estimate.notes || '');
            setInternalNote(estimate.internal_note || '');
            setTaxRate(estimate.tax_rate || '0');
            setDiscountAmount(estimate.discount_amount || '0');
            setDepositRequired(estimate.deposit_required);
            setDepositType(estimate.deposit_type || 'fixed');
            setDepositValue(estimate.deposit_value || '0');
            setValidUntil(estimate.valid_until ? estimate.valid_until.split('T')[0] : '');
            setSignatureRequired(estimate.signature_required);
            setShowOptions(estimate.deposit_required || estimate.signature_required || !!estimate.valid_until);
            if (estimate.items?.length) {
                setItems(estimate.items.map(it => ({ key: crypto.randomUUID(), name: it.name, description: it.description || '', quantity: it.quantity, unit: it.unit || '', unit_price: it.unit_price, taxable: it.taxable })));
            } else { setItems([emptyItem()]); }
        } else {
            setContactId('');
            setLeadId(defaultLeadId ? String(defaultLeadId) : '');
            setJobId(defaultJobId ? String(defaultJobId) : '');
            setTitle('');
            setNotes('');
            setInternalNote('');
            setItems([emptyItem()]);
            setTaxRate('0');
            setDiscountAmount('0');
            setDepositRequired(false);
            setDepositType('fixed');
            setDepositValue('0');
            setValidUntil('');
            setSignatureRequired(false);
            setShowOptions(false);
        }
    }, [open, estimate]); // eslint-disable-line react-hooks/exhaustive-deps

    // Calculations
    const subtotal = items.reduce((sum, it) => sum + calcAmount(it), 0);
    const discount = parseFloat(discountAmount) || 0;
    const taxableSubtotal = items.filter(it => it.taxable).reduce((sum, it) => sum + calcAmount(it), 0);
    const taxAmt = Math.max((taxableSubtotal - discount) * ((parseFloat(taxRate) || 0) / 100), 0);
    const total = subtotal - discount + taxAmt;

    // Item mutations
    const updateItem = useCallback((key: string, field: keyof LineItem, value: string | boolean) => {
        setItems(prev => prev.map(it => it.key === key ? { ...it, [field]: value } : it));
    }, []);
    const addItem = useCallback(() => setItems(prev => [...prev, emptyItem()]), []);
    const removeItem = useCallback((key: string) => setItems(prev => prev.length > 1 ? prev.filter(it => it.key !== key) : prev), []);

    // Save
    const handleSave = async () => {
        setSaving(true);
        try {
            const data: EstimateCreateData = {
                contact_id: contactId ? Number(contactId) : null,
                lead_id: leadId ? Number(leadId) : null,
                job_id: jobId ? Number(jobId) : null,
                title: title || undefined,
                notes: notes || undefined,
                internal_note: internalNote || undefined,
                tax_rate: taxRate,
                discount_amount: String(discount),
                deposit_required: depositRequired,
                deposit_type: depositRequired ? depositType : null,
                deposit_value: depositRequired ? depositValue : null,
                signature_required: signatureRequired,
                valid_until: validUntil || null,
                items: items.filter(it => it.name.trim()).map((it, idx) => ({
                    sort_order: idx, name: it.name, description: it.description || null,
                    quantity: it.quantity, unit: it.unit || null, unit_price: it.unit_price,
                    amount: String(calcAmount(it)), taxable: it.taxable, metadata: null,
                })),
            };
            await onSave(data);
        } finally { setSaving(false); }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" style={{ background: 'var(--blanc-surface-strong)' }}>
                <DialogHeader>
                    <DialogTitle style={{ fontFamily: 'var(--blanc-font-heading)', fontSize: 20, fontWeight: 700, color: 'var(--blanc-ink-1)' }}>
                        {isEdit ? 'Edit Estimate' : 'New Estimate'}
                    </DialogTitle>
                </DialogHeader>

                <div className="space-y-5 py-2">
                    {/* Context banner (when from Job) */}
                    {hasJobContext && defaultContext && (
                        <div className="text-[12px] font-medium" style={{ color: 'var(--blanc-ink-3)' }}>
                            {defaultContext}
                        </div>
                    )}

                    {/* IDs — only show when NOT from job context */}
                    {!hasJobContext && (
                        <div className="grid grid-cols-3 gap-3">
                            <div>
                                <Label className="text-xs" style={{ color: 'var(--blanc-ink-2)' }}>Contact ID</Label>
                                <Input value={contactId} onChange={e => setContactId(e.target.value)} placeholder="Contact ID" />
                            </div>
                            <div>
                                <Label className="text-xs" style={{ color: 'var(--blanc-ink-2)' }}>Lead ID</Label>
                                <Input value={leadId} onChange={e => setLeadId(e.target.value)} placeholder="Optional" />
                            </div>
                            <div>
                                <Label className="text-xs" style={{ color: 'var(--blanc-ink-2)' }}>Job ID</Label>
                                <Input value={jobId} onChange={e => setJobId(e.target.value)} placeholder="Optional" />
                            </div>
                        </div>
                    )}

                    {/* Title */}
                    <div>
                        <Label className="text-xs" style={{ color: 'var(--blanc-ink-2)' }}>Title</Label>
                        <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Estimate title" style={{ fontSize: 15, fontWeight: 500 }} />
                    </div>

                    {/* ── Line Items ── */}
                    <div>
                        <div className="flex items-center justify-between mb-3">
                            <span className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: 'var(--blanc-ink-3)', letterSpacing: '0.14em' }}>Line Items</span>
                            <button onClick={addItem} className="inline-flex items-center gap-1 text-[12px] font-medium transition-opacity hover:opacity-70" style={{ color: 'var(--blanc-info)', background: 'none', border: 'none', cursor: 'pointer' }}>
                                <Plus className="size-3.5" /> Add Item
                            </button>
                        </div>
                        <div className="space-y-2">
                            {items.map(item => {
                                const amt = calcAmount(item);
                                return (
                                    <div
                                        key={item.key}
                                        className="rounded-xl p-3"
                                        style={{ border: '1px solid var(--blanc-line)', background: 'rgba(255,255,255,0.5)' }}
                                    >
                                        {/* Row 1: Name + Amount */}
                                        <div className="flex items-center gap-2 mb-2">
                                            <Input
                                                value={item.name}
                                                onChange={e => updateItem(item.key, 'name', e.target.value)}
                                                placeholder="Item name"
                                                className="flex-1"
                                                style={{ fontSize: 14, fontWeight: 500 }}
                                            />
                                            <span className="text-sm font-semibold font-mono shrink-0 w-20 text-right" style={{ color: 'var(--blanc-ink-1)' }}>
                                                ${money(amt)}
                                            </span>
                                        </div>
                                        {/* Row 2: Qty × Price + controls */}
                                        <div className="flex items-center gap-2">
                                            <div className="flex items-center gap-1.5">
                                                <Input
                                                    type="number"
                                                    value={item.quantity}
                                                    onChange={e => updateItem(item.key, 'quantity', e.target.value)}
                                                    min="0" step="any"
                                                    className="w-16 text-center"
                                                    style={{ fontSize: 13 }}
                                                />
                                                <span className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>×</span>
                                                <div className="relative">
                                                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs" style={{ color: 'var(--blanc-ink-3)' }}>$</span>
                                                    <Input
                                                        type="number"
                                                        value={item.unit_price}
                                                        onChange={e => updateItem(item.key, 'unit_price', e.target.value)}
                                                        min="0" step="0.01"
                                                        className="w-24 pl-5"
                                                        style={{ fontSize: 13 }}
                                                    />
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-2 ml-auto">
                                                <div className="flex items-center gap-1.5">
                                                    <Checkbox
                                                        checked={item.taxable}
                                                        onCheckedChange={checked => updateItem(item.key, 'taxable', !!checked)}
                                                    />
                                                    <span className="text-[11px]" style={{ color: 'var(--blanc-ink-3)' }}>Tax</span>
                                                </div>
                                                <button
                                                    onClick={() => removeItem(item.key)}
                                                    className="p-1 transition-opacity hover:opacity-70"
                                                    style={{ color: 'var(--blanc-ink-3)' }}
                                                >
                                                    <Trash2 className="size-3.5" />
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* ── Financials ── */}
                    <div className="flex items-start gap-4">
                        <div className="flex items-center gap-3">
                            <div>
                                <Label className="text-[11px]" style={{ color: 'var(--blanc-ink-3)' }}>Tax %</Label>
                                <Input type="number" value={taxRate} onChange={e => setTaxRate(e.target.value)} min="0" step="0.01" className="w-20" style={{ fontSize: 13 }} />
                            </div>
                            <div>
                                <Label className="text-[11px]" style={{ color: 'var(--blanc-ink-3)' }}>Discount $</Label>
                                <Input type="number" value={discountAmount} onChange={e => setDiscountAmount(e.target.value)} min="0" step="0.01" className="w-24" style={{ fontSize: 13 }} />
                            </div>
                        </div>
                        <div className="ml-auto text-right space-y-1">
                            <div className="flex justify-between gap-6 text-[13px]" style={{ color: 'var(--blanc-ink-2)' }}>
                                <span>Subtotal</span>
                                <span className="font-mono">${money(subtotal)}</span>
                            </div>
                            {discount > 0 && (
                                <div className="flex justify-between gap-6 text-[13px]" style={{ color: '#EF4444' }}>
                                    <span>Discount</span>
                                    <span className="font-mono">-${money(discount)}</span>
                                </div>
                            )}
                            {taxAmt > 0 && (
                                <div className="flex justify-between gap-6 text-[13px]" style={{ color: 'var(--blanc-ink-2)' }}>
                                    <span>Tax ({taxRate}%)</span>
                                    <span className="font-mono">${money(taxAmt)}</span>
                                </div>
                            )}
                            <div className="flex justify-between gap-6 text-[15px] font-semibold pt-1" style={{ borderTop: '1px solid var(--blanc-line)', color: 'var(--blanc-ink-1)' }}>
                                <span>Total</span>
                                <span className="font-mono">${money(total)}</span>
                            </div>
                        </div>
                    </div>

                    {/* ── Options (collapsed) ── */}
                    <div>
                        <button
                            onClick={() => setShowOptions(!showOptions)}
                            className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest transition-opacity hover:opacity-70"
                            style={{ color: 'var(--blanc-ink-3)', letterSpacing: '0.14em', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                        >
                            <ChevronDown className="size-3" style={{ transform: showOptions ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s' }} />
                            Options
                        </button>
                        {showOptions && (
                            <div className="mt-3 space-y-3">
                                {/* Deposit */}
                                <div className="flex items-center gap-2">
                                    <Checkbox id="est-deposit" checked={depositRequired} onCheckedChange={checked => setDepositRequired(!!checked)} />
                                    <Label htmlFor="est-deposit" className="text-sm cursor-pointer" style={{ color: 'var(--blanc-ink-1)' }}>Deposit required</Label>
                                </div>
                                {depositRequired && (
                                    <div className="grid grid-cols-2 gap-3 pl-6">
                                        <div>
                                            <Label className="text-[11px]" style={{ color: 'var(--blanc-ink-3)' }}>Type</Label>
                                            <Select value={depositType} onValueChange={setDepositType}>
                                                <SelectTrigger><SelectValue /></SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="fixed">Fixed Amount</SelectItem>
                                                    <SelectItem value="percentage">Percentage</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        <div>
                                            <Label className="text-[11px]" style={{ color: 'var(--blanc-ink-3)' }}>Value</Label>
                                            <Input type="number" value={depositValue} onChange={e => setDepositValue(e.target.value)} min="0" step="0.01" />
                                        </div>
                                    </div>
                                )}
                                {/* Valid until + signature */}
                                <div className="grid grid-cols-2 gap-3">
                                    <div>
                                        <Label className="text-[11px]" style={{ color: 'var(--blanc-ink-3)' }}>Valid Until</Label>
                                        <Input type="date" value={validUntil} onChange={e => setValidUntil(e.target.value)} />
                                    </div>
                                    <div className="flex items-end pb-2">
                                        <div className="flex items-center gap-2">
                                            <Checkbox id="est-sig" checked={signatureRequired} onCheckedChange={checked => setSignatureRequired(!!checked)} />
                                            <Label htmlFor="est-sig" className="text-sm cursor-pointer" style={{ color: 'var(--blanc-ink-1)' }}>Signature required</Label>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* ── Notes ── */}
                    <div className="space-y-3">
                        <div>
                            <Label className="text-[11px]" style={{ color: 'var(--blanc-ink-3)' }}>Notes (visible to customer)</Label>
                            <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes for the customer..." rows={2} />
                        </div>
                        <div>
                            <Label className="text-[11px]" style={{ color: 'var(--blanc-ink-3)' }}>Internal Note</Label>
                            <Textarea value={internalNote} onChange={e => setInternalNote(e.target.value)} placeholder="Internal notes (not visible)..." rows={2} />
                        </div>
                    </div>
                </div>

                <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
                        Cancel
                    </Button>
                    <Button type="button" onClick={handleSave} disabled={saving} style={{ background: 'var(--blanc-info)', color: '#fff' }}>
                        {saving ? 'Saving...' : isEdit ? 'Update Estimate' : 'Save Estimate'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
