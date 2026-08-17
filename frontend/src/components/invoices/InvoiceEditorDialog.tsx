import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Loader2, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { aiDraftEstimate } from '../../services/estimatesApi';
import { expandGroup } from '../../services/priceBookApi';
import {
    createEstimateItemPreset,
    recordEstimateItemPresetUsage,
    type EstimateItemPreset,
} from '../../services/estimateItemPresetsApi';
import type { HydratedInvoice, InvoiceCreateData } from '../../services/invoicesApi';
import { useAuthz } from '../../hooks/useAuthz';
import { useIsMobile } from '../../hooks/useIsMobile';
import { FullScreenTextEditor } from '../shared/FullScreenTextEditor';
import {
    Dialog,
    DialogBody,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogPanelFooter,
    DialogPanelHeader,
    DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { FloatingField, FloatingLabel } from '../ui/floating-field';
import { MoneyInput } from '../ui/MoneyInput';
import { OverlayClose } from '../ui/OverlayClose';
import {
    OrderListSection,
    makeOrderRow,
    serializeOrderList,
    type OrderRow,
} from '../estimates/OrderListSection';
import { InvoiceConfirmDialog } from './InvoiceConfirmDialog';
import { InvoiceItemSheet, type InvoiceItemDraft } from './InvoiceItemSheet';

interface LineItem extends InvoiceItemDraft {
    key: string;
}

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    invoice: HydratedInvoice | null;
    defaultJobId?: number;
    defaultLeadId?: number;
    defaultContactId?: number;
    defaultEstimateId?: number;
    defaultContext?: string;
    onSave: (data: InvoiceCreateData) => Promise<void>;
}

const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const emptyItem = (): LineItem => ({
    key: newKey(),
    name: '',
    description: '',
    quantity: '1',
    unit_price: '0',
    taxable: true,
});

function money(value: number | string | null | undefined): string {
    const amount = Number(value || 0);
    const body = Math.abs(amount).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
    return (amount < 0 ? '−$' : '$') + body;
}

function amount(item: InvoiceItemDraft): number {
    return (Number(item.quantity) || 0) * (Number(item.unit_price) || 0);
}

function invoiceItems(invoice: HydratedInvoice | null): LineItem[] {
    return (invoice?.items ?? []).map(item => ({
        key: newKey(),
        name: item.name,
        description: item.description || '',
        quantity: String(item.quantity ?? '1'),
        unit_price: String(item.unit_price ?? '0'),
        taxable: !!item.taxable,
    }));
}

function editorSnapshot(input: {
    summary: string;
    items: LineItem[];
    taxRate: string;
    discountType: 'fixed' | 'percentage' | null;
    discountValue: string;
    aiReport: string;
    orderList: OrderRow[];
}): string {
    return JSON.stringify({
        summary: input.summary,
        items: input.items.map(({ key: _key, ...item }) => item),
        taxRate: input.taxRate,
        discountType: input.discountType,
        discountValue: input.discountValue,
        aiReport: input.aiReport,
        orderList: input.orderList.map(({ key: _key, ...row }) => row),
    });
}

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
    const isMobile = useIsMobile();
    const { hasPermission } = useAuthz();
    const canManagePriceBook = hasPermission('price_book.manage');
    const baseline = useRef('');

    const [summary, setSummary] = useState('');
    const [summaryDialogOpen, setSummaryDialogOpen] = useState(false);
    const [summaryDraft, setSummaryDraft] = useState('');
    const [items, setItems] = useState<LineItem[]>([]);
    const [taxRate, setTaxRate] = useState('0');
    const [discountType, setDiscountType] = useState<'fixed' | 'percentage' | null>(null);
    const [discountValue, setDiscountValue] = useState('0');
    const [saving, setSaving] = useState(false);
    const [aiReport, setAiReport] = useState('');
    const [aiGenerationId, setAiGenerationId] = useState<number | null>(null);
    const [aiGenerating, setAiGenerating] = useState(false);
    const [reportToEstimateOff, setReportToEstimateOff] = useState(false);
    const [reportEditorOpen, setReportEditorOpen] = useState(false);
    const [orderList, setOrderList] = useState<OrderRow[]>([]);
    const [itemSheetOpen, setItemSheetOpen] = useState(false);
    const [editingItemKey, setEditingItemKey] = useState<string | null>(null);
    const [itemDraft, setItemDraft] = useState<LineItem>(emptyItem());
    const [savePresetOnNextItem, setSavePresetOnNextItem] = useState(false);
    const [discardOpen, setDiscardOpen] = useState(false);

    useEffect(() => {
        if (!open) return;
        const nextItems = invoiceItems(invoice);
        const initialDiscount = Number(invoice?.discount_amount) || 0;
        const nextDiscountType = initialDiscount > 0 ? 'fixed' as const : null;
        const nextDiscountValue = initialDiscount > 0 ? String(initialDiscount) : '0';
        const nextTaxRate = invoice?.tax_rate ? Number(invoice.tax_rate).toFixed(2) : '0';
        const nextOrderList = (invoice?.order_list || []).map(part => (
            makeOrderRow(part.part_number, part.part_name, String(part.quantity))
        ));
        const nextSummary = invoice?.notes || '';

        setSummary(nextSummary);
        setSummaryDialogOpen(false);
        setItems(nextItems);
        setTaxRate(nextTaxRate);
        setDiscountType(nextDiscountType);
        setDiscountValue(nextDiscountValue);
        setAiReport('');
        setAiGenerationId(null);
        setOrderList(nextOrderList);
        setItemSheetOpen(false);
        setDiscardOpen(false);
        baseline.current = editorSnapshot({
            summary: nextSummary,
            items: nextItems,
            taxRate: nextTaxRate,
            discountType: nextDiscountType,
            discountValue: nextDiscountValue,
            aiReport: '',
            orderList: nextOrderList,
        });
    }, [invoice, open]);

    const currentSnapshot = useMemo(() => editorSnapshot({
        summary,
        items,
        taxRate,
        discountType,
        discountValue,
        aiReport,
        orderList,
    }), [aiReport, discountType, discountValue, items, orderList, summary, taxRate]);
    const isDirty = open && currentSnapshot !== baseline.current;

    const subtotal = useMemo(() => items.reduce((sum, item) => sum + amount(item), 0), [items]);
    const rawDiscountValue = Number(discountValue) || 0;
    const discountAmount = discountType === 'percentage'
        ? subtotal * Math.min(Math.max(rawDiscountValue, 0), 100) / 100
        : discountType === 'fixed'
            ? rawDiscountValue
            : 0;
    const taxableSubtotal = items
        .filter(item => item.taxable)
        .reduce((sum, item) => sum + amount(item), 0);
    const taxAmount = Math.max(taxableSubtotal - discountAmount, 0) * ((Number(taxRate) || 0) / 100);
    const total = subtotal - discountAmount + taxAmount;
    const discountError = discountType === 'fixed' && discountAmount > subtotal
        ? 'Discount cannot exceed subtotal'
        : discountType === 'percentage' && rawDiscountValue > 100
            ? 'Discount percentage cannot exceed 100'
            : '';
    const canSave = (items.length > 0 || summary.trim().length > 0) && !discountError;

    const requestOpenChange = (nextOpen: boolean) => {
        if (nextOpen) {
            onOpenChange(true);
            return;
        }
        if (saving) return;
        if (isDirty) {
            setDiscardOpen(true);
            return;
        }
        onOpenChange(false);
    };

    const openSummary = () => {
        setSummaryDraft(summary);
        setSummaryDialogOpen(true);
    };

    const handleAiGenerate = async (reportText?: string) => {
        const report = (reportText ?? aiReport).trim();
        if (!report || aiGenerating) return;
        setAiGenerating(true);
        setReportToEstimateOff(false);
        try {
            const draft = await aiDraftEstimate(report, defaultJobId);
            if (draft.generation_id) setAiGenerationId(draft.generation_id);
            if (draft.summary) setSummary(draft.summary);
            if (draft.line_items?.length) {
                setItems(previous => [
                    ...previous,
                    ...draft.line_items.map(item => ({
                        key: newKey(),
                        name: item.title,
                        description: item.description || '',
                        quantity: String(item.qty || 1),
                        unit_price: String(item.unit_price ?? 0),
                        taxable: true,
                    })),
                ]);
            }
            if (draft.order_list?.length) {
                setOrderList(previous => [
                    ...previous,
                    ...draft.order_list!.map(part => (
                        makeOrderRow(part.part_number, part.part_name, String(part.quantity))
                    )),
                ]);
            }
            const created = draft.line_items.filter(item => item.created).length;
            toast.success(
                `Draft generated${created ? ` · ${created} new price-book item${created > 1 ? 's' : ''}` : ''} — review and save`,
            );
            setAiReport('');
        } catch (error) {
            if ((error as { code?: string }).code === 'app_disabled') {
                setReportToEstimateOff(true);
            } else {
                toast.error(error instanceof Error ? error.message : 'Could not generate the draft');
            }
        } finally {
            setAiGenerating(false);
        }
    };

    const openNewItem = () => {
        setEditingItemKey(null);
        setItemDraft(emptyItem());
        // Any item hand-typed via this sheet is a NEW custom item that did not
        // exist in the Price Book → save it to the catalog (when allowed). Picking
        // a preset/group add-and-closes the sheet without ever reaching saveItem,
        // and edits go through openEditItem (flag stays false), so this only ever
        // flags genuinely-manual new items.
        setSavePresetOnNextItem(canManagePriceBook);
        setItemSheetOpen(true);
    };

    const openEditItem = (item: LineItem) => {
        setEditingItemKey(item.key);
        setItemDraft({ ...item });
        setSavePresetOnNextItem(false);
        setItemSheetOpen(true);
    };

    const pickPreset = (preset: EstimateItemPreset) => {
        setItems(previous => [...previous, {
            key: newKey(),
            name: preset.name,
            description: preset.description || '',
            quantity: String(preset.default_quantity ?? 1),
            unit_price: String(preset.default_unit_price ?? 0),
            taxable: !!preset.default_taxable,
        }]);
        recordEstimateItemPresetUsage(preset.id).catch(() => {});
    };

    const pickGroup = async (groupId: number) => {
        const groupItems = await expandGroup(groupId);
        if (groupItems.length === 0) {
            toast.info('That group has no active items');
            return;
        }
        setItems(previous => [
            ...previous,
            ...groupItems.map(item => ({
                key: newKey(),
                name: item.name,
                description: item.description || '',
                quantity: String(item.quantity ?? 1),
                unit_price: String(item.unit_price ?? 0),
                taxable: !!item.taxable,
            })),
        ]);
        toast.success(`Added ${groupItems.length} item(s) from group`);
    };

    const saveItem = async (draft: InvoiceItemDraft) => {
        const nextItem: LineItem = {
            ...draft,
            key: editingItemKey ?? newKey(),
        };
        setItems(previous => editingItemKey
            ? previous.map(item => item.key === editingItemKey ? nextItem : item)
            : [...previous, nextItem]);

        if (!editingItemKey && savePresetOnNextItem && canManagePriceBook) {
            try {
                const preset = await createEstimateItemPreset({
                    name: nextItem.name,
                    description: nextItem.description || null,
                    default_quantity: Number(nextItem.quantity) || 1,
                    default_unit_price: Number(nextItem.unit_price) || 0,
                    default_taxable: nextItem.taxable,
                });
                recordEstimateItemPresetUsage(preset.id).catch(() => {});
            } catch {
                toast.warning('Item added — it could not be saved to the Price Book');
            }
        }
        setSavePresetOnNextItem(false);
    };

    const removeEditingItem = () => {
        if (!editingItemKey) return;
        setItems(previous => previous.filter(item => item.key !== editingItemKey));
    };

    const handleSave = async () => {
        if (!canSave || saving) return;
        setSaving(true);
        try {
            const data: InvoiceCreateData = {
                contact_id: invoice?.contact_id ?? defaultContactId ?? null,
                ai_generation_id: !isEdit ? aiGenerationId : null,
                lead_id: invoice?.lead_id ?? defaultLeadId ?? null,
                job_id: invoice?.job_id ?? defaultJobId ?? null,
                estimate_id: invoice?.estimate_id ?? defaultEstimateId ?? null,
                notes: summary.trim() || undefined,
                tax_rate: taxRate || '0',
                discount_amount: String(discountAmount),
                items: items.map((item, index) => ({
                    sort_order: index,
                    name: item.name || 'Untitled item',
                    description: item.description.trim() || null,
                    quantity: item.quantity || '1',
                    unit: null,
                    unit_price: item.unit_price || '0',
                    taxable: item.taxable,
                } as never)),
                order_list: serializeOrderList(orderList),
            };
            await onSave(data);
        } catch (error) {
            toast.error(error instanceof Error && error.message
                ? error.message
                : 'Could not save the invoice. Please try again.');
        } finally {
            setSaving(false);
        }
    };

    const saveButton = (
        <Button
            type="button"
            size="action" className="h-[52px] w-full rounded-[15px] text-[15px]"
            onClick={handleSave}
            disabled={saving || !canSave}
            data-testid="invoice-create-save"
        >
            {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            {saving ? 'Saving…' : isEdit ? 'Save invoice' : 'Create invoice'}
        </Button>
    );

    return (
        <>
            {/* modal={!isMobile}: on mobile the full-screen report/summary editors portal to
                document.body (outside this dialog); a modal Dialog's focus-trap would yank focus
                back and iOS would never raise the keyboard. Non-modal on mobile lets them keep
                focus — parity with EstimateEditorDialog. */}
            <Dialog open={open} onOpenChange={requestOpenChange} modal={!isMobile}>
                <DialogContent
                    variant="panel"
                    size="full"
                    mobileFullScreen
                    data-testid="invoice-editor"
                    className="[&>button[aria-label='Close']]:hidden"
                >
                    <div className="md:hidden">
                        <DialogClose asChild>
                            <OverlayClose variant="corner" data-testid="invoice-close" />
                        </DialogClose>
                    </div>
                    <DialogPanelHeader className="max-md:hidden">
                        <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                                <DialogTitle
                                    className="text-[22px] font-semibold leading-tight text-[var(--blanc-ink-1)]"
                                    style={{ fontFamily: 'var(--blanc-font-heading)' }}
                                >
                                    {isEdit ? invoice?.invoice_number : 'New invoice'}
                                </DialogTitle>
                                <DialogDescription>
                                    {defaultContext && !isEdit
                                        ? defaultContext
                                        : isEdit
                                            ? 'Edit invoice line items and totals'
                                            : 'Create a new invoice'}
                                </DialogDescription>
                            </div>
                            <div className="shrink-0 text-right">
                                <p className="blanc-eyebrow">Total</p>
                                <p className="font-mono text-xl font-semibold text-[var(--blanc-ink-1)]">{money(total)}</p>
                            </div>
                        </div>
                    </DialogPanelHeader>

                    <DialogBody className="px-[18px] pb-8 pt-6 md:px-8 md:py-7">
                        <div className="mx-auto w-full max-w-[820px] space-y-6">
                            <div className="pr-10 md:hidden">
                                <DialogTitle
                                    className="text-[26px] font-semibold leading-[1.15] text-[var(--blanc-ink-1)]"
                                    style={{ fontFamily: 'var(--blanc-font-heading)' }}
                                >
                                    {isEdit ? invoice?.invoice_number : 'New invoice'}
                                </DialogTitle>
                                {defaultContext && !isEdit ? (
                                    <p className="mt-1 text-[13px] text-[var(--blanc-ink-3)]">{defaultContext}</p>
                                ) : null}
                            </div>

                            <section className="rounded-[16px] bg-[var(--blanc-accent-soft)] p-[15px]">
                                <div className="flex items-center gap-2 text-[14px] font-semibold text-[var(--blanc-ink-1)]">
                                    <Sparkles className="size-[17px] text-[var(--blanc-accent)]" />
                                    Generate from a report
                                </div>
                                <p className="mt-1 text-[13px] leading-relaxed text-[var(--blanc-ink-2)]">
                                    Paste a repair report — AI fills the summary and line items from your Price Book. Review before you save.
                                </p>
                                {reportToEstimateOff ? (
                                    <div className="mt-3 rounded-xl bg-[var(--blanc-panel-surface)] px-3.5 py-2.5 text-sm text-[var(--blanc-ink-1)]">
                                        <span className="font-medium">Report → Estimate is turned off.</span>{' '}
                                        Enable it in Settings → Integrations to draft from a report.
                                    </div>
                                ) : null}
                                <FloatingField
                                    textarea
                                    rows={3}
                                    containerClassName="mt-3"
                                    label="Paste the report here…"
                                    value={aiReport}
                                    readOnly={isMobile}
                                    onClick={isMobile && !aiGenerating ? () => setReportEditorOpen(true) : undefined}
                                    onChange={event => setAiReport(event.target.value)}
                                    disabled={aiGenerating}
                                />
                                <Button
                                    type="button"
                                    variant="outline"
                                    className="mt-3 h-11 w-full rounded-xl font-semibold text-[var(--blanc-accent)]"
                                    onClick={() => handleAiGenerate()}
                                    disabled={aiGenerating || !aiReport.trim()}
                                >
                                    {aiGenerating
                                        ? <><Loader2 className="mr-2 size-4 animate-spin" />Generating…</>
                                        : <><Sparkles className="mr-2 size-4" />Generate</>}
                                </Button>
                            </section>

                            <section>
                                <div className="flex min-h-[30px] items-center justify-between gap-3">
                                    <p className="blanc-eyebrow">Summary</p>
                                    {summary ? (
                                        <Button type="button" variant="ghost" size="icon" className="size-[30px] rounded-[9px]" onClick={openSummary} aria-label="Edit summary">
                                            <Pencil className="size-4" />
                                        </Button>
                                    ) : null}
                                </div>
                                {summary ? (
                                    <p className="mt-2 whitespace-pre-wrap text-[14px] leading-relaxed text-[var(--blanc-ink-2)]">{summary}</p>
                                ) : (
                                    <div className="mt-2">
                                        <p className="text-[13px] leading-relaxed text-[var(--blanc-ink-2)]">
                                            Add scope, findings, or context worth highlighting to the customer.
                                        </p>
                                        <Button type="button" variant="outline" className="mt-3 h-11 w-full rounded-xl" onClick={openSummary}>
                                            <Plus className="mr-1.5 size-4" /> Add summary
                                        </Button>
                                    </div>
                                )}
                            </section>

                            <section>
                                <p className="blanc-eyebrow">Items</p>
                                <p className="mt-1 text-[12px] text-[var(--blanc-ink-3)]">Title and unit price required. Qty defaults to 1.</p>
                                {items.length > 0 ? (
                                    <div className="mt-2">
                                        {items.map(item => (
                                            <button
                                                key={item.key}
                                                type="button"
                                                className="flex w-full items-center justify-between gap-3 border-b border-[var(--blanc-line)] px-1 py-[13px] text-left last:border-b-0"
                                                onClick={() => openEditItem(item)}
                                                data-testid="invoice-item-row"
                                            >
                                                <span className="min-w-0">
                                                    <span className="block truncate text-[15px] font-semibold text-[var(--blanc-ink-1)]">{item.name}</span>
                                                    {item.description ? <span className="mt-0.5 block truncate text-[13px] text-[var(--blanc-ink-2)]">{item.description}</span> : null}
                                                    <span className="mt-1 block text-[12px] text-[var(--blanc-ink-3)]">
                                                        {Number(item.quantity)} × {money(item.unit_price)}{item.taxable ? ' · Taxable' : ''}
                                                    </span>
                                                </span>
                                                <span className="flex shrink-0 items-center gap-2">
                                                    <span className="font-mono text-[15px] font-semibold text-[var(--blanc-ink-1)]">{money(amount(item))}</span>
                                                    <ChevronRight className="size-4 text-[var(--blanc-ink-3)]" />
                                                </span>
                                            </button>
                                        ))}
                                    </div>
                                ) : null}
                                <Button type="button" variant="outline" size="action" className="mt-3 w-full rounded-[14px] border-dashed" onClick={openNewItem} data-testid="invoice-add-item">
                                    <Plus className="mr-1.5 size-4" /> Add item
                                </Button>
                            </section>

                            <section>
                                <p className="blanc-eyebrow">Totals</p>
                                <div className="mt-2 space-y-1 text-[14px]">
                                    <div className="flex min-h-8 items-center justify-between">
                                        <span className="text-[var(--blanc-ink-2)]">Subtotal</span>
                                        <span className="font-mono font-semibold text-[var(--blanc-ink-1)]">{money(subtotal)}</span>
                                    </div>
                                    {/* Two lines, not one that wraps (owner, iPhone 16, 2026-08-16).
                                        Label + toggle + field + bin + the resulting amount was
                                        ~330px of controls in a ~350px column: on a phone the
                                        amount was pushed onto a line of its own by `ml-auto`,
                                        landing under the bin, orphaned from the row it belongs
                                        to — and the error then read as a page-level alert rather
                                        than "this number is wrong".

                                        So: line one is the totals row it actually is (name left,
                                        figure right, same shape as Subtotal and Tax); line two is
                                        the controls; the error sits directly under the field it
                                        is about. Nothing here can wrap into nonsense. */}
                                    {discountType ? (
                                        <div className="py-1">
                                            <div className="flex min-h-8 items-center justify-between gap-3">
                                                <span className="text-[var(--blanc-ink-2)]">Discount</span>
                                                <span className="font-mono font-semibold text-[var(--blanc-danger)]">−{money(discountAmount)}</span>
                                            </div>
                                            <div className="mt-1.5 flex items-center gap-2">
                                                <div className="inline-flex shrink-0 rounded-[10px] border border-[var(--blanc-line)] p-0.5">
                                                    <button type="button" onClick={() => { if (discountType !== 'fixed') setDiscountValue(''); setDiscountType('fixed'); }} className={`rounded-md px-2.5 py-1 text-sm ${discountType === 'fixed' ? 'bg-[var(--blanc-ink-1)] text-white' : 'text-[var(--blanc-ink-3)]'}`} aria-label="Fixed discount">$</button>
                                                    <button type="button" onClick={() => { if (discountType !== 'percentage') setDiscountValue(''); setDiscountType('percentage'); }} className={`rounded-md px-2.5 py-1 text-sm ${discountType === 'percentage' ? 'bg-[var(--blanc-ink-1)] text-white' : 'text-[var(--blanc-ink-3)]'}`} aria-label="Percentage discount">%</button>
                                                </div>
                                                {discountType === 'fixed' ? (
                                                    <FloatingLabel label="Amount" filled className="w-28">
                                                        <MoneyInput
                                                            value={discountValue}
                                                            onValueChange={setDiscountValue}
                                                            aria-invalid={!!discountError}
                                                            aria-describedby={discountError ? 'invoice-discount-error' : undefined}
                                                            className="h-[50px] w-full rounded-xl border-[1.5px] border-transparent bg-transparent px-3 text-right text-sm tabular-nums outline-none focus:border-[var(--blanc-line-strong)]"
                                                        />
                                                    </FloatingLabel>
                                                ) : (
                                                    <FloatingField
                                                        label="Percent"
                                                        value={discountValue}
                                                        inputMode="decimal"
                                                        containerClassName="w-28"
                                                        aria-invalid={!!discountError}
                                                        aria-describedby={discountError ? 'invoice-discount-error' : undefined}
                                                        onChange={event => setDiscountValue(event.target.value.replace(/[^0-9.]/g, ''))}
                                                    />
                                                )}
                                                <Button type="button" variant="ghost" size="icon" className="size-10 shrink-0" onClick={() => { setDiscountType(null); setDiscountValue('0'); }} aria-label="Remove discount">
                                                    <Trash2 className="size-4" />
                                                </Button>
                                            </div>
                                            {discountError ? (
                                                <p id="invoice-discount-error" className="mt-1.5 text-sm text-[var(--blanc-danger)]">{discountError}</p>
                                            ) : null}
                                        </div>
                                    ) : (
                                        <button type="button" className="min-h-10 text-sm font-medium text-[var(--blanc-job)]" onClick={() => { setDiscountType('fixed'); setDiscountValue('0'); }}>+ Add discount</button>
                                    )}
                                    <div className="flex items-center justify-between gap-3 py-1">
                                        <span className="text-[var(--blanc-ink-2)]">Tax rate</span>
                                        <FloatingField
                                            label="Percent"
                                            value={taxRate}
                                            inputMode="decimal"
                                            containerClassName="w-24"
                                            onChange={event => setTaxRate(event.target.value.replace(/[^0-9.]/g, ''))}
                                            onBlur={() => { const next = Number(taxRate); if (Number.isFinite(next)) setTaxRate(next.toFixed(2)); }}
                                        />
                                    </div>
                                    <div className="flex min-h-8 items-center justify-between">
                                        <span className="text-[var(--blanc-ink-2)]">Tax</span>
                                        <span className="font-mono font-semibold text-[var(--blanc-ink-1)]">{money(taxAmount)}</span>
                                    </div>
                                    <div className="mt-1 flex min-h-11 items-center justify-between border-t border-[var(--blanc-line)] text-[16px] font-semibold text-[var(--blanc-ink-1)]">
                                        <span>Total</span>
                                        <span className="font-mono">{money(total)}</span>
                                    </div>
                                </div>
                            </section>

                            <OrderListSection value={orderList} onChange={setOrderList} disabled={saving} />
                            <div className="pt-1 md:hidden">{saveButton}</div>
                        </div>
                    </DialogBody>

                    <DialogPanelFooter className="max-md:hidden">
                        <Button type="button" variant="outline" size="action" className="" onClick={() => requestOpenChange(false)} disabled={saving}>Cancel</Button>
                        <div className="w-full max-w-[280px]">{saveButton}</div>
                    </DialogPanelFooter>
                </DialogContent>
            </Dialog>

            <FullScreenTextEditor
                open={reportEditorOpen && isMobile}
                initialValue={aiReport}
                onDone={text => { setAiReport(text); setReportEditorOpen(false); handleAiGenerate(text); }}
                onCancel={() => setReportEditorOpen(false)}
                title="Report"
                placeholder="Paste or type the service report…"
                doneLabel="Generate invoice"
                requireText
            />
            <FullScreenTextEditor
                open={summaryDialogOpen && isMobile}
                initialValue={summary}
                onDone={text => { setSummary(text); setSummaryDialogOpen(false); }}
                onCancel={() => setSummaryDialogOpen(false)}
                title="Summary"
                placeholder="Make, model, serial, issue, findings, and resolution…"
            />
            <Dialog open={summaryDialogOpen && !isMobile} onOpenChange={setSummaryDialogOpen}>
                <DialogContent variant="panel">
                    <DialogPanelHeader>
                        <DialogTitle className="text-[22px] font-semibold leading-tight text-[var(--blanc-ink-1)]" style={{ fontFamily: 'var(--blanc-font-heading)' }}>Summary</DialogTitle>
                        <DialogDescription>Edit the customer-facing invoice summary.</DialogDescription>
                    </DialogPanelHeader>
                    <DialogBody className="md:px-8 md:py-7">
                        <FloatingField textarea rows={10} label="Notes for the customer" value={summaryDraft} onChange={event => setSummaryDraft(event.target.value)} />
                    </DialogBody>
                    <DialogPanelFooter>
                        <Button type="button" variant="outline" onClick={() => setSummaryDialogOpen(false)}>Cancel</Button>
                        <Button type="button" onClick={() => { setSummary(summaryDraft.trim()); setSummaryDialogOpen(false); }}>Save summary</Button>
                    </DialogPanelFooter>
                </DialogContent>
            </Dialog>

            <InvoiceItemSheet
                open={itemSheetOpen}
                onOpenChange={setItemSheetOpen}
                isEdit={!!editingItemKey}
                initial={itemDraft}
                onSave={saveItem}
                onRemove={editingItemKey ? removeEditingItem : undefined}
                onPickPreset={pickPreset}
                onPickGroup={pickGroup}
                onCreateFromSearch={() => setSavePresetOnNextItem(canManagePriceBook)}
                catalogCreateAllowed={canManagePriceBook}
            />

            <InvoiceConfirmDialog
                open={discardOpen}
                onOpenChange={setDiscardOpen}
                title="Discard this invoice?"
                description="You have unsaved changes — closing now will lose them."
                cancelLabel="Keep editing"
                confirmLabel="Discard"
                confirmTone="neutral"
                confirmTestId="invoice-discard-confirm"
                onConfirm={() => { setDiscardOpen(false); onOpenChange(false); }}
            />
        </>
    );
}
