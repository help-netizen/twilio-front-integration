import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, Pencil, Plus, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { FloatingDetailPanel } from '../ui/FloatingDetailPanel';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { Checkbox } from '../ui/checkbox';
import { Badge } from '../ui/badge';
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
const emptyItem = (): LineItem => ({ key: newKey(), name: '', description: '', quantity: '1', unit_price: '0', taxable: false });

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
            <FloatingDetailPanel open={open} onClose={() => onOpenChange(false)} wide>
                <div className="flex h-full min-h-0 flex-col bg-[#f3f6f9] text-[#172033]">
                    <div className="shrink-0 border-b border-[#d8e0ea] bg-[#fbfcfe] px-5 py-4 pr-14">
                        <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                                <p className="font-mono text-sm font-semibold">{isEdit ? estimate?.estimate_number : 'New Estimate'}</p>
                                {defaultContext && !isEdit && (
                                    <p className="mt-1 text-xs font-medium text-[#5f7085]">{defaultContext}</p>
                                )}
                            </div>
                            <div className="flex shrink-0 items-start gap-3">
                                {estimate?.archived_at && <Badge variant="outline">Archived</Badge>}
                                <div className="text-right">
                                    <p className="text-[11px] font-semibold uppercase tracking-wide text-[#65758b]">Total</p>
                                    <p className="font-mono text-xl font-semibold">{money(total)}</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="grid min-h-0 flex-1 overflow-y-auto md:grid-cols-[minmax(0,1fr)_320px]">
                        <main className="space-y-5 p-5">
                            {estimate && estimate.status !== 'draft' && !estimate.archived_at && (
                                <div className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                                    <span>This estimate is {estimate.status}. Editing will move it back to draft; send the updated version to the client after saving.</span>
                                </div>
                            )}

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
                                    <p className="mt-1 text-sm text-[#5f7085]">Add make, model, issue, findings, needs, and cause when the estimate needs client context.</p>
                                    <Button type="button" variant="outline" size="sm" className="mt-3" onClick={openSummaryDialog}>
                                        <Plus className="mr-1 size-4" /> Add Summary
                                    </Button>
                                </div>
                            )}

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

                            <section className="space-y-3 rounded-md border border-[#d8e0ea] bg-[#fbfcfe] p-4">
                                <p className="text-sm font-semibold">Totals</p>
                                <div className="flex justify-between text-sm">
                                    <span className="text-[#5f7085]">Subtotal</span>
                                    <span className="font-mono">{money(subtotal)}</span>
                                </div>
                                {discountType ? (
                                    <div className="space-y-1">
                                        <div className="flex items-center gap-2 text-sm">
                                            <span className="text-[#5f7085]">Discount</span>
                                            <div className="inline-flex rounded-[10px] border border-[#d8e0ea] p-0.5 bg-white shrink-0">
                                                <button
                                                    type="button"
                                                    onClick={() => setDiscountType('fixed')}
                                                    className={`px-2.5 py-0.5 rounded-md text-sm transition-colors ${
                                                        discountType === 'fixed'
                                                            ? 'bg-[#172033] text-white'
                                                            : 'text-[#5f7085] hover:text-[#172033]'
                                                    }`}
                                                >
                                                    $
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => setDiscountType('percentage')}
                                                    className={`px-2.5 py-0.5 rounded-md text-sm transition-colors ${
                                                        discountType === 'percentage'
                                                            ? 'bg-[#172033] text-white'
                                                            : 'text-[#5f7085] hover:text-[#172033]'
                                                    }`}
                                                >
                                                    %
                                                </button>
                                            </div>
                                            <Input
                                                type="number"
                                                min="0"
                                                step="0.01"
                                                value={discountValue}
                                                onChange={event => setDiscountValue(event.target.value)}
                                                maxLength={6}
                                                className="w-24 h-8 text-right tabular-nums"
                                            />
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
                                    <Label className="text-sm text-[#5f7085]">Tax rate</Label>
                                    <Input
                                        className="w-24 text-right tabular-nums"
                                        type="number"
                                        min="0"
                                        step="0.05"
                                        value={taxRate}
                                        onChange={event => setTaxRate(event.target.value)}
                                        onBlur={() => {
                                            const n = Number(taxRate);
                                            if (Number.isFinite(n)) setTaxRate(n.toFixed(2));
                                        }}
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

                        <aside className="space-y-5 border-t border-[#d8e0ea] bg-[#eef3f8] p-5 md:border-l md:border-t-0">
                            <section className="grid gap-3 rounded-md border border-[#d8e0ea] bg-[#fbfcfe] p-4">
                                <p className="text-sm font-semibold">Document settings</p>
                                <div className="flex items-center justify-between">
                                    <span className="text-sm text-[#5f7085]">Require signature</span>
                                    <Checkbox checked={signatureRequired} onCheckedChange={checked => setSignatureRequired(!!checked)} />
                                </div>
                                <div className="flex items-center justify-between text-sm">
                                    <span className="text-[#5f7085]">Deposit required</span>
                                    <span className="font-medium">No</span>
                                </div>
                            </section>
                        </aside>
                    </div>

                    <div className="shrink-0 border-t border-[#d8e0ea] bg-[#fbfcfe] px-5 py-3">
                        <div className="flex flex-wrap items-center justify-end gap-2">
                            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
                            <Button type="button" variant="outline" onClick={() => setPreviewOpen(true)} disabled={!canSave}>
                                Preview
                            </Button>
                            <Button type="button" onClick={handleSave} disabled={saving || !canSave || !!estimate?.archived_at}>
                                {saving ? 'Saving...' : 'Save Estimate'}
                            </Button>
                        </div>
                    </div>
                </div>
            </FloatingDetailPanel>

            <Dialog open={summaryDialogOpen} onOpenChange={setSummaryDialogOpen}>
                <DialogContent variant="panel">
                    <DialogHeader><DialogTitle>Summary</DialogTitle></DialogHeader>
                    <Textarea value={summaryDraft} onChange={event => setSummaryDraft(event.target.value)} rows={10} placeholder="Make, model, serial, failure issue, findings, needs, cause..." />
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => setSummaryDialogOpen(false)}>Cancel</Button>
                        <Button type="button" onClick={saveSummary}>Save Summary</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={itemDialogOpen} onOpenChange={setItemDialogOpen}>
                <DialogContent variant="panel">
                    <DialogHeader><DialogTitle>{editingItemKey ? 'Edit custom item' : 'Add custom item'}</DialogTitle></DialogHeader>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
                        <div className="sm:col-span-2">
                            <Label>Title <span className="text-red-600">*</span></Label>
                            <Input value={itemDraft.name} onChange={event => setItemDraft(prev => ({ ...prev, name: event.target.value }))} autoFocus />
                        </div>
                        <div className="sm:col-span-2">
                            <Label>Description</Label>
                            <Textarea value={itemDraft.description} onChange={event => setItemDraft(prev => ({ ...prev, description: event.target.value }))} rows={4} />
                        </div>
                        <div>
                            <Label>Qty</Label>
                            <Input type="number" min="0.01" step="any" value={itemDraft.quantity} onChange={event => setItemDraft(prev => ({ ...prev, quantity: event.target.value }))} />
                        </div>
                        <div>
                            <Label>Unit price <span className="text-red-600">*</span></Label>
                            <Input type="number" min="0" step="0.01" value={itemDraft.unit_price} onChange={event => setItemDraft(prev => ({ ...prev, unit_price: event.target.value }))} />
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

            <EstimatePreviewDialog open={previewOpen} onOpenChange={setPreviewOpen} estimate={previewEstimate} />
        </>
    );
}
