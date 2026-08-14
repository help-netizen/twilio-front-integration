import { useEffect, useState } from 'react';
import {
    Ban,
    Check,
    ChevronRight,
    CreditCard,
    Eye,
    Loader2,
    Pencil,
    Plus,
    Send,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { FloatingField, FloatingLabel } from '../ui/floating-field';
import { FloatingSelect } from '../ui/floating-select';
import { MoneyInput } from '../ui/MoneyInput';
import { SelectItem } from '../ui/select';
import { TaskStack } from '../tasks/TaskStack';
import { EstimateSummaryDialog } from '../estimates/EstimateSummaryDialog';
import { openAuthedPdf } from '../../lib/openAuthedPdf';
import { paymentMethodLabel } from '../../lib/paymentMethodLabels';
import { useInvoice } from '../../hooks/useInvoice';
import { expandGroup } from '../../services/priceBookApi';
import {
    createEstimateItemPreset,
    recordEstimateItemPresetUsage,
    type EstimateItemPreset,
} from '../../services/estimateItemPresetsApi';
import {
    addInvoiceItem,
    addInvoiceItemsBulk,
    deleteInvoiceItem,
    updateInvoiceItem,
    voidInvoicePayment,
    type Invoice,
    type InvoiceEvent,
    type InvoiceItem,
} from '../../services/invoicesApi';
import type { PaymentTransaction } from '../../services/paymentsCanonicalApi';
import { PaymentStatusChip, isVoidablePayment } from '../payments/paymentStatus';
import { VoidPaymentDialog } from '../payments/VoidPaymentDialog';
import { InvoiceConfirmDialog } from './InvoiceConfirmDialog';
import { InvoiceCollectPaymentDialog } from './InvoiceCollectPaymentDialog';
import { InvoiceItemSheet, type InvoiceItemDraft } from './InvoiceItemSheet';
import { formatCompanyTime, useCompanyTime } from '../../lib/companyTime';

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    draft: 'secondary',
    sent: 'outline',
    viewed: 'outline',
    partial: 'outline',
    paid: 'default',
    overdue: 'destructive',
    void: 'secondary',
    refunded: 'secondary',
};

function money(value: string | number | null | undefined): string {
    return '$' + Number(value || 0).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

function fmtDate(value: string | null | undefined, timeZone: string): string {
    if (!value) return '';
    return formatCompanyTime(value, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    }, timeZone);
}

function fmtDateTime(value: string | null | undefined, timeZone: string): string {
    if (!value) return '';
    return formatCompanyTime(value, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    }, timeZone);
}

function toDateInput(value: string | null | undefined): string {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (part: number) => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

interface Props {
    invoice: Invoice;
    events: InvoiceEvent[];
    loading: boolean;
    onClose: () => void;
    onEdit?: () => void;
    onSend: () => void;
    onCollect?: () => void;
    onVoid: () => void | Promise<void>;
    onSyncEstimate?: () => void;
    onDelete: () => void | Promise<void>;
    onChanged?: (invoice: Invoice) => void;
}

const emptyItem = (): InvoiceItemDraft => ({
    name: '',
    description: '',
    quantity: '1',
    unit_price: '0',
    taxable: true,
});

export function InvoiceDetailPanel({
    invoice: initialInvoice,
    events: initialEvents,
    loading,
    onSend,
    onCollect,
    onVoid,
    onDelete,
    onChanged,
}: Props) {
    const { timeZone } = useCompanyTime();
    const invoiceData = useInvoice(initialInvoice.id);
    const [invoice, setInvoice] = useState<Invoice>(initialInvoice);
    const [editing, setEditing] = useState(false);
    const [notesDialogOpen, setNotesDialogOpen] = useState(false);
    const [itemSheetOpen, setItemSheetOpen] = useState(false);
    const [itemEditingId, setItemEditingId] = useState<number | null>(null);
    const [itemDraft, setItemDraft] = useState<InvoiceItemDraft>(emptyItem());
    const [savePresetOnNextItem, setSavePresetOnNextItem] = useState(false);
    const [taxRate, setTaxRate] = useState('0');
    const [discountAmount, setDiscountAmount] = useState('0');
    const [hasDiscount, setHasDiscount] = useState(false);
    const [dueDate, setDueDate] = useState('');
    const [paymentTerms, setPaymentTerms] = useState('');
    const [voidPayment, setVoidPayment] = useState<PaymentTransaction | null>(null);
    const [destructiveAction, setDestructiveAction] = useState<'void' | 'delete' | null>(null);
    const [destructiveBusy, setDestructiveBusy] = useState(false);
    const [collectOpen, setCollectOpen] = useState(false);

    useEffect(() => {
        setInvoice(initialInvoice);
        setEditing(false);
    }, [initialInvoice]);

    useEffect(() => {
        if (invoiceData.invoice) setInvoice(invoiceData.invoice);
    }, [invoiceData.invoice]);

    useEffect(() => {
        setTaxRate(invoice.tax_rate ? Number(invoice.tax_rate).toFixed(2) : '0');
        setDiscountAmount(invoice.discount_amount ? String(invoice.discount_amount) : '0');
        setHasDiscount(Number(invoice.discount_amount) > 0);
        setDueDate(toDateInput(invoice.due_date));
        setPaymentTerms(invoice.payment_terms || '');
    }, [invoice.discount_amount, invoice.due_date, invoice.payment_terms, invoice.tax_rate]);

    const { capabilities } = invoiceData;
    const isTerminal = invoice.status === 'void' || invoice.status === 'refunded';
    const readOnly = !editing || !capabilities.canEdit;
    const events = invoiceData.events.length > 0 ? invoiceData.events : initialEvents;
    const payments = invoiceData.payments;
    const hasItems = !!invoice.items?.length;
    const total = Number(invoice.total) || 0;
    const amountPaid = Number(invoice.amount_paid) || 0;
    const balanceDue = Number(invoice.balance_due) || 0;
    const paymentProgress = total > 0 ? Math.min((amountPaid / total) * 100, 100) : 0;

    const refresh = async () => {
        try {
            const fresh = await invoiceData.refresh();
            if (fresh) {
                setInvoice(fresh);
                onChanged?.(fresh);
            }
            return fresh;
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Refresh failed');
            return null;
        }
    };

    const persist = async (patch: Parameters<typeof invoiceData.save>[0]) => {
        if (readOnly) return;
        try {
            const updated = await invoiceData.save(patch);
            setInvoice(updated);
            onChanged?.(updated);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Save failed');
            throw error;
        }
    };

    const openNewItem = () => {
        setItemEditingId(null);
        setItemDraft(emptyItem());
        setSavePresetOnNextItem(false);
        setItemSheetOpen(true);
    };

    const openEditItem = (item: InvoiceItem) => {
        setItemEditingId(item.id);
        setItemDraft({
            name: item.name || '',
            description: item.description || '',
            quantity: String(item.quantity ?? '1'),
            unit_price: String(item.unit_price ?? '0'),
            taxable: !!item.taxable,
        });
        setSavePresetOnNextItem(false);
        setItemSheetOpen(true);
    };

    const pickPreset = async (preset: EstimateItemPreset) => {
        try {
            await addInvoiceItem(invoice.id, {
                name: preset.name,
                description: preset.description || '',
                quantity: String(preset.default_quantity ?? 1),
                unit_price: String(preset.default_unit_price ?? 0),
                taxable: !!preset.default_taxable,
            });
            recordEstimateItemPresetUsage(preset.id).catch(() => {});
            await refresh();
            toast.success(`Added “${preset.name}”`);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Add failed');
            throw error;
        }
    };

    const pickGroup = async (groupId: number) => {
        try {
            const groupItems = await expandGroup(groupId);
            if (groupItems.length === 0) {
                toast.info('That group has no active items');
                return;
            }
            await addInvoiceItemsBulk(invoice.id, groupItems.map(item => ({
                name: item.name,
                description: item.description,
                quantity: item.quantity,
                unit: item.unit || undefined,
                unit_price: item.unit_price,
                taxable: item.taxable,
            })));
            await refresh();
            toast.success(`Added ${groupItems.length} item(s) from group`);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Add failed');
            throw error;
        }
    };

    const saveItem = async (draft: InvoiceItemDraft) => {
        const payload = {
            name: draft.name.trim(),
            description: draft.description,
            quantity: draft.quantity,
            unit_price: draft.unit_price,
            taxable: draft.taxable,
        };
        try {
            if (itemEditingId == null) {
                await addInvoiceItem(invoice.id, payload);
                if (savePresetOnNextItem && capabilities.canManagePriceBook) {
                    try {
                        const preset = await createEstimateItemPreset({
                            name: payload.name,
                            description: payload.description || null,
                            default_quantity: Number(payload.quantity) || 1,
                            default_unit_price: Number(payload.unit_price) || 0,
                            default_taxable: payload.taxable,
                        });
                        recordEstimateItemPresetUsage(preset.id).catch(() => {});
                    } catch {
                        toast.warning('Item added — it could not be saved to the Price Book');
                    }
                }
            } else {
                await updateInvoiceItem(invoice.id, itemEditingId, payload);
            }
            setSavePresetOnNextItem(false);
            await refresh();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Save failed');
            throw error;
        }
    };

    const removeItem = async () => {
        if (itemEditingId == null) return;
        try {
            await deleteInvoiceItem(invoice.id, itemEditingId);
            await refresh();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Remove failed');
            throw error;
        }
    };

    const explicitSave = async () => {
        (document.activeElement as HTMLElement | null)?.blur?.();
        await new Promise(resolve => window.setTimeout(resolve, 150));
        await refresh();
        toast.success('All changes saved');
        setEditing(false);
    };

    const previewPdf = () => {
        openAuthedPdf(
            `/api/invoices/${invoice.id}/pdf`,
            `${invoice.invoice_number || `Invoice-${invoice.id}`}.pdf`,
        ).catch(() => toast.error('Could not open the PDF'));
    };

    const confirmDestructive = async () => {
        if (!destructiveAction || destructiveBusy) return;
        setDestructiveBusy(true);
        try {
            if (destructiveAction === 'void') await onVoid();
            else await onDelete();
            setDestructiveAction(null);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : `Could not ${destructiveAction} invoice`);
        } finally {
            setDestructiveBusy(false);
        }
    };

    if (loading || (invoiceData.isLoading && !invoice.items)) {
        return (
            <div className="flex h-full items-center justify-center bg-[var(--blanc-panel-surface)]">
                <Loader2 className="size-6 animate-spin text-[var(--blanc-ink-3)]" />
            </div>
        );
    }

    return (
        <div className={`h-full min-h-0 bg-[var(--blanc-panel-surface)] text-[var(--blanc-ink-1)] ${isTerminal ? 'opacity-70' : ''}`} data-testid="invoice-detail">
            <div className="h-full overflow-y-auto overflow-x-hidden overscroll-contain px-[18px] pb-8 pt-6 md:px-8 md:py-7">
                <div className="mx-auto w-full max-w-[820px] space-y-6">
                    <header className="pr-10 md:pr-0">
                        <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <h2 className="font-mono text-[17px] font-semibold text-[var(--blanc-ink-1)]">
                                        {invoice.invoice_number}
                                    </h2>
                                    <Badge variant={STATUS_VARIANT[invoice.status] || 'secondary'} className="capitalize">
                                        {invoice.status}
                                    </Badge>
                                </div>
                                <p className="mt-2 text-[13px] text-[var(--blanc-ink-2)]">
                                    {invoice.contact_name || 'No customer linked'}
                                    {invoice.job_id ? ` · Job #${invoice.job_number || invoice.job_id}` : ''}
                                </p>
                            </div>
                            <div className="shrink-0 text-right">
                                <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--blanc-ink-3)]">Balance due</p>
                                <p className="mt-0.5 font-mono text-[26px] font-semibold leading-tight text-[var(--blanc-ink-1)]">{money(invoice.balance_due)}</p>
                                <p className="text-[11px] text-[var(--blanc-ink-3)]">of {money(invoice.total)}</p>
                            </div>
                        </div>
                        {total > 0 ? (
                            <div className="mt-3">
                                <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--blanc-surface-muted)]">
                                    <div className="h-full rounded-full bg-[var(--blanc-success)]" style={{ width: `${paymentProgress}%` }} />
                                </div>
                                <p className="mt-1 text-right text-[11px] text-[var(--blanc-ink-3)]">{paymentProgress.toFixed(0)}% paid</p>
                            </div>
                        ) : null}
                    </header>

                    {!editing ? (
                        <section className="space-y-2.5">
                            {capabilities.canCollect ? (
                                <Button type="button" className="h-[52px] w-full rounded-[15px] text-[15px] font-semibold" onClick={onCollect || (() => setCollectOpen(true))} data-testid="collect-open">
                                    <CreditCard className="mr-2 size-5" /> Collect payment
                                </Button>
                            ) : invoice.status === 'draft' && capabilities.canSend ? (
                                <Button type="button" className="h-[52px] w-full rounded-[15px] text-[15px] font-semibold" onClick={onSend} data-testid="invoice-send">
                                    <Send className="mr-2 size-5" /> Send invoice
                                </Button>
                            ) : null}
                            <div className="grid grid-cols-2 gap-2.5">
                                {invoice.status !== 'draft' && capabilities.canSend ? (
                                    <Button type="button" variant="outline" className="h-[46px] rounded-[13px] text-[14px] font-semibold" onClick={onSend} data-testid="invoice-send">
                                        <Send className="mr-1.5 size-4" /> Resend
                                    </Button>
                                ) : null}
                                <Button type="button" variant="outline" className={`h-[46px] rounded-[13px] text-[14px] font-semibold ${invoice.status === 'draft' || !capabilities.canSend ? 'col-span-2' : ''}`} onClick={previewPdf}>
                                    <Eye className="mr-1.5 size-4" /> Preview PDF
                                </Button>
                            </div>
                        </section>
                    ) : null}

                    {(invoice.notes || editing) ? (
                        <section>
                            <div className="flex min-h-[30px] items-center justify-between gap-3">
                                <p className="blanc-eyebrow">Summary</p>
                                {editing ? (
                                    <Button type="button" variant="ghost" size="icon" className="size-[30px] rounded-[9px]" onClick={() => setNotesDialogOpen(true)} aria-label={invoice.notes ? 'Edit summary' : 'Add summary'}>
                                        {invoice.notes ? <Pencil className="size-4" /> : <Plus className="size-4" />}
                                    </Button>
                                ) : null}
                            </div>
                            {invoice.notes ? <p className="mt-2 whitespace-pre-wrap text-[14px] leading-relaxed text-[var(--blanc-ink-2)]">{invoice.notes}</p> : <p className="mt-2 text-[13px] text-[var(--blanc-ink-3)]">Add context for the customer.</p>}
                        </section>
                    ) : null}

                    <section>
                        <p className="blanc-eyebrow">Items</p>
                        {hasItems ? (
                            <div className="mt-2">
                                {invoice.items!.map(item => (
                                    <button
                                        key={item.id}
                                        type="button"
                                        className={`flex w-full items-center justify-between gap-3 border-b border-[var(--blanc-line)] px-1 py-[11px] text-left last:border-b-0 ${editing ? '' : 'cursor-default'}`}
                                        onClick={() => { if (editing) openEditItem(item); }}
                                        data-testid="invoice-item-row"
                                    >
                                        <span className="min-w-0">
                                            <span className="block truncate text-[15px] font-semibold text-[var(--blanc-ink-1)]">{item.name}</span>
                                            {item.description ? <span className="mt-0.5 block truncate text-[13px] text-[var(--blanc-ink-2)]">{item.description}</span> : null}
                                            {(Number(item.quantity) !== 1 || item.taxable) ? (
                                                <span className="mt-1 block text-[12px] text-[var(--blanc-ink-3)]">
                                                    {Number(item.quantity) !== 1 ? `${Number(item.quantity)} × ${money(item.unit_price)}` : ''}
                                                    {Number(item.quantity) !== 1 && item.taxable ? ' · ' : ''}
                                                    {item.taxable ? 'Taxable' : ''}
                                                </span>
                                            ) : null}
                                        </span>
                                        <span className="flex shrink-0 items-center gap-2">
                                            <span className="font-mono text-[15px] font-semibold text-[var(--blanc-ink-1)]">{money(item.amount ?? Number(item.quantity) * Number(item.unit_price))}</span>
                                            {editing ? <ChevronRight className="size-4 text-[var(--blanc-ink-3)]" /> : null}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        ) : invoiceData.isLoading ? (
                            <div className="mt-2 flex items-center gap-2 rounded-xl bg-[var(--blanc-surface-muted)] px-4 py-3 text-sm text-[var(--blanc-ink-3)]">
                                <Loader2 className="size-4 animate-spin" /> Loading items…
                            </div>
                        ) : (
                            <div className="mt-2 rounded-xl bg-[var(--blanc-surface-muted)] px-4 py-3 text-sm text-[var(--blanc-ink-2)]">
                                This invoice has no items. Add at least one priced item before sending.
                            </div>
                        )}
                        {editing ? (
                            <Button type="button" variant="outline" className="mt-3 h-12 w-full rounded-[14px] border-dashed" onClick={openNewItem} data-testid="invoice-add-item">
                                <Plus className="mr-1.5 size-4" /> Add item
                            </Button>
                        ) : null}
                    </section>

                    <section>
                        <p className="blanc-eyebrow">Totals</p>
                        <div className="mt-2 space-y-1 text-[14px]">
                            <div className="flex min-h-8 items-center justify-between"><span className="text-[var(--blanc-ink-2)]">Subtotal</span><span className="font-mono font-semibold">{money(invoice.subtotal)}</span></div>
                            {hasDiscount ? editing ? (
                                <div className="flex flex-wrap items-center gap-2 py-1">
                                    <span className="text-[var(--blanc-ink-2)]">Discount</span>
                                    <FloatingLabel label="Amount" filled className="w-28">
                                        <MoneyInput
                                            value={discountAmount}
                                            onValueChange={setDiscountAmount}
                                            onBlur={() => persist({ discount_amount: discountAmount || '0' })}
                                            className="h-[50px] w-full rounded-xl border-[1.5px] border-transparent bg-transparent px-3 text-right text-sm tabular-nums outline-none focus:border-[var(--blanc-line-strong)]"
                                        />
                                    </FloatingLabel>
                                    <Button type="button" variant="ghost" className="h-10 px-2 text-[var(--blanc-danger)]" onClick={() => { setHasDiscount(false); setDiscountAmount('0'); persist({ discount_amount: '0' }); }}>Remove</Button>
                                    <span className="ml-auto font-mono font-semibold text-[var(--blanc-danger)]">-{money(invoice.discount_amount)}</span>
                                </div>
                            ) : (
                                <div className="flex min-h-8 items-center justify-between"><span className="text-[var(--blanc-ink-2)]">Discount</span><span className="font-mono font-semibold text-[var(--blanc-danger)]">-{money(invoice.discount_amount)}</span></div>
                            ) : editing ? (
                                <button type="button" className="min-h-10 text-sm font-medium text-[var(--blanc-job)]" onClick={() => { setHasDiscount(true); setDiscountAmount('0'); }}>+ Add discount</button>
                            ) : null}
                            {editing ? (
                                <div className="flex items-center justify-between gap-3 py-1">
                                    <span className="text-[var(--blanc-ink-2)]">Tax rate</span>
                                    <FloatingField
                                        label="Percent"
                                        value={taxRate}
                                        inputMode="decimal"
                                        containerClassName="w-28"
                                        onChange={event => setTaxRate(event.target.value.replace(/[^0-9.]/g, ''))}
                                        onBlur={() => { const next = Number(taxRate); const value = Number.isFinite(next) ? next.toFixed(2) : '0'; setTaxRate(value); persist({ tax_rate: value }); }}
                                    />
                                </div>
                            ) : Number(taxRate) > 0 ? (
                                <div className="flex min-h-8 items-center justify-between"><span className="text-[var(--blanc-ink-2)]">Tax rate</span><span className="font-mono font-semibold">{taxRate}%</span></div>
                            ) : null}
                            <div className="flex min-h-8 items-center justify-between"><span className="text-[var(--blanc-ink-2)]">Tax</span><span className="font-mono font-semibold">{money(invoice.tax_amount)}</span></div>
                            <div className="mt-1 flex min-h-11 items-center justify-between border-t border-[var(--blanc-line)] text-[16px] font-semibold"><span>Total</span><span className="font-mono">{money(invoice.total)}</span></div>
                            <div className="flex min-h-8 items-center justify-between"><span className="text-[var(--blanc-ink-2)]">Amount paid</span><span className="font-mono font-semibold text-[var(--blanc-success)]">{money(invoice.amount_paid)}</span></div>
                            <div className="mt-1 flex min-h-11 items-center justify-between border-t border-[var(--blanc-line)] text-[16px] font-semibold"><span>Balance due</span><span className="font-mono">{money(invoice.balance_due)}</span></div>
                        </div>
                    </section>

                    {(editing || dueDate || paymentTerms) ? (
                        <section>
                            <p className="blanc-eyebrow">Document settings</p>
                            {editing ? (
                                <div className="mt-3 space-y-3.5">
                                    <FloatingLabel label="Due date" htmlFor="invoice-due-date" filled={!!dueDate}>
                                        <input
                                            id="invoice-due-date"
                                            type="date"
                                            value={dueDate}
                                            onChange={event => setDueDate(event.target.value)}
                                            onBlur={() => persist({ due_date: dueDate || null })}
                                            className="h-[50px] w-full min-w-0 rounded-xl border-[1.5px] border-transparent bg-transparent px-3.5 text-[15px] font-medium text-[var(--blanc-ink-1)] outline-none focus:border-[var(--blanc-line-strong)]"
                                        />
                                    </FloatingLabel>
                                    <FloatingSelect
                                        label="Payment terms"
                                        value={paymentTerms || '_none'}
                                        onValueChange={value => {
                                            const next = value === '_none' ? '' : value;
                                            setPaymentTerms(next);
                                            persist({ payment_terms: next || null });
                                        }}
                                    >
                                        <SelectItem value="_none">None</SelectItem>
                                        <SelectItem value="Due on Receipt">Due on Receipt</SelectItem>
                                        <SelectItem value="Net 15">Net 15</SelectItem>
                                        <SelectItem value="Net 30">Net 30</SelectItem>
                                        <SelectItem value="Net 60">Net 60</SelectItem>
                                    </FloatingSelect>
                                </div>
                            ) : (
                                <div className="mt-2 space-y-1 text-[14px]">
                                    {dueDate ? <div className="flex min-h-8 items-center justify-between"><span className="text-[var(--blanc-ink-2)]">Due date</span><span className="font-medium">{fmtDate(dueDate, timeZone)}</span></div> : null}
                                    {paymentTerms ? <div className="flex min-h-8 items-center justify-between"><span className="text-[var(--blanc-ink-2)]">Payment terms</span><span className="font-medium">{paymentTerms}</span></div> : null}
                                </div>
                            )}
                        </section>
                    ) : null}

                    {!isTerminal && balanceDue <= 0 ? (
                        <div className="flex items-center gap-2 text-sm font-medium text-[var(--blanc-success)]">
                            <Check className="size-4" /> Invoice is fully paid
                        </div>
                    ) : null}

                    {payments && payments.length > 0 ? (
                        <section>
                            <p className="blanc-eyebrow">Payments</p>
                            <div className="mt-2">
                                {[...payments]
                                    .sort((left, right) => (left.voided_at ? 1 : 0) - (right.voided_at ? 1 : 0))
                                    .map(payment => (
                                        <div key={payment.id} className="flex min-h-10 items-center justify-between gap-3 border-b border-[var(--blanc-line)] py-2 text-[12px] last:border-b-0">
                                            <span className="min-w-0">
                                                <span className="text-[var(--blanc-ink-2)]">{fmtDate(payment.processed_at || payment.created_at, timeZone)} · {paymentMethodLabel(payment.payment_method)}</span>
                                                <PaymentStatusChip status={payment.status} transactionType={payment.transaction_type} className="ml-2" />
                                            </span>
                                            <span className="flex shrink-0 items-center gap-2">
                                                <span className={`font-mono font-semibold ${payment.status === 'voided' ? 'line-through text-[var(--blanc-ink-3)]' : 'text-[var(--blanc-success)]'}`}>{money(payment.amount)}</span>
                                                {editing && capabilities.canVoidPayment && isVoidablePayment(payment) ? (
                                                    <Button type="button" variant="ghost" size="icon" className="size-8 text-[var(--blanc-ink-3)] hover:text-[var(--blanc-danger)]" onClick={() => setVoidPayment(payment)} aria-label="Void payment">
                                                        <Ban className="size-3.5" />
                                                    </Button>
                                                ) : null}
                                            </span>
                                        </div>
                                    ))}
                            </div>
                        </section>
                    ) : null}

                    <TaskStack parentType="invoice" parentId={invoice.id} title="Tasks" />

                    {events.length > 0 ? (
                        <section>
                            <p className="blanc-eyebrow">History</p>
                            <div className="mt-2 space-y-3">
                                {events.map(event => (
                                    <div key={event.id} className="text-[12px]">
                                        <span className="font-medium capitalize text-[var(--blanc-ink-1)]">{event.event_type.replace(/_/g, ' ')}</span>
                                        <p className="mt-0.5 text-[var(--blanc-ink-3)]">{fmtDateTime(event.created_at, timeZone)}</p>
                                    </div>
                                ))}
                            </div>
                        </section>
                    ) : null}

                    <section className="space-y-2.5 pt-1">
                        {editing ? (
                            <Button type="button" className="h-[52px] w-full rounded-[15px] text-[15px] font-semibold" onClick={explicitSave}>
                                <Check className="mr-2 size-5" /> Save changes
                            </Button>
                        ) : capabilities.canEdit ? (
                            <Button type="button" variant="outline" className="h-[52px] w-full rounded-[15px] text-[15px] font-semibold" onClick={() => setEditing(true)}>
                                <Pencil className="mr-2 size-5" /> Edit invoice
                            </Button>
                        ) : null}
                        {!editing && capabilities.canDelete ? (
                            <Button type="button" variant="ghost" className="mt-6 h-10 w-full text-[13px] text-[var(--blanc-danger)] hover:text-[var(--blanc-danger)]" onClick={() => setDestructiveAction('delete')}>
                                Delete draft
                            </Button>
                        ) : !editing && capabilities.canVoid ? (
                            <Button type="button" variant="ghost" className="mt-6 h-10 w-full text-[13px] text-[var(--blanc-ink-3)] hover:text-[var(--blanc-danger)]" onClick={() => setDestructiveAction('void')}>
                                <Ban className="mr-1.5 size-4" /> Void invoice
                            </Button>
                        ) : null}
                    </section>
                </div>
            </div>

            <EstimateSummaryDialog
                open={notesDialogOpen}
                onOpenChange={setNotesDialogOpen}
                initial={invoice.notes || ''}
                onSave={text => persist({ notes: text })}
            />
            <InvoiceItemSheet
                open={itemSheetOpen}
                onOpenChange={setItemSheetOpen}
                isEdit={itemEditingId != null}
                initial={itemDraft}
                onSave={saveItem}
                onRemove={itemEditingId != null ? removeItem : undefined}
                onPickPreset={pickPreset}
                onPickGroup={pickGroup}
                onCreateFromSearch={() => setSavePresetOnNextItem(capabilities.canManagePriceBook)}
                catalogCreateAllowed={capabilities.canManagePriceBook}
            />
            <VoidPaymentDialog
                open={!!voidPayment}
                onOpenChange={next => { if (!next) setVoidPayment(null); }}
                bodyText="This removes the payment from the invoice and recalculates its balance."
                onConfirm={async reason => {
                    if (!voidPayment) return;
                    await voidInvoicePayment(invoice.id, voidPayment.id, reason);
                    await refresh();
                    setVoidPayment(null);
                    toast.success('Payment voided');
                }}
            />
            <InvoiceConfirmDialog
                open={!!destructiveAction}
                onOpenChange={next => { if (!next) setDestructiveAction(null); }}
                title={destructiveAction === 'delete'
                    ? `Delete draft ${invoice.invoice_number}?`
                    : `Void ${invoice.invoice_number}?`}
                description={destructiveAction === 'delete'
                    ? <>This permanently deletes the draft and its {money(invoice.balance_due)} balance. This can’t be undone.</>
                    : <>This clears the <span className="font-semibold text-[var(--blanc-danger)]">{money(invoice.balance_due)}</span> balance and marks the invoice void. This can’t be undone.</>}
                cancelLabel="Keep"
                confirmLabel={destructiveAction === 'delete' ? 'Delete draft' : 'Void invoice'}
                confirmTestId={destructiveAction === 'delete' ? 'invoice-delete-confirm' : 'invoice-void-confirm'}
                onConfirm={confirmDestructive}
                busy={destructiveBusy}
            />
            <InvoiceCollectPaymentDialog
                open={collectOpen}
                onOpenChange={setCollectOpen}
                invoice={invoice}
                capabilities={capabilities}
                onPaymentConfirmed={async () => {
                    const fresh = await refresh();
                    return !!fresh && Number(fresh.balance_due) < balanceDue;
                }}
            />
        </div>
    );
}
