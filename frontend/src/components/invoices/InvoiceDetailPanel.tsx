import { Fragment, useEffect, useState } from 'react';
import {
    Ban,
    Check,
    ChevronRight,
    CreditCard,
    Eye,
    Loader2,
    MoreHorizontal,
    Pencil,
    Plus,
    Send,
    Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem,
    DropdownMenuSeparator, DropdownMenuTrigger,
} from '../ui/dropdown-menu';
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
import { invoiceStatusTone } from './InvoiceMobileRow';
import { formatCompanyTime, useCompanyTime } from '../../lib/companyTime';

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

    /**
     * The action matrix — one cluster, at most two buttons, the rest behind a
     * menu that says "More" (owner, 2026-08-16, matching the estimate card).
     *
     * Before this, the desktop card was the phone layout stretched wide: every
     * action a full-width bar, and — worse — the set was SPLIT. Send and Preview
     * sat under the header while Edit and Delete lived at the very bottom, past
     * the items and the history, where nobody thinks to scroll. Actions that
     * belong to the same decision belong in the same place.
     */
    type Action = {
        key: string;
        label: string;
        icon?: React.ReactNode;
        onClick: () => void;
        testid?: string;
        danger?: boolean;
    };

    const isDraft = invoice.status === 'draft';
    const sendAction: Action = { key: 'send', label: isDraft ? 'Send invoice' : 'Resend', icon: <Send className="size-4" />, onClick: onSend, testid: 'invoice-send' };
    const collectAction: Action = { key: 'collect', label: 'Collect payment', icon: <CreditCard className="size-4" />, onClick: onCollect || (() => setCollectOpen(true)), testid: 'collect-open' };
    const editAction: Action = { key: 'edit', label: 'Edit invoice', icon: <Pencil className="size-4" />, onClick: () => setEditing(true), testid: 'invoice-edit' };
    const previewAction: Action = { key: 'preview', label: 'Preview PDF', icon: <Eye className="size-4" />, onClick: previewPdf };

    const primaryAction: Action | null =
        capabilities.canCollect ? collectAction
        : capabilities.canSend ? sendAction
        : previewAction;

    /**
     * A draft is still being written, so Edit earns the second slot. Once money
     * is owed, the second thing you reach for is the reminder, not the pencil.
     * Everything else has exactly one next move, and padding it to two would be
     * filling a slot rather than making a recommendation.
     */
    const secondaryAction: Action | null =
        isDraft ? (capabilities.canEdit ? editAction : null)
        : capabilities.canCollect && capabilities.canSend ? sendAction
        : null;

    const shownActions = new Set([primaryAction?.key, secondaryAction?.key].filter(Boolean) as string[]);
    const menuActions: Action[] = [
        ...(capabilities.canSend ? [sendAction] : []),
        previewAction,
        ...(capabilities.canEdit ? [editAction] : []),
        // NOTE: the panel also receives an `onSyncEstimate` prop that it has never
        // rendered a control for. Left alone — surfacing it here would be shipping
        // an action nobody has specified, not fixing a layout.
        ...(capabilities.canDelete ? [{ key: 'delete', label: 'Delete draft', icon: <Trash2 className="size-4" />, onClick: () => setDestructiveAction('delete'), danger: true }] : []),
        ...(capabilities.canVoid ? [{ key: 'void', label: 'Void invoice', icon: <Ban className="size-4" />, onClick: () => setDestructiveAction('void'), testid: 'invoice-void', danger: true }] : []),
    ].filter(action => !shownActions.has(action.key));

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
                {/* DESKTOP IS NOT A WIDE PHONE (owner, 2026-08-16).
                    This used to be an 820px column centred in a 1300px panel: a
                    phone screenshot floating between two dead margins. The card now
                    fills the layer, and the width is spent on two different jobs —
                    the DOCUMENT (items, totals) becomes a real table with Qty and
                    Rate columns the phone has no room for, while META (settings,
                    payments, history) stays a compact list at the left, because a
                    label 900px from its value is two things, not a pair. */}
                <div className="w-full space-y-6">
                    {/* IDENTITY — the same skeleton as the estimate card: what this is,
                        the one number that matters, who it is for, where it stands.
                        The old header spent five hand-written type sizes (10 / 11 / 13 /
                        17 / 26) saying it, including an uppercase 10px label above the
                        figure — a caption for a number that needs none. */}
                    <header className="pr-10 md:pr-0">
                        <p className="blanc-section-heading" style={{ marginBottom: 0 }}>{invoice.invoice_number}</p>
                        <h2
                            className="mt-1.5 text-[32px] font-semibold leading-none tabular-nums"
                            style={{ fontFamily: 'var(--blanc-font-heading)', letterSpacing: '-0.025em' }}
                        >
                            {money(invoice.balance_due)}
                        </h2>
                        {Number(invoice.balance_due || 0) !== Number(invoice.total || 0) && (
                            <p className="blanc-l2 blanc-l2-quiet mt-1">of {money(invoice.total)}</p>
                        )}
                        <p className="blanc-l2 blanc-l2-quiet mt-1.5">
                            {invoice.contact_name || 'No customer linked'}
                            {invoice.job_id ? ` · Job #${invoice.job_number || invoice.job_id}` : ''}
                        </p>
                        <div className="mt-2.5 flex flex-wrap items-center gap-2">
                            {/* The list's vocabulary, not a second one: an outline chip
                                here and a tinted pill in the list told the same fact
                                two different ways. */}
                            <span
                                className={`blanc-l2 inline-flex items-center px-2.5 capitalize ${invoiceStatusTone(invoice.status)}`}
                                style={{ minHeight: 26, borderRadius: 8 }}
                                data-testid="invoice-status"
                            >
                                {invoice.status}
                            </span>
                        </div>
                        {/* The bar is about progress, so it only appears once there IS
                            progress — an empty rail under a draft measures nothing. */}
                        {total > 0 && paymentProgress > 0 ? (
                            <div className="mt-3">
                                <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--blanc-surface-muted)]">
                                    <div className="h-full rounded-full bg-[var(--blanc-success)]" style={{ width: `${paymentProgress}%` }} />
                                </div>
                                <p className="blanc-l2 blanc-l2-quiet mt-1 text-right">{paymentProgress.toFixed(0)}% paid</p>
                            </div>
                        ) : null}

                        {/* ONE cluster, right here. Full-width stack on the phone, where
                            the sheet is the button's width; sized to their labels on the
                            desktop, where a thousand-pixel bar reads as a banner. */}
                        {!editing && (primaryAction || secondaryAction || menuActions.length > 0) ? (
                            <div className="mt-4 flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
                                {primaryAction && (
                                    <Button
                                        type="button"
                                        className="h-[50px] w-full blanc-l2 md:h-11 md:w-auto md:px-5"
                                        onClick={primaryAction.onClick}
                                        data-testid={primaryAction.testid}
                                    >
                                        {primaryAction.icon}
                                        <span className="ml-1.5">{primaryAction.label}</span>
                                    </Button>
                                )}
                                {secondaryAction && (
                                    <Button
                                        type="button"
                                        variant="secondary"
                                        className="h-[50px] w-full blanc-l2 md:h-11 md:w-auto md:px-5"
                                        onClick={secondaryAction.onClick}
                                        data-testid={secondaryAction.testid}
                                    >
                                        {secondaryAction.icon}
                                        <span className="ml-1.5">{secondaryAction.label}</span>
                                    </Button>
                                )}
                                {menuActions.length > 0 && (
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                className="h-11 w-full justify-center blanc-l2 md:w-auto md:px-3"
                                                style={{ color: 'var(--blanc-ink-2)' }}
                                                data-testid="invoice-more"
                                            >
                                                <MoreHorizontal className="size-4" />
                                                <span className="ml-1.5">More</span>
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="start" className="w-56">
                                            {menuActions.map((action, index) => (
                                                <Fragment key={action.key}>
                                                    {action.danger && !menuActions[index - 1]?.danger && <DropdownMenuSeparator />}
                                                    <DropdownMenuItem
                                                        onSelect={action.onClick}
                                                        data-testid={action.testid}
                                                        style={action.danger ? { color: 'var(--blanc-danger)' } : undefined}
                                                    >
                                                        {action.icon}
                                                        {action.label}
                                                    </DropdownMenuItem>
                                                </Fragment>
                                            ))}
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                )}
                            </div>
                        ) : null}
                    </header>

                    {(invoice.notes || editing) ? (
                        <section>
                            <div className="flex min-h-[30px] items-center justify-between gap-3">
                                <p className="blanc-l2 blanc-l2-heading">Summary</p>
                                {editing ? (
                                    <Button type="button" variant="ghost" size="icon" className="size-[30px] rounded-[9px]" onClick={() => setNotesDialogOpen(true)} aria-label={invoice.notes ? 'Edit summary' : 'Add summary'}>
                                        {invoice.notes ? <Pencil className="size-4" /> : <Plus className="size-4" />}
                                    </Button>
                                ) : null}
                            </div>
                            {invoice.notes ? <p className="mt-2 whitespace-pre-wrap blanc-l2 leading-relaxed blanc-l2-quiet">{invoice.notes}</p> : <p className="mt-2 blanc-l2 blanc-l2-quiet">Add context for the customer.</p>}
                        </section>
                    ) : null}

                    <section>
                        <p className="blanc-l2 blanc-l2-heading">Items</p>
                        {hasItems ? (
                            <div className="mt-2">
                                {/* Column headers exist only where there are columns.
                                    On the phone the row folds back to name + amount. */}
                                <div className="hidden border-b border-[var(--blanc-line)] px-1 pb-1.5 md:flex md:items-end md:gap-3">
                                    <span className="blanc-l2 blanc-l2-quiet flex-1">Description</span>
                                    <span className="blanc-l2 blanc-l2-quiet w-20 text-right">Qty</span>
                                    <span className="blanc-l2 blanc-l2-quiet w-32 text-right">Rate</span>
                                    <span className="blanc-l2 blanc-l2-quiet w-32 text-right">Amount</span>
                                    {editing ? <span className="w-4" /> : null}
                                </div>
                                {invoice.items!.map(item => (
                                    <button
                                        key={item.id}
                                        type="button"
                                        className={`flex w-full items-center justify-between gap-3 border-b border-[var(--blanc-line)] px-1 py-[11px] text-left last:border-b-0 ${editing ? '' : 'cursor-default'}`}
                                        onClick={() => { if (editing) openEditItem(item); }}
                                        data-testid="invoice-item-row"
                                    >
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate blanc-l2 blanc-l2-heading">{item.name}</span>
                                            {item.description ? <span className="mt-0.5 block truncate blanc-l2 blanc-l2-quiet md:max-w-[68ch] md:overflow-visible md:whitespace-normal">{item.description}</span> : null}
                                            {/* The phone cannot afford columns, so it keeps
                                                the arithmetic inline; the desktop shows it
                                                where the numbers actually line up. */}
                                            {(Number(item.quantity) !== 1 || item.taxable) ? (
                                                <span className="mt-1 block blanc-l2 blanc-l2-quiet md:hidden">
                                                    {Number(item.quantity) !== 1 ? `${Number(item.quantity)} × ${money(item.unit_price)}` : ''}
                                                    {Number(item.quantity) !== 1 && item.taxable ? ' · ' : ''}
                                                    {item.taxable ? 'Taxable' : ''}
                                                </span>
                                            ) : null}
                                            {item.taxable ? <span className="mt-1 hidden blanc-l2 blanc-l2-quiet md:block">Taxable</span> : null}
                                        </span>
                                        <span className="hidden w-20 shrink-0 text-right blanc-l2 tabular-nums blanc-l2-quiet md:block">
                                            {Number(item.quantity)}
                                        </span>
                                        <span className="hidden w-32 shrink-0 text-right font-mono blanc-l2 blanc-l2-quiet md:block">
                                            {money(item.unit_price)}
                                        </span>
                                        <span className="flex shrink-0 items-center justify-end gap-2 md:w-32">
                                            <span className="font-mono blanc-l2 blanc-l2-heading">{money(item.amount ?? Number(item.quantity) * Number(item.unit_price))}</span>
                                            {editing ? <ChevronRight className="size-4 text-[var(--blanc-ink-3)]" /> : null}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        ) : invoiceData.isLoading ? (
                            <div className="mt-2 flex items-center gap-2 rounded-xl bg-[var(--blanc-surface-muted)] px-4 py-3 blanc-l2 blanc-l2-quiet">
                                <Loader2 className="size-4 animate-spin" /> Loading items…
                            </div>
                        ) : (
                            <div className="mt-2 rounded-xl bg-[var(--blanc-surface-muted)] px-4 py-3 blanc-l2 blanc-l2-quiet">
                                This invoice has no items. Add at least one priced item before sending.
                            </div>
                        )}
                        {editing ? (
                            <Button type="button" variant="outline" className="mt-3 h-12 w-full rounded-[14px] border-dashed" onClick={openNewItem} data-testid="invoice-add-item">
                                <Plus className="mr-1.5 size-4" /> Add item
                            </Button>
                        ) : null}
                    </section>

                    {/* Totals belong under the Amount column, in the narrow stack every
                        paper invoice puts them in — not as full-width rows with the
                        number stranded a screen away from its label. */}
                    <section className="md:ml-auto md:w-[420px]">
                        <p className="blanc-l2 blanc-l2-heading">Totals</p>
                        <div className="mt-2 space-y-1 blanc-l2">
                            <div className="flex min-h-8 items-center justify-between"><span className="text-[var(--blanc-ink-2)]">Subtotal</span><span className="font-mono font-semibold">{money(invoice.subtotal)}</span></div>
                            {hasDiscount ? editing ? (
                                <div className="flex flex-wrap items-center gap-2 py-1">
                                    <span className="text-[var(--blanc-ink-2)]">Discount</span>
                                    <FloatingLabel label="Amount" filled className="w-28">
                                        <MoneyInput
                                            value={discountAmount}
                                            onValueChange={setDiscountAmount}
                                            onBlur={() => persist({ discount_amount: discountAmount || '0' })}
                                            className="h-[50px] w-full rounded-xl border-[1.5px] border-transparent bg-transparent px-3 text-right blanc-l2 tabular-nums outline-none focus:border-[var(--blanc-line-strong)]"
                                        />
                                    </FloatingLabel>
                                    <Button type="button" variant="ghost" className="h-10 px-2 text-[var(--blanc-danger)]" onClick={() => { setHasDiscount(false); setDiscountAmount('0'); persist({ discount_amount: '0' }); }}>Remove</Button>
                                    <span className="ml-auto font-mono font-semibold text-[var(--blanc-danger)]">-{money(invoice.discount_amount)}</span>
                                </div>
                            ) : (
                                <div className="flex min-h-8 items-center justify-between"><span className="text-[var(--blanc-ink-2)]">Discount</span><span className="font-mono font-semibold text-[var(--blanc-danger)]">-{money(invoice.discount_amount)}</span></div>
                            ) : editing ? (
                                <button type="button" className="min-h-10 blanc-l2" style={{ color: 'var(--blanc-job)' }} onClick={() => { setHasDiscount(true); setDiscountAmount('0'); }}>+ Add discount</button>
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
                            <div className="mt-1 flex min-h-11 items-center justify-between border-t border-[var(--blanc-line)] blanc-l2 blanc-l2-heading"><span>Total</span><span className="font-mono">{money(invoice.total)}</span></div>
                            <div className="flex min-h-8 items-center justify-between"><span className="text-[var(--blanc-ink-2)]">Amount paid</span><span className="font-mono font-semibold text-[var(--blanc-success)]">{money(invoice.amount_paid)}</span></div>
                            <div className="mt-1 flex min-h-11 items-center justify-between border-t border-[var(--blanc-line)] blanc-l2 blanc-l2-heading"><span>Balance due</span><span className="font-mono">{money(invoice.balance_due)}</span></div>
                        </div>
                    </section>

                    {(editing || dueDate || paymentTerms) ? (
                        <section className="md:max-w-[560px]">
                            <p className="blanc-l2 blanc-l2-heading">Document settings</p>
                            {editing ? (
                                <div className="mt-3 space-y-3.5">
                                    <FloatingLabel label="Due date" htmlFor="invoice-due-date" filled={!!dueDate}>
                                        <input
                                            id="invoice-due-date"
                                            type="date"
                                            value={dueDate}
                                            onChange={event => setDueDate(event.target.value)}
                                            onBlur={() => persist({ due_date: dueDate || null })}
                                            className="h-[50px] w-full min-w-0 rounded-xl border-[1.5px] border-transparent bg-transparent px-3.5 blanc-l2 outline-none focus:border-[var(--blanc-line-strong)]"
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
                                <div className="mt-2 space-y-1 blanc-l2">
                                    {dueDate ? <div className="flex min-h-8 items-center justify-between"><span className="text-[var(--blanc-ink-2)]">Due date</span><span className="font-medium">{fmtDate(dueDate, timeZone)}</span></div> : null}
                                    {paymentTerms ? <div className="flex min-h-8 items-center justify-between"><span className="text-[var(--blanc-ink-2)]">Payment terms</span><span className="font-medium">{paymentTerms}</span></div> : null}
                                </div>
                            )}
                        </section>
                    ) : null}

                    {!isTerminal && balanceDue <= 0 ? (
                        <div className="flex items-center gap-2 blanc-l2" style={{ color: 'var(--blanc-success)' }}>
                            <Check className="size-4" /> Invoice is fully paid
                        </div>
                    ) : null}

                    {payments && payments.length > 0 ? (
                        <section className="md:max-w-[560px]">
                            <p className="blanc-l2 blanc-l2-heading">Payments</p>
                            <div className="mt-2">
                                {[...payments]
                                    .sort((left, right) => (left.voided_at ? 1 : 0) - (right.voided_at ? 1 : 0))
                                    .map(payment => (
                                        <div key={payment.id} className="flex min-h-10 items-center justify-between gap-3 border-b border-[var(--blanc-line)] py-2 blanc-l2 last:border-b-0">
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

                    <div className="md:max-w-[560px]">
                        <TaskStack parentType="invoice" parentId={invoice.id} title="Tasks" />
                    </div>

                    {events.length > 0 ? (
                        <section className="md:max-w-[560px]">
                            <p className="blanc-l2 blanc-l2-heading">History</p>
                            <div className="mt-2 space-y-3">
                                {events.map(event => (
                                    <div key={event.id} className="blanc-l2">
                                        <span className="font-medium capitalize text-[var(--blanc-ink-1)]">{event.event_type.replace(/_/g, ' ')}</span>
                                        <p className="mt-0.5 text-[var(--blanc-ink-3)]">{fmtDateTime(event.created_at, timeZone)}</p>
                                    </div>
                                ))}
                            </div>
                        </section>
                    ) : null}

                    {/* While editing, Save is the only thing that matters — every other
                        action would act on a half-written document. It stays at the end
                        because that is where you finish writing; the view-mode actions
                        do NOT, which was the bug: nobody scrolls past the history to
                        look for Edit. */}
                    {editing ? (
                        <section className="pt-1">
                            <Button type="button" className="h-[50px] w-full blanc-l2 md:h-11 md:w-auto md:px-5" onClick={explicitSave}>
                                <Check className="mr-2 size-4" /> Save changes
                            </Button>
                        </section>
                    ) : null}
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
