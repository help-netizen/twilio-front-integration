import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Pencil, Plus, Trash2 } from 'lucide-react';
import {
    Dialog,
    DialogContent,
    DialogTitle,
    DialogDescription,
    DialogPanelHeader,
    DialogBody,
    DialogPanelFooter,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { FloatingField } from '../ui/floating-field';
import { Checkbox } from '../ui/checkbox';
import { MoneyInput } from '../ui/MoneyInput';
import { AutoGrowTextarea } from '../ui/AutoGrowTextarea';
import { FloatingSelect } from '../ui/floating-select';
import { SelectItem } from '../ui/select';
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
// OB-24: new items default to taxable (invisible false default read as "tax broken").
// Price-book picks keep their catalog default; the row checkbox is the override.
const emptyItem = (): LineItem => ({ key: newKey(), name: '', description: '', quantity: '1', unit_price: '0', taxable: true });

function money(value: number | string | null | undefined): string {
    return '$' + Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function amount(item: LineItem): number {
    return (Number(item.quantity) || 0) * (Number(item.unit_price) || 0);
}

// Border-only, near-white cell input — sits on the panel surface, no clashing bg.
const CELL_INPUT =
    'h-9 rounded-[10px] border-[1.5px] border-[var(--blanc-line)] bg-transparent text-[14px] text-[var(--blanc-ink-1)] outline-none transition-colors focus-visible:border-[var(--blanc-ink-2)]';

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
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent variant="panel" size="full">
                    <DialogPanelHeader>
                        <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                                <DialogTitle
                                    className="text-[22px] font-semibold leading-tight"
                                    style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                                >
                                    {isEdit ? invoice?.invoice_number : 'New invoice'}
                                </DialogTitle>
                                <DialogDescription className="sr-only">
                                    {isEdit ? 'Edit invoice line items and totals' : 'Create a new invoice'}
                                </DialogDescription>
                                {defaultContext && !isEdit && (
                                    <p className="mt-1 text-xs font-medium text-[var(--blanc-ink-2)]">{defaultContext}</p>
                                )}
                            </div>
                            <div className="shrink-0 text-right">
                                <p className="blanc-eyebrow">Total</p>
                                <p className="font-mono text-xl font-semibold text-[var(--blanc-ink-1)]">{money(total)}</p>
                            </div>
                        </div>
                    </DialogPanelHeader>

                    <DialogBody className="md:px-8 md:py-7">
                        {/* Wide document — line-item grid uses the full panel width (no max-w cap). */}
                        <div className="w-full space-y-6">
                            {/* Summary */}
                            {summary ? (
                                <Collapsible open={summaryOpen} onOpenChange={setSummaryOpen}>
                                    <div className="rounded-2xl border border-[var(--blanc-line)]">
                                        <div className="flex items-center justify-between px-4 py-3">
                                            <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium text-[var(--blanc-ink-1)]">
                                                <ChevronDown className={`size-4 text-[var(--blanc-ink-3)] transition-transform ${summaryOpen ? 'rotate-180' : ''}`} />
                                                Summary
                                            </CollapsibleTrigger>
                                            <Button type="button" size="sm" variant="ghost" onClick={openSummaryDialog}>
                                                <Pencil className="size-4" />
                                            </Button>
                                        </div>
                                        <CollapsibleContent>
                                            <div className="px-4 pb-4 text-sm whitespace-pre-wrap text-[var(--blanc-ink-2)]">{summary}</div>
                                        </CollapsibleContent>
                                    </div>
                                </Collapsible>
                            ) : (
                                <div className="rounded-2xl border border-dashed border-[var(--blanc-line)] px-4 py-5" style={{ background: 'rgba(25,25,25,0.03)' }}>
                                    <p className="text-sm font-medium text-[var(--blanc-ink-1)]">Summary</p>
                                    <p className="mt-1 text-sm text-[var(--blanc-ink-2)]">Add scope, findings, or any context worth highlighting to the customer.</p>
                                    <Button type="button" variant="outline" size="sm" className="mt-3" onClick={openSummaryDialog}>
                                        <Plus className="mr-1 size-4" /> Add summary
                                    </Button>
                                </div>
                            )}

                            {/* Items */}
                            <section className="space-y-3">
                                <div>
                                    <p className="blanc-eyebrow">Items</p>
                                    <p className="text-xs text-[var(--blanc-ink-3)]">Title and unit price are required. Qty defaults to 1.</p>
                                </div>

                                {/* Column headers for the line-item grid (kept as a grid, not floating per cell) */}
                                {items.length > 0 && (
                                    <div className="grid grid-cols-[80px_120px_1fr_auto_auto] items-center gap-3 px-0.5">
                                        <span className="text-[10px] uppercase tracking-wider text-[var(--blanc-ink-3)]">Qty</span>
                                        <span className="text-[10px] uppercase tracking-wider text-[var(--blanc-ink-3)]">Unit price</span>
                                        <span className="text-[10px] uppercase tracking-wider text-[var(--blanc-ink-3)]">Taxable</span>
                                        <span className="text-[10px] uppercase tracking-wider text-right text-[var(--blanc-ink-3)]">Amount</span>
                                        <span className="w-8" />
                                    </div>
                                )}

                                <div className="flex flex-col gap-4">
                                    {items.map(item => (
                                        <div key={item.key} className="space-y-2">
                                            <Input
                                                placeholder="Item title"
                                                value={item.name}
                                                onChange={e => setItems(prev => prev.map(i => i.key === item.key ? { ...i, name: e.target.value } : i))}
                                                className={`${CELL_INPUT} h-[42px] font-medium text-[15px]`}
                                            />
                                            <AutoGrowTextarea
                                                placeholder="Description (optional)"
                                                value={item.description}
                                                onChange={e => setItems(prev => prev.map(i => i.key === item.key ? { ...i, description: e.target.value } : i))}
                                                rows={2}
                                                className="w-full resize-none rounded-[10px] border-[1.5px] border-[var(--blanc-line)] bg-transparent px-3.5 py-2.5 text-sm font-normal leading-relaxed text-[var(--blanc-ink-1)] outline-none transition-colors focus:border-[var(--blanc-ink-2)]"
                                            />
                                            <div className="grid grid-cols-[80px_120px_1fr_auto_auto] items-center gap-3">
                                                <Input
                                                    type="text"
                                                    inputMode="decimal"
                                                    value={item.quantity}
                                                    onChange={e => setItems(prev => prev.map(i => i.key === item.key ? { ...i, quantity: e.target.value.replace(/[^0-9.]/g, '') } : i))}
                                                    className={CELL_INPUT}
                                                />
                                                <MoneyInput
                                                    value={item.unit_price}
                                                    onValueChange={next => setItems(prev => prev.map(i => i.key === item.key ? { ...i, unit_price: next } : i))}
                                                    className={`${CELL_INPUT} w-full px-3 text-right tabular-nums focus:border-[var(--blanc-ink-2)]`}
                                                />
                                                <label className="flex items-center gap-2 text-xs text-[var(--blanc-ink-2)] cursor-pointer">
                                                    <Checkbox
                                                        checked={item.taxable}
                                                        onCheckedChange={checked => setItems(prev => prev.map(i => i.key === item.key ? { ...i, taxable: !!checked } : i))}
                                                    />
                                                    Taxable
                                                </label>
                                                <p className="font-mono text-sm font-semibold text-right whitespace-nowrap text-[var(--blanc-ink-1)]">{money(amount(item))}</p>
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
                            <section className="space-y-3 rounded-2xl p-4" style={{ background: 'rgba(25,25,25,0.03)' }}>
                                <p className="blanc-eyebrow">Totals</p>
                                <div className="flex justify-between text-sm">
                                    <span className="text-[var(--blanc-ink-2)]">Subtotal</span>
                                    <span className="font-mono text-[var(--blanc-ink-1)]">{money(subtotal)}</span>
                                </div>
                                {discountActive ? (
                                    /* OB-24: wrap on narrow widths — the amount drops to its own
                                       right-aligned line instead of overflowing the panel edge. */
                                    <div className="flex flex-wrap items-center gap-2 text-sm">
                                        <span className="text-[var(--blanc-ink-2)]">Discount</span>
                                        <span className="text-[var(--blanc-ink-3)]">$</span>
                                        <MoneyInput
                                            value={discountAmount}
                                            onValueChange={setDiscountAmount}
                                            className={`${CELL_INPUT} w-24 px-3 text-right tabular-nums focus:border-[var(--blanc-ink-2)]`}
                                        />
                                        <Button type="button" variant="ghost" size="sm" className="size-8 p-0 shrink-0" onClick={() => { setDiscountActive(false); setDiscountAmount('0'); }} title="Remove discount">
                                            <Trash2 className="size-4" />
                                        </Button>
                                        <span className="font-mono text-red-600 ml-auto">-{money(discountVal)}</span>
                                    </div>
                                ) : (
                                    <button type="button" className="text-sm text-blue-600" onClick={() => { setDiscountActive(true); setDiscountAmount('0'); }}>
                                        Add discount
                                    </button>
                                )}
                                {discountError && <p className="text-xs text-red-600">{discountError}</p>}
                                <div className="grid grid-cols-[1fr_auto] items-center gap-3 text-sm">
                                    <Label className="text-[var(--blanc-ink-2)]">Tax rate</Label>
                                    <div className="relative w-24">
                                        <Input
                                            type="text"
                                            inputMode="decimal"
                                            value={taxRate}
                                            onChange={e => setTaxRate(e.target.value.replace(/[^0-9.]/g, ''))}
                                            onBlur={() => { const n = Number(taxRate); if (Number.isFinite(n)) setTaxRate(n.toFixed(2)); }}
                                            className={`${CELL_INPUT} w-full pr-7 text-right tabular-nums`}
                                        />
                                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-[var(--blanc-ink-3)]">%</span>
                                    </div>
                                </div>
                                <div className="flex justify-between text-sm">
                                    <span className="text-[var(--blanc-ink-2)]">Tax</span>
                                    <span className="font-mono text-[var(--blanc-ink-1)]">{money(taxAmount)}</span>
                                </div>
                                <div className="flex justify-between pt-2 text-base font-semibold text-[var(--blanc-ink-1)]" style={{ borderTop: '1px solid var(--blanc-line)' }}>
                                    <span>Total</span>
                                    <span className="font-mono">{money(total)}</span>
                                </div>
                            </section>

                            {/* Document settings */}
                            <section className="space-y-3">
                                <FloatingSelect
                                    label="Payment terms"
                                    value={paymentTerms || '_none'}
                                    onValueChange={v => setPaymentTerms(v === '_none' ? '' : v)}
                                >
                                    <SelectItem value="_none">None</SelectItem>
                                    <SelectItem value="Due on Receipt">Due on Receipt</SelectItem>
                                    <SelectItem value="Net 15">Net 15</SelectItem>
                                    <SelectItem value="Net 30">Net 30</SelectItem>
                                    <SelectItem value="Net 60">Net 60</SelectItem>
                                </FloatingSelect>
                                <p className="text-xs text-[var(--blanc-ink-3)]">
                                    Due date is set automatically from the invoice template default. You can adjust it on the invoice after creation.
                                </p>
                            </section>

                            {/* Terms & Warranty */}
                            <Collapsible open={termsOpen} onOpenChange={setTermsOpen}>
                                <div className="rounded-2xl border border-[var(--blanc-line)]">
                                    <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-[var(--blanc-ink-1)]">
                                        <ChevronDown className={`size-4 text-[var(--blanc-ink-3)] transition-transform ${termsOpen ? 'rotate-180' : ''}`} />
                                        Terms & Warranty
                                    </CollapsibleTrigger>
                                    <CollapsibleContent>
                                        <div className="px-4 pb-4 text-sm whitespace-pre-wrap text-[var(--blanc-ink-2)]">{termsBody}</div>
                                    </CollapsibleContent>
                                </div>
                            </Collapsible>
                        </div>
                    </DialogBody>

                    <DialogPanelFooter>
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
                        <Button type="button" onClick={handleSave} disabled={saving || !canSave}>
                            {saving ? 'Saving...' : isEdit ? 'Save invoice' : 'Create invoice'}
                        </Button>
                    </DialogPanelFooter>
                </DialogContent>
            </Dialog>

            {/* Summary edit dialog */}
            <Dialog open={summaryDialogOpen} onOpenChange={setSummaryDialogOpen}>
                <DialogContent variant="panel">
                    <DialogPanelHeader>
                        <DialogTitle
                            className="text-[22px] font-semibold leading-tight"
                            style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                        >
                            Summary
                        </DialogTitle>
                        <DialogDescription className="sr-only">Edit the invoice summary</DialogDescription>
                    </DialogPanelHeader>
                    <DialogBody className="md:px-8 md:py-7">
                        <div className="mx-auto w-full max-w-[740px] space-y-6">
                            <FloatingField
                                textarea
                                rows={10}
                                id="invoice-summary"
                                label="Notes for the customer…"
                                value={summaryDraft}
                                onChange={event => setSummaryDraft(event.target.value)}
                            />
                        </div>
                    </DialogBody>
                    <DialogPanelFooter>
                        <Button type="button" variant="ghost" onClick={() => setSummaryDialogOpen(false)}>Cancel</Button>
                        <Button type="button" onClick={saveSummary}>Save summary</Button>
                    </DialogPanelFooter>
                </DialogContent>
            </Dialog>

            {/* Item create/edit dialog (used by combobox "Create new" path) */}
            <Dialog open={itemDialogOpen} onOpenChange={setItemDialogOpen}>
                <DialogContent variant="panel">
                    <DialogPanelHeader>
                        <DialogTitle
                            className="text-[22px] font-semibold leading-tight"
                            style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                        >
                            {editingItemKey ? 'Edit custom item' : 'Add custom item'}
                        </DialogTitle>
                        <DialogDescription className="sr-only">Define a custom line item</DialogDescription>
                    </DialogPanelHeader>
                    <DialogBody className="md:px-8 md:py-7">
                        <div className="mx-auto w-full max-w-[740px] space-y-6">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                <FloatingField
                                    containerClassName="sm:col-span-2"
                                    id="item-title"
                                    label="Title"
                                    value={itemDraft.name}
                                    onChange={event => setItemDraft(prev => ({ ...prev, name: event.target.value }))}
                                />
                                <FloatingField
                                    containerClassName="sm:col-span-2"
                                    textarea
                                    rows={4}
                                    id="item-description"
                                    label="Description"
                                    value={itemDraft.description}
                                    onChange={event => setItemDraft(prev => ({ ...prev, description: event.target.value }))}
                                />
                                <FloatingField
                                    id="item-qty"
                                    label="Qty"
                                    type="number"
                                    inputMode="decimal"
                                    value={itemDraft.quantity}
                                    onChange={event => setItemDraft(prev => ({ ...prev, quantity: event.target.value }))}
                                />
                                <FloatingField
                                    id="item-unit-price"
                                    label="Unit price"
                                    type="number"
                                    inputMode="decimal"
                                    value={itemDraft.unit_price}
                                    onChange={event => setItemDraft(prev => ({ ...prev, unit_price: event.target.value }))}
                                />
                                <label className="sm:col-span-2 flex items-center gap-2 text-sm cursor-pointer" style={{ color: 'var(--blanc-ink-2)' }}>
                                    <Checkbox checked={itemDraft.taxable} onCheckedChange={checked => setItemDraft(prev => ({ ...prev, taxable: !!checked }))} />
                                    Service is taxable
                                </label>
                            </div>
                        </div>
                    </DialogBody>
                    <DialogPanelFooter>
                        <Button type="button" variant="ghost" onClick={() => setItemDialogOpen(false)}>Cancel</Button>
                        <Button type="button" onClick={saveItem} disabled={!itemDraft.name.trim() || Number(itemDraft.quantity) <= 0 || Number(itemDraft.unit_price) < 0}>
                            Save item
                        </Button>
                    </DialogPanelFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
