import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, Pencil, Plus, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { Checkbox } from '../ui/checkbox';
import { Badge } from '../ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import { DEFAULT_TERMS_AND_WARRANTY, EstimatePreviewDialog } from './EstimatePreviewDialog';
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

function itemMeta(item: LineItem): string {
    return `${Number(item.quantity) || 0} x ${money(item.unit_price)}`;
}

export function EstimateEditorDialog({ open, onOpenChange, estimate, defaultJobId, defaultLeadId, defaultEstimateNumber, defaultContext, onSave }: Props) {
    const isEdit = !!estimate;
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
        setTaxRate(estimate?.tax_rate || '0');
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

    const openNewItemDialog = () => {
        setEditingItemKey(null);
        setItemDraft(emptyItem());
        setItemDialogOpen(true);
    };

    const openEditItemDialog = (item: LineItem) => {
        setEditingItemKey(item.key);
        setItemDraft({ ...item });
        setItemDialogOpen(true);
    };

    const saveItem = () => {
        if (!itemDraft.name.trim() || Number(itemDraft.quantity) <= 0 || Number(itemDraft.unit_price) < 0) return;
        const nextItem = { ...itemDraft, name: itemDraft.name.trim() };
        setItems(prev => editingItemKey
            ? prev.map(item => item.key === editingItemKey ? nextItem : item)
            : [...prev, { ...nextItem, key: newKey() }]
        );
        setItemDialogOpen(false);
    };

    const removeItem = (key: string) => {
        setItems(prev => prev.filter(item => item.key !== key));
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
                <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" style={{ background: 'var(--blanc-surface-strong)' }}>
                    <DialogHeader>
                        <DialogTitle className="flex items-center justify-between gap-3">
                            <span>{isEdit ? estimate?.estimate_number : 'New Estimate'}</span>
                            {estimate?.archived_at && <Badge variant="outline">Archived</Badge>}
                        </DialogTitle>
                    </DialogHeader>

                    <div className="space-y-5 py-2">
                        {defaultContext && !isEdit && (
                            <div className="text-xs font-medium text-muted-foreground">{defaultContext}</div>
                        )}

                        {estimate && estimate.status !== 'draft' && !estimate.archived_at && (
                            <div className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                                <span>This estimate is {estimate.status}. Editing will move it back to draft; send the updated version to the client after saving.</span>
                            </div>
                        )}

                        {summary ? (
                            <Collapsible open={summaryOpen} onOpenChange={setSummaryOpen}>
                                <div className="rounded-md border bg-white/60">
                                    <div className="flex items-center justify-between px-3 py-2">
                                        <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium">
                                            <ChevronDown className={`size-4 transition-transform ${summaryOpen ? 'rotate-180' : ''}`} />
                                            Summary
                                        </CollapsibleTrigger>
                                        <Button type="button" size="sm" variant="ghost" onClick={openSummaryDialog}>
                                            <Pencil className="size-4" />
                                        </Button>
                                    </div>
                                    <CollapsibleContent>
                                        <div className="border-t px-3 py-3 text-sm whitespace-pre-wrap text-muted-foreground">{summary}</div>
                                    </CollapsibleContent>
                                </div>
                            </Collapsible>
                        ) : (
                            <Button type="button" variant="outline" size="sm" onClick={openSummaryDialog}>
                                <Plus className="mr-1 size-4" /> Add Summary
                            </Button>
                        )}

                        <section className="space-y-3">
                            <div className="flex items-center justify-between">
                                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Items</p>
                            </div>

                            <div className="space-y-2">
                                {items.map(item => (
                                    <div
                                        key={item.key}
                                        className="grid cursor-pointer grid-cols-[1fr_auto_auto_auto] items-start gap-3 rounded-md border bg-white/70 p-3 transition-colors hover:bg-white"
                                        onClick={() => openEditItemDialog(item)}
                                    >
                                        <div className="min-w-0">
                                            <p className="font-medium">{item.name}</p>
                                            {item.description && <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{item.description}</p>}
                                            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                                <span>{itemMeta(item)}</span>
                                                <Badge variant="outline" className="text-[10px]">{item.taxable ? 'Taxable' : 'Non-taxable'}</Badge>
                                            </div>
                                        </div>
                                        <p className="pt-0.5 font-mono text-sm font-semibold">{money(amount(item))}</p>
                                        <Button type="button" size="sm" variant="ghost" className="size-7 p-0" onClick={(event) => { event.stopPropagation(); openEditItemDialog(item); }}>
                                            <Pencil className="size-4" />
                                        </Button>
                                        <Button type="button" size="sm" variant="ghost" className="size-7 p-0 text-red-600" onClick={(event) => { event.stopPropagation(); removeItem(item.key); }}>
                                            <Trash2 className="size-4" />
                                        </Button>
                                    </div>
                                ))}
                            </div>

                            <Button type="button" variant="outline" size="sm" onClick={openNewItemDialog}>
                                <Plus className="mr-1 size-4" /> Add custom item
                            </Button>
                        </section>

                        <section className="space-y-2 rounded-md border bg-white/60 p-3">
                            <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">Subtotal</span>
                                <span className="font-mono">{money(subtotal)}</span>
                            </div>
                            {discountType ? (
                                <div className="space-y-2">
                                    <div className="grid grid-cols-[140px_1fr_auto] items-center gap-2">
                                        <Select value={discountType} onValueChange={value => setDiscountType(value as EstimateDiscountType)}>
                                            <SelectTrigger><SelectValue /></SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="fixed">Discount $</SelectItem>
                                                <SelectItem value="percentage">Discount %</SelectItem>
                                            </SelectContent>
                                        </Select>
                                        <Input type="number" min="0" step="0.01" value={discountValue} onChange={event => setDiscountValue(event.target.value)} />
                                        <Button type="button" variant="ghost" size="sm" onClick={() => { setDiscountType(null); setDiscountValue('0'); }}>
                                            <Trash2 className="size-4" />
                                        </Button>
                                    </div>
                                    {discountError && <p className="text-xs text-red-600">{discountError}</p>}
                                    <div className="flex justify-between text-sm">
                                        <span className="text-muted-foreground">Discount</span>
                                        <span className="font-mono text-red-600">-{money(discountAmount)}</span>
                                    </div>
                                </div>
                            ) : (
                                <button type="button" className="text-sm text-blue-600" onClick={() => { setDiscountType('fixed'); setDiscountValue('0'); }}>
                                    Add Discount
                                </button>
                            )}
                            <div className="grid grid-cols-[1fr_auto] items-center gap-3">
                                <Label className="text-sm text-muted-foreground">Tax rate</Label>
                                <Input className="w-28 text-right" type="number" min="0" step="0.01" value={taxRate} onChange={event => setTaxRate(event.target.value)} />
                            </div>
                            <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">Tax</span>
                                <span className="font-mono">{money(taxAmount)}</span>
                            </div>
                            <div className="flex justify-between border-t pt-2 text-base font-semibold">
                                <span>Total</span>
                                <span className="font-mono">{money(total)}</span>
                            </div>
                        </section>

                        <section className="grid gap-3 rounded-md border bg-white/60 p-3">
                            <div className="flex items-center justify-between">
                                <span className="text-sm text-muted-foreground">Require signature</span>
                                <Checkbox checked={signatureRequired} onCheckedChange={checked => setSignatureRequired(!!checked)} />
                            </div>
                            <div className="flex items-center justify-between text-sm">
                                <span className="text-muted-foreground">Deposit required</span>
                                <span className="font-medium">No</span>
                            </div>
                        </section>

                        <Collapsible open={termsOpen} onOpenChange={setTermsOpen}>
                            <div className="rounded-md border bg-white/60">
                                <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium">
                                    <ChevronDown className={`size-4 transition-transform ${termsOpen ? 'rotate-180' : ''}`} />
                                    Terms & Warranty
                                </CollapsibleTrigger>
                                <CollapsibleContent>
                                    <div className="border-t px-3 py-3 text-sm whitespace-pre-wrap text-muted-foreground">{DEFAULT_TERMS_AND_WARRANTY}</div>
                                </CollapsibleContent>
                            </div>
                        </Collapsible>
                    </div>

                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
                        <Button type="button" variant="outline" onClick={() => setPreviewOpen(true)} disabled={!canSave}>
                            Preview
                        </Button>
                        <Button type="button" onClick={handleSave} disabled={saving || !canSave || !!estimate?.archived_at}>
                            {saving ? 'Saving...' : 'Save Estimate'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={summaryDialogOpen} onOpenChange={setSummaryDialogOpen}>
                <DialogContent className="max-w-xl">
                    <DialogHeader><DialogTitle>Summary</DialogTitle></DialogHeader>
                    <Textarea value={summaryDraft} onChange={event => setSummaryDraft(event.target.value)} rows={10} placeholder="Make, model, serial, failure issue, findings, needs, cause..." />
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => setSummaryDialogOpen(false)}>Cancel</Button>
                        <Button type="button" onClick={saveSummary}>Save Summary</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={itemDialogOpen} onOpenChange={setItemDialogOpen}>
                <DialogContent className="max-w-lg">
                    <DialogHeader><DialogTitle>{editingItemKey ? 'Edit custom item' : 'Add custom item'}</DialogTitle></DialogHeader>
                    <div className="space-y-4">
                        <div>
                            <Label>Title <span className="text-red-600">*</span></Label>
                            <Input value={itemDraft.name} onChange={event => setItemDraft(prev => ({ ...prev, name: event.target.value }))} autoFocus />
                        </div>
                        <div>
                            <Label>Description</Label>
                            <Textarea value={itemDraft.description} onChange={event => setItemDraft(prev => ({ ...prev, description: event.target.value }))} rows={4} />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <Label>Qty</Label>
                                <Input type="number" min="0.01" step="any" value={itemDraft.quantity} onChange={event => setItemDraft(prev => ({ ...prev, quantity: event.target.value }))} />
                            </div>
                            <div>
                                <Label>Unit price <span className="text-red-600">*</span></Label>
                                <Input type="number" min="0" step="0.01" value={itemDraft.unit_price} onChange={event => setItemDraft(prev => ({ ...prev, unit_price: event.target.value }))} />
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
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
