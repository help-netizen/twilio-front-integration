import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Archive, Check, ChevronDown, Eye, FileText, Link2, Loader2, MoreHorizontal, Pencil, Plus, RotateCcw, Send, Trash2, XCircle } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { MoneyInput } from '../ui/MoneyInput';
import { Label } from '../ui/label';
import { Checkbox } from '../ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Textarea } from '../ui/textarea';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { EstimatePreviewDialog } from './EstimatePreviewDialog';
import { EstimateSendDialog } from './EstimateSendDialog';
import { EstimateItemDialog, type ItemDraft } from './EstimateItemDialog';
import { EstimateSummaryDialog } from './EstimateSummaryDialog';
import { ItemPresetSearchCombobox } from './ItemPresetSearchCombobox';
import { expandGroup } from '../../services/priceBookApi';
import {
    createEstimateItemPreset,
    recordEstimateItemPresetUsage,
    type EstimateItemPreset,
} from '../../services/estimateItemPresetsApi';
import { useAuthz } from '../../hooks/useAuthz';
import { TaskStack } from '../tasks/TaskStack';
import type { Estimate, EstimateEvent, EstimateItem, EstimateSendData, EstimateDiscountType } from '../../services/estimatesApi';
import {
    convertEstimateToInvoice,
    updateEstimate,
    addEstimateItem,
    addEstimateItemsBulk,
    updateEstimateItem,
    deleteEstimateItem,
} from '../../services/estimatesApi';
import { openAuthedPdf } from '../../lib/openAuthedPdf';
import { toast } from 'sonner';

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    draft: 'secondary',
    sent: 'outline',
    viewed: 'outline',
    approved: 'default',
    declined: 'destructive',
};

function money(value: string | number | null | undefined): string {
    return '$' + Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDateTime(value: string | null | undefined): string {
    if (!value) return '-';
    return new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

interface Props {
    estimate: Estimate;
    events: EstimateEvent[];
    loading: boolean;
    onClose: () => void;
    /** @deprecated Edit happens inline; kept for backward compat with older callers. */
    onEdit?: () => void;
    onSend: (data: EstimateSendData) => Promise<any> | void;
    onApprove: () => void;
    onDecline: (reason: string) => Promise<void> | void;
    onArchive: () => void;
    onRestore: () => void;
    onLinkJob: (jobId: number) => void;
    onInvoiceCreated?: () => void;
    /** Called after the panel mutates the estimate so the parent can refetch / update its own state. */
    onChanged?: (estimate: Estimate) => void;
}

export function EstimateDetailPanel({ estimate: initialEstimate, events, loading, onClose: _onClose, onSend, onApprove, onDecline, onArchive, onRestore, onLinkJob, onInvoiceCreated, onChanged }: Props) {
    const navigate = useNavigate();
    const { hasPermission } = useAuthz();
    const canSend = hasPermission('estimates.send');
    // Local copy so we can apply optimistic updates while saving.
    const [estimate, setEstimate] = useState<Estimate>(initialEstimate);
    const [hydrating, setHydrating] = useState(!initialEstimate.items);
    // OB-27 — port of INVOICE-ITEMS-HYDRATE-001: callers frequently pass a LIST
    // row without line items. Without this fetch a healthy estimate rendered
    // "This estimate has no items" and requireItems() blocked Send/Approve even
    // though the items were persisted all along. Hydrate the full record on open.
    useEffect(() => {
        setEstimate(initialEstimate);
        if (initialEstimate.items) { setHydrating(false); return; }
        let cancelled = false;
        setHydrating(true);
        import('../../services/estimatesApi')
            .then(({ fetchEstimate }) => fetchEstimate(initialEstimate.id))
            .then(fresh => { if (!cancelled) setEstimate(fresh); })
            .catch(() => { /* keep the row we have — item mutations still refetch */ })
            .finally(() => { if (!cancelled) setHydrating(false); });
        return () => { cancelled = true; };
    }, [initialEstimate]);

    const [converting, setConverting] = useState(false);
    // Open by default when there IS a summary — the common path is "open to read".
    const [summaryOpen, setSummaryOpen] = useState(!!initialEstimate.summary);
    useEffect(() => { setSummaryOpen(!!initialEstimate.summary); }, [initialEstimate.id, initialEstimate.summary]);
    const [previewOpen, setPreviewOpen] = useState(false);
    const [sendOpen, setSendOpen] = useState(false);
    const [declineOpen, setDeclineOpen] = useState(false);
    const [declineReason, setDeclineReason] = useState('');

    // Inline-edit modals (Summary, Items)
    const [summaryDialogOpen, setSummaryDialogOpen] = useState(false);
    const [itemDialogOpen, setItemDialogOpen] = useState(false);
    const [itemEditingId, setItemEditingId] = useState<number | null>(null);
    const [itemDraft, setItemDraft] = useState<ItemDraft>({ name: '', description: '', quantity: '1', unit_price: '0', taxable: false });

    // Local mirror of edit-only fields (tax rate, discount) for debounced auto-save.
    const [taxRate, setTaxRate] = useState<string>(estimate.tax_rate ? Number(estimate.tax_rate).toFixed(2) : '0');
    const [discountType, setDiscountType] = useState<EstimateDiscountType | null>(estimate.discount_type ?? null);
    const [discountValue, setDiscountValue] = useState<string>(estimate.discount_value ? String(estimate.discount_value) : '0');
    useEffect(() => {
        setTaxRate(estimate.tax_rate ? Number(estimate.tax_rate).toFixed(2) : '0');
        setDiscountType(estimate.discount_type ?? null);
        setDiscountValue(estimate.discount_value ? String(estimate.discount_value) : '0');
    }, [estimate.tax_rate, estimate.discount_type, estimate.discount_value]);

    const archived = !!estimate.archived_at;
    const readOnly = archived;

    const refreshAfterItemChange = async () => {
        try {
            const { fetchEstimate } = await import('../../services/estimatesApi');
            const fresh = await fetchEstimate(estimate.id);
            setEstimate(fresh);
            onChanged?.(fresh);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Refresh failed');
        }
    };

    /** True when the next saveItemDraft should also create a preset (combobox "Create new" flow). */
    const [savePresetOnNextItem, setSavePresetOnNextItem] = useState(false);

    const openNewItem = (prefill?: Partial<ItemDraft>, opts?: { savePreset?: boolean }) => {
        setItemEditingId(null);
        setItemDraft({
            name: prefill?.name ?? '',
            description: prefill?.description ?? '',
            quantity: prefill?.quantity ?? '1',
            unit_price: prefill?.unit_price ?? '0',
            taxable: prefill?.taxable ?? false,
        });
        setSavePresetOnNextItem(!!opts?.savePreset);
        setItemDialogOpen(true);
    };

    /** Combobox: existing preset selected → add to estimate immediately with defaults. */
    const pickPreset = async (preset: EstimateItemPreset) => {
        try {
            await addEstimateItem(estimate.id, {
                name: preset.name,
                description: preset.description || '',
                quantity: String(preset.default_quantity ?? 1),
                unit_price: String(preset.default_unit_price ?? 0),
                taxable: !!preset.default_taxable,
            } as any);
            // Fire-and-forget usage bump (no await — non-blocking).
            recordEstimateItemPresetUsage(preset.id).catch(() => {});
            await refreshAfterItemChange();
            toast.success(`Added "${preset.name}"`);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Add failed');
        }
    };

    /** Combobox: picked a Price Book group → expand into its items (single bulk add). */
    const pickGroup = async (groupId: number) => {
        try {
            const items = await expandGroup(groupId);
            if (items.length === 0) { toast.info('That group has no active items'); return; }
            await addEstimateItemsBulk(estimate.id, items.map(i => ({
                name: i.name, description: i.description, quantity: i.quantity,
                unit: i.unit || undefined, unit_price: i.unit_price, taxable: i.taxable,
            })) as any);
            await refreshAfterItemChange();
            toast.success(`Added ${items.length} item(s) from group`);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Add failed');
        }
    };

    /** Combobox: typed a name not in catalog → open modal pre-filled; on Save also create preset. */
    const startCreateFromName = (name: string) => {
        openNewItem({ name }, { savePreset: true });
    };
    const openEditItem = (item: EstimateItem) => {
        setItemEditingId(item.id);
        setItemDraft({
            name: item.name || '',
            description: item.description || '',
            quantity: String(item.quantity ?? '1'),
            unit_price: String(item.unit_price ?? '0'),
            taxable: !!item.taxable,
        });
        setItemDialogOpen(true);
    };
    const saveItemDraft = async (draft: ItemDraft) => {
        try {
            const payload = {
                name: draft.name.trim(),
                description: draft.description,
                quantity: draft.quantity,
                unit_price: draft.unit_price,
                taxable: draft.taxable,
            };
            if (itemEditingId == null) {
                await addEstimateItem(estimate.id, payload as any);
                // Combobox "Create new" path — also persist to the company catalog
                // so the item is searchable on future estimates.
                if (savePresetOnNextItem) {
                    try {
                        const preset = await createEstimateItemPreset({
                            name: payload.name,
                            description: payload.description || null,
                            default_quantity: Number(payload.quantity) || 1,
                            default_unit_price: Number(payload.unit_price) || 0,
                            default_taxable: !!payload.taxable,
                        });
                        recordEstimateItemPresetUsage(preset.id).catch(() => {});
                        toast.success(`Created "${preset.name}" and added to estimate`);
                    } catch (err) {
                        toast.error(`Item added, but failed to save preset: ${err instanceof Error ? err.message : String(err)}`);
                    } finally {
                        setSavePresetOnNextItem(false);
                    }
                }
            } else {
                await updateEstimateItem(estimate.id, itemEditingId, payload as any);
            }
            await refreshAfterItemChange();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Save failed');
        }
    };
    const handleRemoveItem = async (id: number) => {
        try {
            await deleteEstimateItem(estimate.id, id);
            await refreshAfterItemChange();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Remove failed');
        }
    };
    const saveSummary = async (text: string) => {
        await persist({ summary: text } as any);
    };

    // Save helper — applies optimistic update and notifies parent.
    const saving = useRef(false);
    const persist = async (patch: Partial<Estimate>) => {
        if (readOnly) return;
        if (saving.current) return;
        saving.current = true;
        try {
            const updated = await updateEstimate(estimate.id, patch as any);
            setEstimate(updated);
            onChanged?.(updated);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Save failed');
        } finally {
            saving.current = false;
        }
    };
    const hasItems = !!estimate.items?.length;

    const handleConvertToInvoice = async () => {
        setConverting(true);
        try {
            const invoice = await convertEstimateToInvoice(estimate.id);
            toast.success('Invoice created from estimate');
            onInvoiceCreated?.();
            // Navigate to invoices and open the new invoice automatically.
            navigate(`/invoices?openId=${invoice.id}`);
        } catch (err: any) {
            toast.error(err.message || 'Failed to create invoice');
        } finally {
            setConverting(false);
        }
    };

    const submitDecline = async () => {
        if (!declineReason.trim()) return;
        await onDecline(declineReason.trim());
        setDeclineOpen(false);
        setDeclineReason('');
    };

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
        );
    }

    const requireItems = () => {
        if (hasItems) return true;
        toast.error('Estimate has no items');
        return false;
    };

    const openLinkJobPrompt = () => {
        const jobId = prompt('Enter Job ID to link:');
        if (jobId && !Number.isNaN(Number(jobId))) onLinkJob(Number(jobId));
    };

    return (
        <div className={`flex h-full min-h-0 flex-col bg-[var(--blanc-panel-surface,#fffdf9)] text-[var(--blanc-ink-1)] ${archived ? 'grayscale opacity-60' : ''}`}>
            <div className="shrink-0 border-b border-[var(--blanc-line)] bg-[var(--blanc-panel-surface,#fffdf9)] px-5 py-4 pr-14">
                <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        {estimate.job_id ? (
                            <a
                                href={`/jobs/${estimate.job_id}`}
                                onClick={e => { e.preventDefault(); window.open(`/jobs/${estimate.job_id}`, '_blank', 'noopener,noreferrer'); }}
                                className="font-mono text-sm font-semibold text-blue-600 hover:underline"
                                title={`Open Job #${estimate.job_number || estimate.job_id}`}
                            >
                                {estimate.estimate_number}
                            </a>
                        ) : (
                            <span className="font-mono text-sm font-semibold">{estimate.estimate_number}</span>
                        )}
                        <Badge variant={STATUS_VARIANT[estimate.status] || 'secondary'} className="capitalize">{estimate.status}</Badge>
                        {archived && <Badge variant="outline">Archived</Badge>}
                        {estimate.invoice_number && <Badge variant="outline">Invoice #{estimate.invoice_number}</Badge>}
                    </div>
                    <p className="mt-1 text-sm text-[var(--blanc-ink-2)]">{estimate.contact_name || 'No customer linked'}</p>
                </div>
                <div className="flex items-start gap-3">
                    <div className="text-right">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--blanc-ink-3)]">Total</p>
                        <p className="font-mono text-xl font-semibold">{money(estimate.total)}</p>
                    </div>
                </div>
                </div>
            </div>

            {/* ONE scroll surface at every width (design review 2026-07-23): the old
                per-column overflow-y-auto pair split the mobile viewport into two
                half-height scroll boxes — the meta column ate half the screen and
                scrolling only worked in whichever half you tapped first. Desktop keeps
                two columns inside the shared scroll; the meta column is sticky. */}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                <div className="grid md:grid-cols-[minmax(0,1fr)_300px] md:gap-8">
                <main className="space-y-6 p-5 md:py-6 md:pl-6 md:pr-0">
                    {/* Summary — OB-28: same presentation as the create/edit form (owner):
                        dashed invite block when empty, collapsible card when filled. */}
                    {estimate.summary ? (
                        <section className="rounded-md border border-[var(--blanc-line)] bg-[var(--blanc-panel-surface,#fffdf9)]">
                            <div className="flex items-center justify-between px-4 py-3">
                                <button
                                    type="button"
                                    onClick={() => setSummaryOpen(o => !o)}
                                    className="flex flex-1 items-center gap-2 text-left text-sm font-medium"
                                >
                                    <ChevronDown className={`size-4 text-[var(--blanc-ink-3)] transition-transform ${summaryOpen ? 'rotate-180' : ''}`} />
                                    Summary
                                </button>
                                {!readOnly && (
                                    <Button type="button" size="sm" variant="ghost" className="size-7 p-0" onClick={() => setSummaryDialogOpen(true)} title="Edit summary">
                                        <Pencil className="size-4" />
                                    </Button>
                                )}
                            </div>
                            {summaryOpen && (
                                <div className="border-t border-[var(--blanc-line)] px-4 py-4 text-sm whitespace-pre-wrap text-[var(--blanc-ink-2)]">{estimate.summary}</div>
                            )}
                        </section>
                    ) : (
                        <div className="rounded-md border border-dashed border-[var(--blanc-line)] px-4 py-5" style={{ background: 'rgba(25,25,25,0.03)' }}>
                            <p className="text-sm font-medium">Summary</p>
                            <p className="mt-1 text-sm text-[var(--blanc-ink-3)]">Add make, model, issue, findings, needs, and cause when the estimate needs client context.</p>
                            {!readOnly && (
                                <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => setSummaryDialogOpen(true)}>
                                    <Plus className="mr-1 size-4" /> Add summary
                                </Button>
                            )}
                        </div>
                    )}

                    {/* Items */}
                    <section>
                        <div className="mb-3 flex items-end justify-between gap-3">
                            <div>
                                <p className="blanc-eyebrow">Items</p>
                            </div>
                        </div>
                        {hasItems ? (
                            <div className="space-y-2">
                                {estimate.items!.map(item => (
                                    /* Tile: name↔amount header, full-width description, meta row
                                       with actions — no dead right gutter on narrow widths. */
                                    <div
                                        key={item.id}
                                        className={`rounded-md border border-[var(--blanc-line)] bg-[var(--blanc-panel-surface,#fffdf9)] p-4 text-sm transition-colors ${readOnly ? '' : 'cursor-pointer hover:bg-white'}`}
                                        onClick={() => { if (!readOnly) openEditItem(item); }}
                                    >
                                        <div className="flex items-start justify-between gap-3">
                                            <p className="min-w-0 font-medium">{item.name}</p>
                                            <p className="shrink-0 font-mono font-semibold whitespace-nowrap">{money(item.amount)}</p>
                                        </div>
                                        {item.description && <p className="mt-1 whitespace-pre-wrap text-[var(--blanc-ink-2)]">{item.description}</p>}
                                        <div className="mt-2 flex items-center gap-2 text-xs text-[var(--blanc-ink-2)]">
                                            <span>{Number(item.quantity)} × {money(item.unit_price)}</span>
                                            {item.taxable && <Badge variant="outline" className="text-[10px]">Taxable</Badge>}
                                            {!readOnly && (
                                                <span className="ml-auto flex items-center gap-1">
                                                    <Button type="button" size="sm" variant="ghost" className="size-7 p-0" onClick={(e) => { e.stopPropagation(); openEditItem(item); }} title="Edit item">
                                                        <Pencil className="size-4" />
                                                    </Button>
                                                    <Button type="button" size="sm" variant="ghost" className="size-7 p-0 text-red-600" onClick={(e) => { e.stopPropagation(); handleRemoveItem(item.id); }} title="Remove item">
                                                        <Trash2 className="size-4" />
                                                    </Button>
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : hydrating ? (
                            <div className="flex items-center gap-2 rounded-md border border-[var(--blanc-line)] px-4 py-3 text-sm text-[var(--blanc-ink-2)]">
                                <Loader2 className="size-4 animate-spin" /> Loading items…
                            </div>
                        ) : (
                            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                                This estimate has no items. Add at least one priced item before sending or approving.
                            </div>
                        )}
                        {!readOnly && (
                            <div className="mt-3">
                                <ItemPresetSearchCombobox
                                    onPickPreset={pickPreset}
                                    onCreateNew={startCreateFromName}
                                    onPickGroup={pickGroup}
                                />
                            </div>
                        )}
                    </section>

                    {/* Totals (editable Tax rate / Discount) */}
                    <section className="rounded-md border border-[var(--blanc-line)] bg-[var(--blanc-panel-surface,#fffdf9)] p-4">
                        <p className="mb-3 blanc-eyebrow">Totals</p>
                        <div className="space-y-2 text-sm">
                            <div className="flex justify-between">
                                <span className="text-[var(--blanc-ink-2)]">Subtotal</span>
                                <span className="font-mono">{money(estimate.subtotal)}</span>
                            </div>
                            {discountType ? (
                                /* OB-24: wrap so the amount drops to its own line on narrow widths. */
                                <div className="flex flex-wrap items-center gap-2 text-sm">
                                    <span className="text-[var(--blanc-ink-2)]">Discount</span>
                                    <div className="inline-flex rounded-[10px] border border-[var(--blanc-line)] p-0.5 bg-[var(--blanc-panel-surface,#fffdf9)] shrink-0">
                                        <button
                                            type="button"
                                            disabled={readOnly}
                                            onClick={() => { setDiscountType('fixed'); persist({ discount_type: 'fixed', discount_value: discountValue || '0' } as any); }}
                                            className={`px-2.5 py-0.5 rounded-md text-sm transition-colors ${discountType === 'fixed' ? 'bg-[var(--blanc-ink-1)] text-white' : 'text-[var(--blanc-ink-2)] hover:text-[var(--blanc-ink-1)]'}`}
                                        >$</button>
                                        <button
                                            type="button"
                                            disabled={readOnly}
                                            onClick={() => { setDiscountType('percentage'); persist({ discount_type: 'percentage', discount_value: discountValue || '0' } as any); }}
                                            className={`px-2.5 py-0.5 rounded-md text-sm transition-colors ${discountType === 'percentage' ? 'bg-[var(--blanc-ink-1)] text-white' : 'text-[var(--blanc-ink-2)] hover:text-[var(--blanc-ink-1)]'}`}
                                        >%</button>
                                    </div>
                                    {discountType === 'fixed' ? (
                                        <MoneyInput
                                            value={discountValue}
                                            onValueChange={setDiscountValue}
                                            onBlur={() => persist({ discount_value: discountValue || '0' } as any)}
                                            disabled={readOnly}
                                            className="h-8 w-24 rounded-[10px] border-[1.5px] border-transparent bg-[var(--blanc-field,#F0F0F0)] px-3 text-right text-sm tabular-nums outline-none transition-colors focus-visible:border-[var(--blanc-ink-2)] disabled:opacity-50"
                                        />
                                    ) : (
                                        <Input
                                            type="text"
                                            inputMode="decimal"
                                            value={discountValue}
                                            onChange={e => setDiscountValue(e.target.value.replace(/[^0-9.]/g, ''))}
                                            onBlur={() => persist({ discount_value: discountValue || '0' } as any)}
                                            disabled={readOnly}
                                            className="w-24 h-8 text-right tabular-nums"
                                        />
                                    )}
                                    <Button type="button" variant="ghost" size="sm" className="size-8 p-0 shrink-0" disabled={readOnly} onClick={() => { setDiscountType(null); setDiscountValue('0'); persist({ discount_type: null, discount_value: '0' } as any); }} title="Remove discount">
                                        <Trash2 className="size-4" />
                                    </Button>
                                    <span className="font-mono text-red-600 ml-auto">-{money(estimate.discount_amount)}</span>
                                </div>
                            ) : !readOnly && (
                                <button type="button" className="text-sm text-blue-600" onClick={() => { setDiscountType('fixed'); setDiscountValue('0'); persist({ discount_type: 'fixed', discount_value: '0' } as any); }}>
                                    Add Discount
                                </button>
                            )}
                            <div className="grid grid-cols-[1fr_auto] items-center gap-3">
                                <Label className="text-sm text-[var(--blanc-ink-2)]">Tax rate</Label>
                                <div className="relative w-24">
                                    <Input
                                        type="text"
                                        inputMode="decimal"
                                        value={taxRate}
                                        onChange={e => setTaxRate(e.target.value.replace(/[^0-9.]/g, ''))}
                                        onBlur={() => {
                                            const n = Number(taxRate);
                                            const formatted = Number.isFinite(n) ? n.toFixed(2) : '0';
                                            setTaxRate(formatted);
                                            persist({ tax_rate: formatted } as any);
                                        }}
                                        disabled={readOnly}
                                        className="h-8 w-full pr-7 text-right tabular-nums"
                                    />
                                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-[var(--blanc-ink-3)]">%</span>
                                </div>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-[var(--blanc-ink-2)]">Tax</span>
                                <span className="font-mono">{money(estimate.tax_amount)}</span>
                            </div>
                            <div className="flex justify-between border-t pt-2 text-base font-semibold">
                                <span>Total</span>
                                <span className="font-mono">{money(estimate.total)}</span>
                            </div>
                        </div>
                    </section>
                </main>

                {/* Meta column: invisible container (no tint, no border) — flows under
                    the document on mobile, sticks beside it on desktop. */}
                <aside className="space-y-6 px-5 pb-6 md:sticky md:top-0 md:self-start md:py-6 md:pl-0 md:pr-6">
                    {/* Tasks are meta, not document content — they live beside the
                        document (desktop) / after it (mobile), so the first screen
                        belongs to the estimate itself (green-path review). */}
                    <TaskStack parentType="estimate" parentId={estimate.id} title="Tasks" />

                    <section className="space-y-3 text-sm">
                        <p className="blanc-eyebrow">Document settings</p>
                        <label className="flex items-center justify-between cursor-pointer">
                            <span className="text-[var(--blanc-ink-2)]">Require signature</span>
                            <Checkbox
                                checked={!!estimate.signature_required}
                                disabled={readOnly}
                                onCheckedChange={(checked) => persist({ signature_required: !!checked } as any)}
                            />
                        </label>
                        <div className="flex items-center justify-between">
                            <span className="text-[var(--blanc-ink-2)]">Deposit required</span>
                            <span className="font-medium">No</span>
                        </div>
                    </section>

                    {estimate.signature_required && (
                        <section className="space-y-3 text-sm">
                            <p className="blanc-eyebrow">Signature</p>
                            {estimate.signature_consented_at ? (
                                <div className="flex items-start gap-2">
                                    <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
                                    <div>
                                        <p className="font-medium">Signed by {estimate.signature_name || 'customer'}</p>
                                        <p className="text-xs text-[var(--blanc-ink-3)]">{fmtDateTime(estimate.signature_consented_at)}</p>
                                    </div>
                                </div>
                            ) : (
                                <div className="flex items-start gap-2">
                                    <span className="mt-1.5 size-2 shrink-0 rounded-full bg-amber-500" />
                                    <div>
                                        <p className="font-medium">Awaiting signature</p>
                                        <p className="text-xs text-[var(--blanc-ink-3)]">The customer signs when viewing the estimate.</p>
                                    </div>
                                </div>
                            )}
                        </section>
                    )}

                    {events.length > 0 && (
                        <section className="space-y-3 text-sm">
                            <p className="blanc-eyebrow">History</p>
                            <div className="space-y-2.5">
                                {events.map(evt => (
                                    <div key={evt.id} className="text-xs">
                                        <span className="font-medium capitalize">{evt.event_type.replace(/_/g, ' ')}</span>
                                        <p className="text-[var(--blanc-ink-3)]">{fmtDateTime(evt.created_at)}</p>
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}
                </aside>
                </div>
            </div>

            <div className="shrink-0 border-t border-[var(--blanc-line)] bg-[var(--blanc-panel-surface,#fffdf9)] px-5 py-3">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div className="grid grid-cols-2 gap-2 md:flex">
                        <Button variant="outline" size="sm" onClick={() => {
                            openAuthedPdf(`/api/estimates/${estimate.id}/pdf`, `${estimate.estimate_number || `Estimate-${estimate.id}`}.pdf`)
                                .catch(() => toast.error('Could not open the PDF'));
                        }}>
                            <Eye className="mr-1 size-3.5" />Preview PDF
                        </Button>
                    </div>
                    <div className="flex flex-wrap gap-2 md:justify-end">
                        {!archived ? (
                            <>
                                {canSend && (
                                    <Button
                                        variant={estimate.status === 'draft' || estimate.status === 'sent' || estimate.status === 'viewed' ? 'default' : 'outline'}
                                        size="sm"
                                        onClick={() => { if (requireItems()) setSendOpen(true); }}
                                    >
                                        <Send className="mr-1 size-3.5" />Send
                                    </Button>
                                )}
                                {estimate.status !== 'approved' && (
                                    <Button
                                        variant={estimate.status === 'sent' || estimate.status === 'viewed' ? 'default' : 'outline'}
                                        size="sm"
                                        onClick={() => { if (requireItems()) onApprove(); }}
                                    >
                                        <Check className="mr-1 size-3.5" />Approved
                                    </Button>
                                )}
                                {estimate.status === 'approved' && !estimate.invoice_id && (
                                    <Button size="sm" onClick={handleConvertToInvoice} disabled={converting}>
                                        <FileText className="mr-1 size-3.5" />{converting ? 'Creating...' : 'Create Invoice'}
                                    </Button>
                                )}
                                {estimate.invoice_id && (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => navigate(`/invoices?openId=${estimate.invoice_id}`)}
                                        title={`Open ${estimate.invoice_number || 'invoice'}`}
                                    >
                                        <FileText className="mr-1 size-3.5" />Open invoice
                                    </Button>
                                )}
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <Button variant="outline" size="sm">
                                            <MoreHorizontal className="mr-1 size-3.5" />More
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" className="w-44">
                                        {estimate.status !== 'declined' && (
                                            <DropdownMenuItem onSelect={() => setDeclineOpen(true)}>
                                                <XCircle className="size-4" />Decline
                                            </DropdownMenuItem>
                                        )}
                                        {!estimate.job_id && (
                                            <DropdownMenuItem onSelect={openLinkJobPrompt}>
                                                <Link2 className="size-4" />Link Job
                                            </DropdownMenuItem>
                                        )}
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem className="text-red-600 focus:text-red-700" onSelect={onArchive}>
                                            <Archive className="size-4" />Archive
                                        </DropdownMenuItem>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </>
                        ) : (
                            <Button variant="outline" size="sm" onClick={onRestore}>
                                <RotateCcw className="mr-1 size-3.5" />Restore to draft
                            </Button>
                        )}
                    </div>
                </div>
            </div>

            <EstimateSummaryDialog
                open={summaryDialogOpen}
                onOpenChange={setSummaryDialogOpen}
                initial={estimate.summary || ''}
                onSave={saveSummary}
            />
            <EstimateItemDialog
                open={itemDialogOpen}
                onOpenChange={setItemDialogOpen}
                isEdit={itemEditingId != null}
                initial={itemDraft}
                onSave={saveItemDraft}
            />

            <EstimatePreviewDialog open={previewOpen} onOpenChange={setPreviewOpen} estimate={estimate} />
            <EstimateSendDialog
                open={sendOpen}
                onOpenChange={setSendOpen}
                estimateId={estimate.id}
                contactEmail={estimate.contact_email || ''}
                contactPhone={estimate.contact_phone || ''}
                estimateNumber={estimate.estimate_number}
                contactName={estimate.contact_name || ''}
                onSend={async data => {
                    await onSend(data);
                }}
            />

            <Dialog open={declineOpen} onOpenChange={setDeclineOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader><DialogTitle>Decline estimate</DialogTitle></DialogHeader>
                    <Textarea value={declineReason} onChange={event => setDeclineReason(event.target.value)} rows={4} placeholder="Reason or comment" />
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setDeclineOpen(false)}>Cancel</Button>
                        <Button onClick={submitDecline} disabled={!declineReason.trim()}>Decline</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
