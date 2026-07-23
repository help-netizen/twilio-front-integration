import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, Pencil, Plus, Trash2 } from 'lucide-react';
import {
    Dialog,
    DialogContent,
    DialogPanelHeader,
    DialogBody,
    DialogPanelFooter,
    DialogTitle,
    DialogDescription,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { FloatingField } from '../ui/floating-field';
import { Checkbox } from '../ui/checkbox';
import { Badge } from '../ui/badge';
import { MoneyInput } from '../ui/MoneyInput';
import { AutoGrowTextarea } from '../ui/AutoGrowTextarea';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import { DEFAULT_TERMS_AND_WARRANTY, EstimatePreviewDialog } from './EstimatePreviewDialog';
import { useDocumentTemplate, findSection } from '../../hooks/useDocumentTemplate';
import { ItemPresetSearchCombobox } from './ItemPresetSearchCombobox';
import {
    createEstimateItemPreset,
    recordEstimateItemPresetUsage,
    type EstimateItemPreset,
} from '../../services/estimateItemPresetsApi';
import type { Estimate, EstimateCreateData, EstimateDiscountType } from '../../services/estimatesApi';

interface LineItem {
    key: string;
    name: string;
    description: string;
    quantity: string;
    unit_price: string;
    taxable: boolean;
}

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    estimate: Estimate | null;
    defaultJobId?: number;
    defaultLeadId?: number;
    defaultEstimateNumber?: string;
    defaultContext?: string;
    onSave: (data: EstimateCreateData) => Promise<void>;
}

const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
// OB-24: new items default to taxable — the invisible false default made "Tax $0.00"
// look broken. Price-book picks keep their catalog default_taxable (labor is often
// legitimately non-taxable); the row checkbox stays the override.
const emptyItem = (): LineItem => ({ key: newKey(), name: '', description: '', quantity: '1', unit_price: '0', taxable: true });

function money(value: number | string | null | undefined): string {
    return '$' + Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function amount(item: LineItem): number {
    return (Number(item.quantity) || 0) * (Number(item.unit_price) || 0);
}

export function EstimateEditorDialog({ open, onOpenChange, estimate, defaultJobId, defaultLeadId, defaultEstimateNumber, defaultContext, onSave }: Props) {
    const isEdit = !!estimate;
    const templateDescriptor = useDocumentTemplate('estimate', open);
    const termsBody = findSection(templateDescriptor, 'terms')?.body_md ?? DEFAULT_TERMS_AND_WARRANTY;
    const [summary, setSummary] = useState('');
    const [summaryOpen, setSummaryOpen] = useState(false);
    const [summaryDialogOpen, setSummaryDialogOpen] = useState(false);
    const [summaryDraft, setSummaryDraft] = useState('');
    const [items, setItems] = useState<LineItem[]>([]);
    const [itemDialogOpen, setItemDialogOpen] = useState(false);
    const [editingItemKey, setEditingItemKey] = useState<string | null>(null);
    const [itemDraft, setItemDraft] = useState<LineItem>(emptyItem());
    const [taxRate, setTaxRate] = useState('0');
    const [discountType, setDiscountType] = useState<EstimateDiscountType>(null);
    const [discountValue, setDiscountValue] = useState('0');
    const [signatureRequired, setSignatureRequired] = useState(false);
    const [termsOpen, setTermsOpen] = useState(false);
    const [previewOpen, setPreviewOpen] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!open) return;
        setSummary(estimate?.summary || '');
        setSummaryOpen(false);
        setTaxRate(estimate?.tax_rate ? Number(estimate.tax_rate).toFixed(2) : '0');
        setDiscountType(estimate?.discount_type || (Number(estimate?.discount_amount || 0) > 0 ? 'fixed' : null));
        setDiscountValue(estimate?.discount_value || estimate?.discount_amount || '0');
        setSignatureRequired(estimate?.signature_required || false);
        setTermsOpen(false);
        setItems((estimate?.items || []).map(item => ({
            key: newKey(),
            name: item.name,
            description: item.description || '',
            quantity: item.quantity || '1',
            unit_price: item.unit_price || '0',
            taxable: !!item.taxable,
        })));
    }, [open, estimate]);

    const subtotal = useMemo(() => items.reduce((sum, item) => sum + amount(item), 0), [items]);
    const rawDiscountValue = Number(discountValue) || 0;
    const discountAmount = discountType === 'percentage'
        ? subtotal * Math.min(Math.max(rawDiscountValue, 0), 100) / 100
        : discountType === 'fixed'
            ? rawDiscountValue
            : 0;
    const taxableSubtotal = items.filter(item => item.taxable).reduce((sum, item) => sum + amount(item), 0);
    const taxAmount = Math.max(taxableSubtotal - discountAmount, 0) * ((Number(taxRate) || 0) / 100);
    const total = subtotal - discountAmount + taxAmount;
    const discountError = discountType === 'fixed' && discountAmount > subtotal
        ? 'Discount cannot exceed subtotal'
        : discountType === 'percentage' && rawDiscountValue > 100
            ? 'Discount percentage cannot exceed 100'
            : '';
    const canSave = (items.length > 0 || summary.trim().length > 0) && !discountError;
    const previewEstimate: Estimate = {
        id: estimate?.id || 0,
        company_id: estimate?.company_id || '',
        estimate_number: estimate?.estimate_number || defaultEstimateNumber || (defaultLeadId ? `ESTIMATE L-${defaultLeadId}-1` : 'ESTIMATE'),
        status: estimate?.status || 'draft',
        contact_id: estimate?.contact_id || null,
        lead_id: estimate?.lead_id ?? defaultLeadId ?? null,
        job_id: estimate?.job_id ?? defaultJobId ?? null,
        title: null,
        summary: summary.trim() || null,
        notes: null,
        internal_note: null,
        subtotal: subtotal.toFixed(2),
        tax_rate: taxRate || '0',
        tax_amount: taxAmount.toFixed(2),
        discount_amount: discountAmount.toFixed(2),
        discount_type: discountType,
        discount_value: discountType ? String(rawDiscountValue) : '0',
        total: total.toFixed(2),
        currency: estimate?.currency || 'USD',
        deposit_required: false,
        deposit_type: null,
        deposit_value: null,
        deposit_paid: '0',
        signature_required: signatureRequired,
        signed_at: null,
        valid_until: null,
        sent_at: null,
        accepted_at: null,
        declined_at: null,
        created_by: null,
        updated_by: null,
        created_at: estimate?.created_at || new Date().toISOString(),
        updated_at: estimate?.updated_at || new Date().toISOString(),
        contact_name: estimate?.contact_name,
        items: items.map((item, index) => ({
            id: index + 1,
            estimate_id: estimate?.id || 0,
            sort_order: index,
            name: item.name || 'Untitled item',
            description: item.description || null,
            quantity: item.quantity || '1',
            unit: null,
            unit_price: item.unit_price || '0',
            amount: amount(item).toFixed(2),
            taxable: item.taxable,
            metadata: {},
        })),
    };

    const openSummaryDialog = () => {
        setSummaryDraft(summary);
        setSummaryDialogOpen(true);
    };

    const saveSummary = () => {
        setSummary(summaryDraft.trim());
        setSummaryOpen(false);
        setSummaryDialogOpen(false);
    };

    const saveItem = () => {
        if (!itemDraft.name.trim() || Number(itemDraft.quantity) <= 0 || Number(itemDraft.unit_price) < 0) return;
        const nextItem = { ...itemDraft, name: itemDraft.name.trim() };
        setItems(prev => editingItemKey
            ? prev.map(item => item.key === editingItemKey ? nextItem : item)
            : [...prev, { ...nextItem, key: newKey() }]
        );
        // Combobox "Create new" path — also persist to the company catalog
        // so the item is searchable on future estimates.
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

    const removeItem = (key: string) => {
        setItems(prev => prev.filter(item => item.key !== key));
    };

    /** Combobox: existing preset selected → add a line item with the preset's defaults. */
    const pickPreset = (preset: EstimateItemPreset) => {
        setItems(prev => [...prev, {
            key: newKey(),
            name: preset.name,
            description: preset.description || '',
            quantity: String(preset.default_quantity ?? 1),
            unit_price: String(preset.default_unit_price ?? 0),
            taxable: !!preset.default_taxable,
        }]);
        // Fire-and-forget usage bump (non-blocking).
        recordEstimateItemPresetUsage(preset.id).catch(() => {});
    };

    /** Combobox: typed a name not in catalog → open the item dialog pre-filled; save also creates a preset. */
    const [savePresetOnNextItem, setSavePresetOnNextItem] = useState(false);
    const startCreateFromName = (name: string) => {
        setEditingItemKey(null);
        setItemDraft({ ...emptyItem(), name });
        setSavePresetOnNextItem(true);
        setItemDialogOpen(true);
    };

    const handleSave = async () => {
        if (!canSave) return;
        setSaving(true);
        try {
            const data: EstimateCreateData = {
                lead_id: estimate?.lead_id ?? defaultLeadId ?? null,
                job_id: estimate?.job_id ?? defaultJobId ?? null,
                summary: summary.trim() || null,
                tax_rate: taxRate || '0',
                discount_type: discountType,
                discount_value: discountType ? String(rawDiscountValue) : '0',
                signature_required: signatureRequired,
                items: items.map((item, index) => ({
                    sort_order: index,
                    name: item.name,
                    description: item.description.trim() || null,
                    quantity: item.quantity || '1',
                    unit: null,
                    unit_price: item.unit_price || '0',
                    amount: String(amount(item)),
                    taxable: item.taxable,
                    metadata: {},
                })),
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
                        <div className="flex items-start justify-between gap-4 pr-2">
                            <div className="min-w-0">
                                <DialogTitle
                                    className="text-[22px] font-semibold leading-tight"
                                    style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                                >
                                    {isEdit ? estimate?.estimate_number : 'New estimate'}
                                </DialogTitle>
                                <DialogDescription className="sr-only">Edit the estimate document, line items and totals</DialogDescription>
                                {defaultContext && !isEdit && (
                                    <p className="mt-1 text-xs font-medium" style={{ color: 'var(--blanc-ink-3)' }}>{defaultContext}</p>
                                )}
                            </div>
                            <div className="flex shrink-0 items-start gap-3">
                                {estimate?.archived_at && <Badge variant="outline">Archived</Badge>}
                                <div className="text-right">
                                    <p className="blanc-eyebrow">Total</p>
                                    <p className="font-mono text-xl font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>{money(total)}</p>
                                </div>
                            </div>
                        </div>
                    </DialogPanelHeader>

                    <DialogBody className="md:px-8 md:py-7">
                        {/* OB-26: single column (form canon width); the side column is gone. */}
                        <div className="mx-auto w-full max-w-[740px]">
                            <main className="space-y-6">
                                {estimate && estimate.status !== 'draft' && !estimate.archived_at && (
                                    <div className="flex gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                                        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                                        <span>This estimate is {estimate.status}. Editing will move it back to draft; send the updated version to the client after saving.</span>
                                    </div>
                                )}

                                {summary ? (
                                    <Collapsible open={summaryOpen} onOpenChange={setSummaryOpen}>
                                        <div className="rounded-xl border border-[var(--blanc-line)]" style={{ background: 'rgba(25,25,25,0.03)' }}>
                                            <div className="flex items-center justify-between px-4 py-3">
                                                <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--blanc-ink-1)' }}>
                                                    <ChevronDown className={`size-4 transition-transform ${summaryOpen ? 'rotate-180' : ''}`} />
                                                    Summary
                                                </CollapsibleTrigger>
                                                <Button type="button" size="sm" variant="ghost" onClick={openSummaryDialog}>
                                                    <Pencil className="size-4" />
                                                </Button>
                                            </div>
                                            <CollapsibleContent>
                                                <div className="px-4 py-4 text-sm whitespace-pre-wrap" style={{ color: 'var(--blanc-ink-2)' }}>{summary}</div>
                                            </CollapsibleContent>
                                        </div>
                                    </Collapsible>
                                ) : (
                                    <div className="rounded-xl border border-dashed border-[var(--blanc-line)] px-4 py-5" style={{ background: 'rgba(25,25,25,0.03)' }}>
                                        <p className="text-sm font-medium" style={{ color: 'var(--blanc-ink-1)' }}>Summary</p>
                                        <p className="mt-1 text-sm" style={{ color: 'var(--blanc-ink-3)' }}>Add make, model, issue, findings, needs, and cause when the estimate needs client context.</p>
                                        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={openSummaryDialog}>
                                            <Plus className="mr-1 size-4" /> Add summary
                                        </Button>
                                    </div>
                                )}

                                <section className="space-y-3">
                                    <div>
                                        <p className="blanc-eyebrow">Items</p>
                                        <p className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>Title and unit price are required. Qty defaults to 1.</p>
                                    </div>

                                    <div className="flex flex-col gap-4">
                                        {items.map(item => (
                                            <div key={item.key} className="space-y-2">
                                                <input
                                                    placeholder="Item title"
                                                    value={item.name}
                                                    onChange={e => setItems(prev => prev.map(i => i.key === item.key ? { ...i, name: e.target.value } : i))}
                                                    className="h-[42px] w-full rounded-xl border-[1.5px] border-[var(--blanc-line)] bg-transparent px-3.5 text-[15px] font-medium text-[var(--blanc-ink-1)] outline-none transition-colors focus:border-[var(--blanc-ink-2)]"
                                                />
                                                <AutoGrowTextarea
                                                    placeholder="Description (optional)"
                                                    value={item.description}
                                                    onChange={e => setItems(prev => prev.map(i => i.key === item.key ? { ...i, description: e.target.value } : i))}
                                                    rows={2}
                                                    className="w-full resize-none rounded-xl border-[1.5px] border-[var(--blanc-line)] bg-transparent px-3.5 py-2.5 text-sm leading-relaxed text-[var(--blanc-ink-1)] outline-none transition-colors focus:border-[var(--blanc-ink-2)]"
                                                />
                                                <div className="grid grid-cols-[80px_120px_1fr_auto_auto] items-center gap-3">
                                                    <div className="flex flex-col gap-0.5">
                                                        <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--blanc-ink-3)' }}>Qty</span>
                                                        <input
                                                            type="text"
                                                            inputMode="decimal"
                                                            value={item.quantity}
                                                            onChange={e => setItems(prev => prev.map(i => i.key === item.key ? { ...i, quantity: e.target.value.replace(/[^0-9.]/g, '') } : i))}
                                                            className="h-[42px] w-full rounded-xl border-[1.5px] border-[var(--blanc-line)] bg-transparent px-3 text-[15px] tabular-nums text-[var(--blanc-ink-1)] outline-none transition-colors focus:border-[var(--blanc-ink-2)]"
                                                        />
                                                    </div>
                                                    <div className="flex flex-col gap-0.5">
                                                        <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--blanc-ink-3)' }}>Unit price</span>
                                                        <MoneyInput
                                                            value={item.unit_price}
                                                            onValueChange={next => setItems(prev => prev.map(i => i.key === item.key ? { ...i, unit_price: next } : i))}
                                                            className="h-[42px] w-full rounded-xl border-[1.5px] border-[var(--blanc-line)] bg-transparent px-3 text-right text-[15px] tabular-nums text-[var(--blanc-ink-1)] outline-none transition-colors focus:border-[var(--blanc-ink-2)]"
                                                        />
                                                    </div>
                                                    <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: 'var(--blanc-ink-2)' }}>
                                                        <Checkbox
                                                            checked={item.taxable}
                                                            onCheckedChange={checked => setItems(prev => prev.map(i => i.key === item.key ? { ...i, taxable: !!checked } : i))}
                                                        />
                                                        Taxable
                                                    </label>
                                                    <p className="font-mono text-sm font-semibold text-right whitespace-nowrap" style={{ color: 'var(--blanc-ink-1)' }}>{money(amount(item))}</p>
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

                                <section className="space-y-3 rounded-xl border border-[var(--blanc-line)] p-4" style={{ background: 'rgba(25,25,25,0.03)' }}>
                                    <p className="blanc-eyebrow">Totals</p>
                                    <div className="flex justify-between text-sm">
                                        <span style={{ color: 'var(--blanc-ink-3)' }}>Subtotal</span>
                                        <span className="font-mono" style={{ color: 'var(--blanc-ink-1)' }}>{money(subtotal)}</span>
                                    </div>
                                    {discountType ? (
                                        <div className="space-y-1">
                                            {/* OB-24: wrap on narrow widths so the amount can drop to its own
                                                right-aligned line instead of overflowing the panel edge. */}
                                            <div className="flex flex-wrap items-center gap-2 text-sm">
                                                <span style={{ color: 'var(--blanc-ink-3)' }}>Discount</span>
                                                <div className="inline-flex rounded-[10px] border border-[var(--blanc-line)] p-0.5 shrink-0" style={{ background: 'var(--blanc-panel-surface,#fffdf9)' }}>
                                                    <button
                                                        type="button"
                                                        onClick={() => setDiscountType('fixed')}
                                                        className={`px-2.5 py-0.5 rounded-md text-sm transition-colors ${
                                                            discountType === 'fixed'
                                                                ? 'bg-[var(--blanc-ink-1)] text-white'
                                                                : 'text-[var(--blanc-ink-3)] hover:text-[var(--blanc-ink-1)]'
                                                        }`}
                                                    >
                                                        $
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => setDiscountType('percentage')}
                                                        className={`px-2.5 py-0.5 rounded-md text-sm transition-colors ${
                                                            discountType === 'percentage'
                                                                ? 'bg-[var(--blanc-ink-1)] text-white'
                                                                : 'text-[var(--blanc-ink-3)] hover:text-[var(--blanc-ink-1)]'
                                                        }`}
                                                    >
                                                        %
                                                    </button>
                                                </div>
                                                {discountType === 'fixed' ? (
                                                    <MoneyInput
                                                        value={discountValue}
                                                        onValueChange={setDiscountValue}
                                                        className="w-24 h-8 rounded-xl border-[1.5px] border-[var(--blanc-line)] bg-transparent px-3 text-right text-[15px] tabular-nums text-[var(--blanc-ink-1)] outline-none transition-colors focus:border-[var(--blanc-ink-2)]"
                                                    />
                                                ) : (
                                                    <input
                                                        type="text"
                                                        inputMode="decimal"
                                                        value={discountValue}
                                                        onChange={event => setDiscountValue(event.target.value.replace(/[^0-9.]/g, ''))}
                                                        maxLength={6}
                                                        className="w-24 h-8 rounded-xl border-[1.5px] border-[var(--blanc-line)] bg-transparent px-3 text-right text-[15px] tabular-nums text-[var(--blanc-ink-1)] outline-none transition-colors focus:border-[var(--blanc-ink-2)]"
                                                    />
                                                )}
                                                <Button type="button" variant="ghost" size="sm" className="size-8 p-0 shrink-0" onClick={() => { setDiscountType(null); setDiscountValue('0'); }}>
                                                    <Trash2 className="size-4" />
                                                </Button>
                                                <span className="font-mono text-red-600 ml-auto">-{money(discountAmount)}</span>
                                            </div>
                                            {discountError && <p className="text-xs text-red-600">{discountError}</p>}
                                        </div>
                                    ) : (
                                        <button type="button" className="w-fit text-sm text-blue-600" onClick={() => { setDiscountType('fixed'); setDiscountValue('0'); }}>
                                            Add Discount
                                        </button>
                                    )}
                                    <div className="grid grid-cols-[1fr_auto] items-center gap-3">
                                        <Label className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>Tax rate</Label>
                                        <div className="relative w-24">
                                            <input
                                                className="h-9 w-full rounded-xl border-[1.5px] border-[var(--blanc-line)] bg-transparent pl-3 pr-7 text-right text-[15px] tabular-nums text-[var(--blanc-ink-1)] outline-none transition-colors focus:border-[var(--blanc-ink-2)]"
                                                type="text"
                                                inputMode="decimal"
                                                value={taxRate}
                                                onChange={event => setTaxRate(event.target.value.replace(/[^0-9.]/g, ''))}
                                                onBlur={() => {
                                                    const n = Number(taxRate);
                                                    if (Number.isFinite(n)) setTaxRate(n.toFixed(2));
                                                }}
                                            />
                                            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm" style={{ color: 'var(--blanc-ink-3)' }}>%</span>
                                        </div>
                                    </div>
                                    <div className="flex justify-between text-sm">
                                        <span style={{ color: 'var(--blanc-ink-3)' }}>Tax</span>
                                        <span className="font-mono" style={{ color: 'var(--blanc-ink-1)' }}>{money(taxAmount)}</span>
                                    </div>
                                    <div className="flex justify-between pt-2 text-base font-semibold" style={{ borderTop: '1px solid var(--blanc-line)', color: 'var(--blanc-ink-1)' }}>
                                        <span>Total</span>
                                        <span className="font-mono">{money(total)}</span>
                                    </div>
                                </section>

                                {/* OB-26: document settings — flat rows in the flow, no card. */}
                                <div className="space-y-3">
                                    <div className="flex items-center justify-between text-sm">
                                        <span style={{ color: 'var(--blanc-ink-3)' }}>Require signature</span>
                                        <Checkbox checked={signatureRequired} onCheckedChange={checked => setSignatureRequired(!!checked)} />
                                    </div>
                                    <div className="flex items-center justify-between text-sm">
                                        <span style={{ color: 'var(--blanc-ink-3)' }}>Deposit required</span>
                                        <span className="font-medium" style={{ color: 'var(--blanc-ink-1)' }}>No</span>
                                    </div>
                                </div>

                                <Collapsible open={termsOpen} onOpenChange={setTermsOpen}>
                                    <div className="rounded-xl border border-[var(--blanc-line)]" style={{ background: 'rgba(25,25,25,0.03)' }}>
                                        <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium" style={{ color: 'var(--blanc-ink-1)' }}>
                                            <ChevronDown className={`size-4 transition-transform ${termsOpen ? 'rotate-180' : ''}`} />
                                            Terms & Warranty
                                        </CollapsibleTrigger>
                                        <CollapsibleContent>
                                            <div className="px-4 py-4 text-sm whitespace-pre-wrap" style={{ color: 'var(--blanc-ink-2)' }}>{termsBody}</div>
                                        </CollapsibleContent>
                                    </div>
                                </Collapsible>
                            </main>
                        </div>
                    </DialogBody>

                    <DialogPanelFooter>
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
                        <Button type="button" variant="outline" onClick={() => setPreviewOpen(true)} disabled={!canSave}>
                            Preview
                        </Button>
                        <Button type="button" onClick={handleSave} disabled={saving || !canSave || !!estimate?.archived_at}>
                            {saving ? 'Saving...' : 'Save estimate'}
                        </Button>
                    </DialogPanelFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={summaryDialogOpen} onOpenChange={setSummaryDialogOpen}>
                <DialogContent variant="panel">
                    <DialogPanelHeader>
                        <DialogTitle
                            className="text-[22px] font-semibold leading-tight"
                            style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                        >
                            Summary
                        </DialogTitle>
                        <DialogDescription className="sr-only">Edit the estimate summary</DialogDescription>
                    </DialogPanelHeader>
                    <DialogBody className="md:px-8 md:py-7">
                        <div className="mx-auto w-full max-w-[740px]">
                            <FloatingField
                                textarea
                                rows={10}
                                id="estimate-summary"
                                label="Make, model, serial, failure issue, findings, needs, cause…"
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
                        <div className="mx-auto w-full max-w-[740px] grid grid-cols-1 sm:grid-cols-2 gap-3.5">
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
                    </DialogBody>
                    <DialogPanelFooter>
                        <Button type="button" variant="ghost" onClick={() => setItemDialogOpen(false)}>Cancel</Button>
                        <Button type="button" onClick={saveItem} disabled={!itemDraft.name.trim() || Number(itemDraft.quantity) <= 0 || Number(itemDraft.unit_price) < 0}>
                            Save item
                        </Button>
                    </DialogPanelFooter>
                </DialogContent>
            </Dialog>

            <EstimatePreviewDialog open={previewOpen} onOpenChange={setPreviewOpen} estimate={previewEstimate} />
        </>
    );
}
