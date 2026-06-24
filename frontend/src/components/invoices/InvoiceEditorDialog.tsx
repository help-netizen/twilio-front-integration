import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Pencil, Plus, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { FloatingDetailPanel } from '../ui/FloatingDetailPanel';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { Checkbox } from '../ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import { DEFAULT_TERMS_AND_WARRANTY } from '../estimates/EstimatePreviewDialog';
import { useDocumentTemplate, findSection } from '../../hooks/useDocumentTemplate';
import { ItemPresetSearchCombobox } from '../estimates/ItemPresetSearchCombobox';
import {
    createEstimateItemPreset,
    recordEstimateItemPresetUsage,
    type EstimateItemPreset,
} from '../../services/estimateItemPresetsApi';
import type { Invoice, InvoiceCreateData } from '../../services/invoicesApi';

// ── Helpers ──────────────────────────────────────────────────────────────────

interface LineItem {
    key: string;
    name: string;
    description: string;
    quantity: string;
    unit_price: string;
    taxable: boolean;
}

const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const emptyItem = (): LineItem => ({ key: newKey(), name: '', description: '', quantity: '1', unit_price: '0', taxable: false });

function money(value: number | string | null | undefined): string {
    return '$' + Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function amount(item: LineItem): number {
    return (Number(item.quantity) || 0) * (Number(item.unit_price) || 0);
}

// ── Props ────────────────────────────────────────────────────────────────────

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    invoice: Invoice | null;
    defaultJobId?: number;
    defaultLeadId?: number;
    defaultContactId?: number;
    defaultEstimateId?: number;
    defaultContext?: string;
    onSave: (data: InvoiceCreateData) => Promise<void>;
}

// ── Component ────────────────────────────────────────────────────────────────

export function InvoiceEditorDialog({
    open,
    onOpenChange,
    invoice,
    defaultJobId,
    defaultLeadId,
    defaultContactId,
    defaultEstimateId,
    defaultContext,
    onSave,
}: Props) {
    const isEdit = !!invoice;
    const templateDescriptor = useDocumentTemplate('invoice', open);
    const termsBody = findSection(templateDescriptor, 'terms')?.body_md ?? DEFAULT_TERMS_AND_WARRANTY;

    // Summary (stored as `notes` on the invoice — same as the detail panel)
    const [summary, setSummary] = useState('');
    const [summaryOpen, setSummaryOpen] = useState(false);
    const [summaryDialogOpen, setSummaryDialogOpen] = useState(false);
    const [summaryDraft, setSummaryDraft] = useState('');

    const [items, setItems] = useState<LineItem[]>([]);
    const [taxRate, setTaxRate] = useState<string>('0');
    const [discountActive, setDiscountActive] = useState(false);
    const [discountAmount, setDiscountAmount] = useState<string>('0');

    // Aside (document settings) — Due date is derived from the invoice template's
    // `default_due_days` on the backend, so it is not editable here at create time.
    const [paymentTerms, setPaymentTerms] = useState<string>('');

    const [termsOpen, setTermsOpen] = useState(false);
    const [saving, setSaving] = useState(false);

    // Item dialog (for "Create new" path from combobox)
    const [itemDialogOpen, setItemDialogOpen] = useState(false);
    const [editingItemKey, setEditingItemKey] = useState<string | null>(null);
    const [itemDraft, setItemDraft] = useState<LineItem>(emptyItem());
    const [savePresetOnNextItem, setSavePresetOnNextItem] = useState(false);

    // Reset on open
    useEffect(() => {
        if (!open) return;
        setSummary(invoice?.notes || '');
        setSummaryOpen(false);
        setTaxRate(invoice?.tax_rate ? Number(invoice.tax_rate).toFixed(2) : '0');
        const initialDiscount = Number(invoice?.discount_amount) || 0;
        setDiscountActive(initialDiscount > 0);
        setDiscountAmount(initialDiscount > 0 ? String(initialDiscount) : '0');
        setPaymentTerms(invoice?.payment_terms || '');
        setTermsOpen(false);
        setItems((invoice?.items || []).map(item => ({
            key: newKey(),
            name: item.name,
            description: item.description || '',
            quantity: String(item.quantity ?? '1'),
            unit_price: String(item.unit_price ?? '0'),
            taxable: !!item.taxable,
        })));
    }, [open, invoice]);

    // ── Totals ───────────────────────────────────────────────────────────────

    const subtotal = useMemo(() => items.reduce((sum, item) => sum + amount(item), 0), [items]);
    const discountVal = discountActive ? (Number(discountAmount) || 0) : 0;
    const taxableSubtotal = items.filter(item => item.taxable).reduce((sum, item) => sum + amount(item), 0);
    const taxAmount = Math.max(taxableSubtotal - discountVal, 0) * ((Number(taxRate) || 0) / 100);
    const total = subtotal - discountVal + taxAmount;
    const discountError = discountActive && discountVal > subtotal ? 'Discount cannot exceed subtotal' : '';
    const canSave = (items.length > 0 || summary.trim().length > 0) && !discountError;

    // ── Summary handlers ─────────────────────────────────────────────────────

    const openSummaryDialog = () => {
        setSummaryDraft(summary);
        setSummaryDialogOpen(true);
    };
    const saveSummary = () => {
        setSummary(summaryDraft.trim());
        setSummaryOpen(false);
        setSummaryDialogOpen(false);
    };

    // ── Item handlers ────────────────────────────────────────────────────────

    const removeItem = (key: string) => {
        setItems(prev => prev.filter(item => item.key !== key));
    };

    const pickPreset = (preset: EstimateItemPreset) => {
        setItems(prev => [...prev, {
            key: newKey(),
            name: preset.name,
            description: preset.description || '',
            quantity: String(preset.default_quantity ?? 1),
            unit_price: String(preset.default_unit_price ?? 0),
            taxable: !!preset.default_taxable,
        }]);
        recordEstimateItemPresetUsage(preset.id).catch(() => {});
    };

    const startCreateFromName = (name: string) => {
        setEditingItemKey(null);
        setItemDraft({ ...emptyItem(), name });
        setSavePresetOnNextItem(true);
        setItemDialogOpen(true);
    };

    const saveItem = () => {
        if (!itemDraft.name.trim() || Number(itemDraft.quantity) <= 0 || Number(itemDraft.unit_price) < 0) return;
        const nextItem = { ...itemDraft, name: itemDraft.name.trim() };
        setItems(prev => editingItemKey
            ? prev.map(item => item.key === editingItemKey ? nextItem : item)
            : [...prev, { ...nextItem, key: newKey() }]
        );
        if (!editingItemKey && savePresetOnNextItem) {
            createEstimateItemPreset({
                name: nextItem.name,
                description: nextItem.description || null,
                default_quantity: Number(nextItem.quantity) || 1,
                default_unit_price: Number(nextItem.unit_price) || 0,
                default_taxable: !!nextItem.taxable,
            })
                .then(preset => recordEstimateItemPresetUsage(preset.id).catch(() => {}))
                .catch(() => {});
            setSavePresetOnNextItem(false);
        }
        setItemDialogOpen(false);
    };

    // ── Save ─────────────────────────────────────────────────────────────────

    const handleSave = async () => {
        if (!canSave) return;
        setSaving(true);
        try {
            const data: InvoiceCreateData = {
                contact_id: invoice?.contact_id ?? defaultContactId ?? null,
                lead_id: invoice?.lead_id ?? defaultLeadId ?? null,
                job_id: invoice?.job_id ?? defaultJobId ?? null,
                estimate_id: invoice?.estimate_id ?? defaultEstimateId ?? null,
                notes: summary.trim() || undefined,
                tax_rate: taxRate || '0',
                discount_amount: String(discountVal),
                payment_terms: paymentTerms || null,
                // due_date is auto-populated by the backend from the invoice template
                // (`invoice_settings.default_due_days`). Editable per-invoice from the detail panel after save.
                items: items.map((item, idx) => ({
                    sort_order: idx,
                    name: item.name || 'Untitled item',
                    description: item.description.trim() || null,
                    quantity: item.quantity || '1',
                    unit: null,
                    unit_price: item.unit_price || '0',
                    taxable: item.taxable,
                } as any)),
            };
            await onSave(data);
        } finally {
            setSaving(false);
        }
    };

    return (
        <>
            <FloatingDetailPanel open={open} onClose={() => onOpenChange(false)} wide>
                <div className="flex h-full min-h-0 flex-col bg-[#f3f6f9] text-[#172033]">
                    {/* Header */}
                    <div className="shrink-0 border-b border-[#d8e0ea] bg-[#fbfcfe] px-5 py-4 pr-14">
                        <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                                <p className="font-mono text-sm font-semibold">{isEdit ? invoice?.invoice_number : 'New Invoice'}</p>
                                {defaultContext && !isEdit && (
                                    <p className="mt-1 text-xs font-medium text-[#5f7085]">{defaultContext}</p>
                                )}
                            </div>
                            <div className="text-right shrink-0">
                                <p className="text-[11px] font-semibold uppercase tracking-wide text-[#65758b]">Total</p>
                                <p className="font-mono text-xl font-semibold">{money(total)}</p>
                            </div>
                        </div>
                    </div>

                    {/* Body — main + aside */}
                    <div className="grid min-h-0 flex-1 overflow-y-auto md:grid-cols-[minmax(0,1fr)_320px]">
                        <main className="space-y-5 p-5">
                            {/* Summary */}
                            {summary ? (
                                <Collapsible open={summaryOpen} onOpenChange={setSummaryOpen}>
                                    <div className="rounded-md border border-[#d8e0ea] bg-[#fbfcfe]">
                                        <div className="flex items-center justify-between px-4 py-3">
                                            <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium">
                                                <ChevronDown className={`size-4 transition-transform ${summaryOpen ? 'rotate-180' : ''}`} />
                                                Summary
                                            </CollapsibleTrigger>
                                            <Button type="button" size="sm" variant="ghost" onClick={openSummaryDialog}>
                                                <Pencil className="size-4" />
                                            </Button>
                                        </div>
                                        <CollapsibleContent>
                                            <div className="border-t border-[#d8e0ea] px-4 py-4 text-sm whitespace-pre-wrap text-[#4f6176]">{summary}</div>
                                        </CollapsibleContent>
                                    </div>
                                </Collapsible>
                            ) : (
                                <div className="rounded-md border border-dashed border-[#c4cfdd] bg-[#f8fafc] px-4 py-5">
                                    <p className="text-sm font-medium">Summary</p>
                                    <p className="mt-1 text-sm text-[#5f7085]">Add scope, findings, or any context worth highlighting to the customer.</p>
                                    <Button type="button" variant="outline" size="sm" className="mt-3" onClick={openSummaryDialog}>
                                        <Plus className="mr-1 size-4" /> Add Summary
                                    </Button>
                                </div>
                            )}

                            {/* Items */}
                            <section className="space-y-3">
                                <div>
                                    <p className="text-sm font-semibold">Items</p>
                                    <p className="text-xs text-[#5f7085]">Title and unit price are required. Qty defaults to 1.</p>
                                </div>

                                <div className="flex flex-col divide-y divide-[#d8e0ea]">
                                    {items.map(item => (
                                        <div key={item.key} className="space-y-2 py-3 first:pt-0 last:pb-0">
                                            <Input
                                                placeholder="Item title"
                                                value={item.name}
                                                onChange={e => setItems(prev => prev.map(i => i.key === item.key ? { ...i, name: e.target.value } : i))}
                                                className="font-medium"
                                            />
                                            <Textarea
                                                placeholder="Description (optional)"
                                                value={item.description}
                                                onChange={e => setItems(prev => prev.map(i => i.key === item.key ? { ...i, description: e.target.value } : i))}
                                                rows={2}
                                                className="text-sm font-normal"
                                            />
                                            <div className="grid grid-cols-[80px_120px_1fr_auto_auto] items-center gap-3">
                                                <div className="flex flex-col gap-0.5">
                                                    <span className="text-[10px] uppercase tracking-wider text-[#5f7085]">Qty</span>
                                                    <Input
                                                        type="number"
                                                        min="0"
                                                        step="0.01"
                                                        value={item.quantity}
                                                        onChange={e => setItems(prev => prev.map(i => i.key === item.key ? { ...i, quantity: e.target.value } : i))}
                                                    />
                                                </div>
                                                <div className="flex flex-col gap-0.5">
                                                    <span className="text-[10px] uppercase tracking-wider text-[#5f7085]">Unit price</span>
                                                    <Input
                                                        type="number"
                                                        min="0"
                                                        step="0.01"
                                                        value={item.unit_price}
                                                        onChange={e => setItems(prev => prev.map(i => i.key === item.key ? { ...i, unit_price: e.target.value } : i))}
                                                    />
                                                </div>
                                                <label className="flex items-center gap-2 text-xs text-[#5f7085] cursor-pointer">
                                                    <Checkbox
                                                        checked={item.taxable}
                                                        onCheckedChange={checked => setItems(prev => prev.map(i => i.key === item.key ? { ...i, taxable: !!checked } : i))}
                                                    />
                                                    Taxable
                                                </label>
                                                <p className="font-mono text-sm font-semibold text-right whitespace-nowrap">{money(amount(item))}</p>
                                                <Button type="button" size="sm" variant="ghost" className="size-8 p-0 text-red-600 shrink-0" onClick={() => removeItem(item.key)} title="Remove item">
                                                    <Trash2 className="size-4" />
                                                </Button>
                                            </div>
                                        </div>
                                    ))}
                                </div>

                                <ItemPresetSearchCombobox
                                    onPickPreset={pickPreset}
                                    onCreateNew={startCreateFromName}
                                />
                            </section>

                            {/* Totals */}
                            <section className="space-y-3 rounded-md border border-[#d8e0ea] bg-[#fbfcfe] p-4">
                                <p className="text-sm font-semibold">Totals</p>
                                <div className="flex justify-between text-sm">
                                    <span className="text-[#5f7085]">Subtotal</span>
                                    <span className="font-mono">{money(subtotal)}</span>
                                </div>
                                {discountActive ? (
                                    <div className="flex items-center gap-2 text-sm">
                                        <span className="text-[#5f7085]">Discount</span>
                                        <span className="text-[#65758b]">$</span>
                                        <Input
                                            type="number"
                                            min="0"
                                            step="0.01"
                                            value={discountAmount}
                                            onChange={e => setDiscountAmount(e.target.value)}
                                            className="w-24 h-8 text-right tabular-nums"
                                        />
                                        <Button type="button" variant="ghost" size="sm" className="size-8 p-0 shrink-0" onClick={() => { setDiscountActive(false); setDiscountAmount('0'); }} title="Remove discount">
                                            <Trash2 className="size-4" />
                                        </Button>
                                        <span className="font-mono text-red-600 ml-auto">-{money(discountVal)}</span>
                                    </div>
                                ) : (
                                    <button type="button" className="text-sm text-blue-600" onClick={() => { setDiscountActive(true); setDiscountAmount('0'); }}>
                                        Add Discount
                                    </button>
                                )}
                                {discountError && <p className="text-xs text-red-600">{discountError}</p>}
                                <div className="grid grid-cols-[1fr_auto] items-center gap-3 text-sm">
                                    <Label className="text-[#5f7085]">Tax rate</Label>
                                    <Input
                                        type="number"
                                        min="0"
                                        step="0.05"
                                        value={taxRate}
                                        onChange={e => setTaxRate(e.target.value)}
                                        onBlur={() => { const n = Number(taxRate); if (Number.isFinite(n)) setTaxRate(n.toFixed(2)); }}
                                        className="w-24 h-8 text-right tabular-nums"
                                    />
                                </div>
                                <div className="flex justify-between text-sm">
                                    <span className="text-[#5f7085]">Tax</span>
                                    <span className="font-mono">{money(taxAmount)}</span>
                                </div>
                                <div className="flex justify-between border-t pt-2 text-base font-semibold">
                                    <span>Total</span>
                                    <span className="font-mono">{money(total)}</span>
                                </div>
                            </section>

                            {/* Terms & Warranty */}
                            <Collapsible open={termsOpen} onOpenChange={setTermsOpen}>
                                <div className="rounded-md border border-[#d8e0ea] bg-[#fbfcfe]">
                                    <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium">
                                        <ChevronDown className={`size-4 transition-transform ${termsOpen ? 'rotate-180' : ''}`} />
                                        Terms & Warranty
                                    </CollapsibleTrigger>
                                    <CollapsibleContent>
                                        <div className="border-t border-[#d8e0ea] px-4 py-4 text-sm whitespace-pre-wrap text-[#4f6176]">{termsBody}</div>
                                    </CollapsibleContent>
                                </div>
                            </Collapsible>
                        </main>

                        {/* Aside */}
                        <aside className="space-y-5 border-t border-[#d8e0ea] bg-[#eef3f8] p-5 md:border-l md:border-t-0">
                            <section className="grid gap-3 rounded-md border border-[#d8e0ea] bg-[#fbfcfe] p-4">
                                <p className="text-sm font-semibold">Document settings</p>
                                <div className="flex flex-col gap-1">
                                    <Label className="text-xs text-[#5f7085]">Payment terms</Label>
                                    <Select value={paymentTerms || '_none'} onValueChange={v => setPaymentTerms(v === '_none' ? '' : v)}>
                                        <SelectTrigger className="h-9">
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
                                <p className="text-xs text-[#5f7085]">
                                    Due date is set automatically from the invoice template default. You can adjust it on the invoice after creation.
                                </p>
                            </section>
                        </aside>
                    </div>

                    {/* Footer */}
                    <div className="shrink-0 border-t border-[#d8e0ea] bg-[#fbfcfe] px-5 py-3">
                        <div className="flex flex-wrap items-center justify-end gap-2">
                            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
                            <Button type="button" onClick={handleSave} disabled={saving || !canSave}>
                                {saving ? 'Saving...' : isEdit ? 'Save Invoice' : 'Create Invoice'}
                            </Button>
                        </div>
                    </div>
                </div>
            </FloatingDetailPanel>

            {/* Summary edit dialog */}
            <Dialog open={summaryDialogOpen} onOpenChange={setSummaryDialogOpen}>
                <DialogContent variant="panel">
                    <DialogHeader><DialogTitle>Summary</DialogTitle></DialogHeader>
                    <Textarea value={summaryDraft} onChange={e => setSummaryDraft(e.target.value)} rows={10} placeholder="Notes for the customer..." />
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => setSummaryDialogOpen(false)}>Cancel</Button>
                        <Button type="button" onClick={saveSummary}>Save Summary</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Item create/edit dialog (used by combobox "Create new" path) */}
            <Dialog open={itemDialogOpen} onOpenChange={setItemDialogOpen}>
                <DialogContent variant="panel">
                    <DialogHeader><DialogTitle>{editingItemKey ? 'Edit custom item' : 'Add custom item'}</DialogTitle></DialogHeader>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
                        <div className="sm:col-span-2">
                            <Label>Title <span className="text-red-600">*</span></Label>
                            <Input value={itemDraft.name} onChange={e => setItemDraft(prev => ({ ...prev, name: e.target.value }))} autoFocus />
                        </div>
                        <div className="sm:col-span-2">
                            <Label>Description</Label>
                            <Textarea value={itemDraft.description} onChange={e => setItemDraft(prev => ({ ...prev, description: e.target.value }))} rows={4} />
                        </div>
                        <div>
                            <Label>Qty</Label>
                            <Input type="number" min="0.01" step="any" value={itemDraft.quantity} onChange={e => setItemDraft(prev => ({ ...prev, quantity: e.target.value }))} />
                        </div>
                        <div>
                            <Label>Unit price <span className="text-red-600">*</span></Label>
                            <Input type="number" min="0" step="0.01" value={itemDraft.unit_price} onChange={e => setItemDraft(prev => ({ ...prev, unit_price: e.target.value }))} />
                        </div>
                        <div className="sm:col-span-2 flex items-center gap-2">
                            <Checkbox checked={itemDraft.taxable} onCheckedChange={checked => setItemDraft(prev => ({ ...prev, taxable: !!checked }))} />
                            <Label>Service is taxable</Label>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => setItemDialogOpen(false)}>Cancel</Button>
                        <Button type="button" onClick={saveItem} disabled={!itemDraft.name.trim() || Number(itemDraft.quantity) <= 0 || Number(itemDraft.unit_price) < 0}>
                            Save Item
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
