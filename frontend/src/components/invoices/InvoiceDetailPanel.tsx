import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Ban,
    Check,
    ChevronDown,
    CreditCard,
    Eye,
    Loader2,
    MoreHorizontal,
    Pencil,
    Plus,
    Send,
    Trash2,
} from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { MoneyInput } from '../ui/MoneyInput';
import { Label } from '../ui/label';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { EstimateItemDialog, type ItemDraft } from '../estimates/EstimateItemDialog';
import ManualCardDialog from './ManualCardDialog';
import { EstimateSummaryDialog } from '../estimates/EstimateSummaryDialog';
import { ItemPresetSearchCombobox } from '../estimates/ItemPresetSearchCombobox';
import { expandGroup } from '../../services/priceBookApi';
import {
    createEstimateItemPreset,
    recordEstimateItemPresetUsage,
    type EstimateItemPreset,
} from '../../services/estimateItemPresetsApi';
import type {
    Invoice,
    InvoiceEvent,
    InvoiceItem,
    RecordPaymentData,
} from '../../services/invoicesApi';
import {
    addInvoiceItem,
    addInvoiceItemsBulk,
    deleteInvoiceItem,
    fetchInvoice,
    fetchInvoicePayments,
    updateInvoice,
    updateInvoiceItem,
    voidInvoicePayment,
} from '../../services/invoicesApi';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { useAuthz } from '../../hooks/useAuthz';
import { TaskStack } from '../tasks/TaskStack';
import { openAuthedPdf } from '../../lib/openAuthedPdf';
import { toast } from 'sonner';
import type { ManualCardSessionResult } from '../../services/stripePaymentsApi';
import { paymentMethodLabel } from '../../lib/paymentMethodLabels';

// ── Helpers ──────────────────────────────────────────────────────────────────

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
    return '$' + Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Border-only, near-white control input — sits on the warm panel surface, no clashing bg.
const TOTALS_INPUT =
    'h-8 rounded-[10px] border-[1.5px] border-[var(--blanc-line)] bg-transparent text-[var(--blanc-ink-1)] outline-none transition-colors focus-visible:border-[var(--blanc-ink-2)]';

function fmtDate(value: string | null | undefined): string {
    if (!value) return '-';
    return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateTime(value: string | null | undefined): string {
    if (!value) return '-';
    return new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function toDateInput(value: string | null | undefined): string {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const INVOICE_REVALIDATION_DELAYS_MS = [0, 1000, 2000, 4000, 8000] as const;

// ── Props ────────────────────────────────────────────────────────────────────

interface Props {
    invoice: Invoice;
    events: InvoiceEvent[];
    loading: boolean;
    onClose: () => void;
    /** @deprecated Edit happens inline; kept for backward compat with older callers. */
    onEdit?: () => void;
    onSend: () => void;
    onVoid: () => void;
    onRecordPayment: (data: RecordPaymentData) => Promise<any> | void;
    /** @deprecated Sync-from-estimate was removed; prop kept temporarily for caller compatibility. */
    onSyncEstimate?: () => void;
    onDelete: () => void;
    /** Called after the panel mutates the invoice so the parent can refetch / update its own state. */
    onChanged?: (invoice: Invoice) => void;
}

// ── Component ────────────────────────────────────────────────────────────────

export function InvoiceDetailPanel({
    invoice: initialInvoice,
    events,
    loading,
    onClose: _onClose,
    onSend,
    onVoid,
    onRecordPayment,
    onDelete,
    onChanged,
}: Props) {
    // Local copy so we can apply optimistic updates while saving.
    const [invoice, setInvoice] = useState<Invoice>(initialInvoice);
    const [hydrating, setHydrating] = useState(!initialInvoice.items);
    // Sync from the prop AND hydrate the full record. Callers frequently pass a
    // list row WITHOUT its line items — the Financials tabs (Job/Lead) and the
    // Invoices list all hand us `i.*` (no `items`). Without this fetch a freshly
    // opened invoice renders "This invoice has no items" until an item mutation
    // triggers a refetch, even though the items are persisted (they were never lost).
    // Fetching also enriches contact_email/phone and pulls the freshest totals.
    useEffect(() => {
        setInvoice(initialInvoice);
        if (initialInvoice.items) { setHydrating(false); return; }
        let cancelled = false;
        setHydrating(true);
        fetchInvoice(initialInvoice.id)
            .then(fresh => { if (!cancelled) setInvoice(fresh); })
            .catch(() => { /* keep the row we have — item mutations still refetch */ })
            .finally(() => { if (!cancelled) setHydrating(false); });
        return () => { cancelled = true; };
    }, [initialInvoice]);

    // Default to expanded whenever the invoice has summary/notes content — saves a click
    // for the common "open invoice to read it" path.
    const [notesOpen, setNotesOpen] = useState<boolean>(!!initialInvoice.notes);
    useEffect(() => {
        setNotesOpen(!!initialInvoice.notes);
    }, [initialInvoice.id, initialInvoice.notes]);
    const [notesDialogOpen, setNotesDialogOpen] = useState(false);

    // Inline-edit modals (Items)
    const [itemDialogOpen, setItemDialogOpen] = useState(false);
    const [itemEditingId, setItemEditingId] = useState<number | null>(null);
    const [itemDraft, setItemDraft] = useState<ItemDraft>({ name: '', description: '', quantity: '1', unit_price: '0', taxable: false });

    // Local mirrors for debounced auto-save.
    const [taxRate, setTaxRate] = useState<string>(invoice.tax_rate ? Number(invoice.tax_rate).toFixed(2) : '0');
    const [discountAmount, setDiscountAmount] = useState<string>(invoice.discount_amount ? String(invoice.discount_amount) : '0');
    const [hasDiscount, setHasDiscount] = useState<boolean>(Number(invoice.discount_amount) > 0);
    const [dueDate, setDueDate] = useState<string>(toDateInput(invoice.due_date));
    useEffect(() => {
        setTaxRate(invoice.tax_rate ? Number(invoice.tax_rate).toFixed(2) : '0');
        setDiscountAmount(invoice.discount_amount ? String(invoice.discount_amount) : '0');
        setHasDiscount(Number(invoice.discount_amount) > 0);
        setDueDate(toDateInput(invoice.due_date));
    }, [invoice.tax_rate, invoice.discount_amount, invoice.due_date]);

    // Payments list
    const [payments, setPayments] = useState<any[]>([]);
    // OB-31: payment pending the void confirmation (manual/offline rows only).
    const [voidTx, setVoidTx] = useState<any | null>(null);
    const [voidingTx, setVoidingTx] = useState(false);
    useEffect(() => {
        if (!invoice?.id) return;
        fetchInvoicePayments(invoice.id).then(setPayments).catch(() => {});
    }, [invoice?.id]);

    // Payment form (shown inside a popover triggered by the "Record payment" button)
    const [paymentOpen, setPaymentOpen] = useState(false);
    const [paymentAmount, setPaymentAmount] = useState<string>('');
    const [paymentMethod, setPaymentMethod] = useState<string>('card');
    const [recording, setRecording] = useState(false);
    const [collecting, setCollecting] = useState(false);
    const [manualCardOpen, setManualCardOpen] = useState(false);
    const [manualCardAmount, setManualCardAmount] = useState<number | undefined>();
    const cardPollGenerationRef = useRef(0);
    const cardPollWaitersRef = useRef(new Map<number, () => void>());

    const cancelCardRevalidation = useCallback(() => {
        cardPollGenerationRef.current += 1;
        for (const cancel of cardPollWaitersRef.current.values()) cancel();
        cardPollWaitersRef.current.clear();
    }, []);

    const waitForCardPoll = useCallback((milliseconds: number) => new Promise<void>(resolve => {
        const id = window.setTimeout(() => {
            cardPollWaitersRef.current.delete(id);
            resolve();
        }, milliseconds);
        cardPollWaitersRef.current.set(id, () => {
            window.clearTimeout(id);
            resolve();
        });
    }), []);

    useEffect(() => () => cancelCardRevalidation(), [invoice.id, cancelCardRevalidation]);

    const revalidateAfterCardPayment = useCallback(async (payment: ManualCardSessionResult): Promise<boolean> => {
        if (payment.status !== 'succeeded') return false;
        cancelCardRevalidation();
        const generation = cardPollGenerationRef.current;
        const expectedPaidCents = Math.round((Number(invoice.amount_paid || 0) + payment.amount) * 100);

        for (const delay of INVOICE_REVALIDATION_DELAYS_MS) {
            if (delay > 0) await waitForCardPoll(delay);
            if (generation !== cardPollGenerationRef.current) return false;
            try {
                const [fresh, freshPayments] = await Promise.all([
                    fetchInvoice(invoice.id),
                    fetchInvoicePayments(invoice.id),
                ]);
                if (generation !== cardPollGenerationRef.current) return false;
                setInvoice(fresh);
                setPayments(freshPayments);
                onChanged?.(fresh);
                if (Math.round(Number(fresh.amount_paid || 0) * 100) >= expectedPaidCents) return true;
            } catch {
                // The webhook-backed ledger may lag or one poll may fail; continue within the bound.
            }
        }
        return false;
    }, [invoice.id, invoice.amount_paid, onChanged, cancelCardRevalidation, waitForCardPoll]);

    // Pre-fill the amount with the remaining balance whenever the popover opens
    // (or when the underlying balance changes while it's open).
    useEffect(() => {
        if (paymentOpen) {
            const balance = Number(invoice.balance_due) || 0;
            setPaymentAmount(balance > 0 ? balance.toFixed(2) : '');
        }
    }, [paymentOpen, invoice.balance_due]);

    const { hasPermission, hasAnyPermission } = useAuthz();
    const isVoid = invoice.status === 'void' || invoice.status === 'refunded';
    const readOnly = isVoid;
    // Send is always available for non-void invoices (re-sends are a normal workflow).
    // Permission-gated: only roles with invoices.send may dispatch.
    const canSend = hasPermission('invoices.send') && (!invoice.status || (invoice.status !== 'void' && invoice.status !== 'refunded'));
    const canVoid = !isVoid;
    // Permission-gated: only roles that can collect a payment (online or offline) see the buttons.
    const canCollectPayment = hasAnyPermission('payments.collect_online', 'payments.collect_offline');
    const canRecordPayment = canCollectPayment && !isVoid && Number(invoice.balance_due) > 0;

    // F018: Stripe "Collect payment" — create a payment link and copy/send it.
    // Readiness is enforced by the backend (returns NOT_READY if Stripe isn't set up).
    const collectPayment = async (mode: 'copy' | 'send') => {
        setCollecting(true);
        try {
            const { invoiceStripeApi } = await import('../../services/stripePaymentsApi');
            if (mode === 'send') {
                await invoiceStripeApi.sendLink(invoice.id, { channel: 'email' });
                toast.success('Payment link sent');
            } else {
                const link = await invoiceStripeApi.createLink(invoice.id);
                await navigator.clipboard.writeText(link.url).catch(() => {});
                toast.success('Payment link copied');
            }
        } catch (e: any) {
            const msg = String(e?.message || '');
            toast.error(/not ready|NOT_READY/i.test(msg) ? 'Connect Stripe in Integrations to collect online payments' : msg || 'Could not create payment link');
        } finally {
            setCollecting(false);
        }
    };

    // ── Item-edit handlers ───────────────────────────────────────────────────

    const refreshAfterItemChange = async () => {
        try {
            const fresh = await fetchInvoice(invoice.id);
            setInvoice(fresh);
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

    /** Combobox: existing preset selected → add to invoice immediately with defaults. */
    const pickPreset = async (preset: EstimateItemPreset) => {
        try {
            await addInvoiceItem(invoice.id, {
                name: preset.name,
                description: preset.description || '',
                quantity: String(preset.default_quantity ?? 1),
                unit_price: String(preset.default_unit_price ?? 0),
                taxable: !!preset.default_taxable,
            } as any);
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
            await addInvoiceItemsBulk(invoice.id, items.map(i => ({
                name: i.name, description: i.description, quantity: i.quantity,
                unit: i.unit || undefined, unit_price: i.unit_price, taxable: i.taxable,
            })) as any);
            await refreshAfterItemChange();
            toast.success(`Added ${items.length} item(s) from group`);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Add failed');
        }
    };

    const startCreateFromName = (name: string) => {
        openNewItem({ name }, { savePreset: true });
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
                await addInvoiceItem(invoice.id, payload as any);
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
                        toast.success(`Created "${preset.name}" and added to invoice`);
                    } catch (err) {
                        toast.error(`Item added, but failed to save preset: ${err instanceof Error ? err.message : String(err)}`);
                    } finally {
                        setSavePresetOnNextItem(false);
                    }
                }
            } else {
                await updateInvoiceItem(invoice.id, itemEditingId, payload as any);
            }
            await refreshAfterItemChange();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Save failed');
        }
    };
    const handleRemoveItem = async (id: number) => {
        try {
            await deleteInvoiceItem(invoice.id, id);
            await refreshAfterItemChange();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Remove failed');
        }
    };

    // ── Auto-save ────────────────────────────────────────────────────────────

    const saving = useRef(false);
    const persist = async (patch: Partial<Invoice>) => {
        if (readOnly) return;
        if (saving.current) return;
        saving.current = true;
        try {
            const updated = await updateInvoice(invoice.id, patch as any);
            setInvoice(updated);
            onChanged?.(updated);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Save failed');
        } finally {
            saving.current = false;
        }
    };
    const saveNotes = async (text: string) => {
        await persist({ notes: text } as any);
    };

    // ── Inline payment recording ─────────────────────────────────────────────

    const handleInlineRecord = async () => {
        const amt = Number(paymentAmount);
        if (!amt || amt <= 0) {
            toast.error('Enter a payment amount greater than 0');
            return;
        }
        setRecording(true);
        try {
            await onRecordPayment({ amount: String(amt), payment_method: paymentMethod });
            // refresh
            const fresh = await fetchInvoice(invoice.id);
            setInvoice(fresh);
            onChanged?.(fresh);
            const ps = await fetchInvoicePayments(invoice.id);
            setPayments(ps);
            setPaymentAmount('');
            setPaymentOpen(false);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Payment failed');
        } finally {
            setRecording(false);
        }
    };

    /** Reusable payment-recording form body. */
    const paymentFormBody = (
        <div className="space-y-2">
            <MoneyInput
                placeholder="0.00"
                value={paymentAmount}
                onValueChange={setPaymentAmount}
                className="flex h-8 w-full min-w-0 rounded-[10px] border-[1.5px] border-transparent bg-[var(--blanc-field,#F0F0F0)] px-3 py-1 text-right text-base tabular-nums outline-none transition-colors focus-visible:border-[var(--blanc-ink-2)] md:text-sm"
                autoFocus
            />
            <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                <SelectTrigger className="h-8 text-sm">
                    <SelectValue placeholder="Method" />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="card">Card</SelectItem>
                    <SelectItem value="cash">Cash</SelectItem>
                    <SelectItem value="check">Check</SelectItem>
                    <SelectItem value="ach">ACH / Bank</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                </SelectContent>
            </Select>
            <Button
                type="button"
                size="sm"
                className="w-full"
                onClick={handleInlineRecord}
                disabled={recording || !paymentAmount}
            >
                {recording ? (
                    <><Loader2 className="mr-1 size-3.5 animate-spin" />Recording…</>
                ) : (
                    <><CreditCard className="mr-1 size-3.5" />Record payment</>
                )}
            </Button>
        </div>
    );

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
        );
    }

    const hasItems = !!invoice.items?.length;
    const totalNum = Number(invoice.total) || 0;
    const paidNum = Number(invoice.amount_paid) || 0;
    const paymentProgress = totalNum > 0 ? Math.min((paidNum / totalNum) * 100, 100) : 0;
    const balanceDueNum = Number(invoice.balance_due) || 0;

    return (
        <div className={`flex h-full min-h-0 flex-col bg-[var(--blanc-panel-surface,#fffdf9)] text-[var(--blanc-ink-1)] ${isVoid ? 'grayscale opacity-60' : ''}`}>
            <div className="shrink-0 border-b border-[var(--blanc-line)] px-5 py-4 pr-14">
                <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                            {invoice.job_id ? (
                                <a
                                    href={`/jobs/${invoice.job_id}`}
                                    onClick={e => { e.preventDefault(); window.open(`/jobs/${invoice.job_id}`, '_blank', 'noopener,noreferrer'); }}
                                    className="font-mono text-sm font-semibold text-blue-600 hover:underline"
                                    title={`Open Job #${invoice.job_id}`}
                                >
                                    {invoice.invoice_number}
                                </a>
                            ) : (
                                <span className="font-mono text-sm font-semibold text-[var(--blanc-ink-1)]">{invoice.invoice_number}</span>
                            )}
                            <Badge variant={STATUS_VARIANT[invoice.status] || 'secondary'} className="capitalize">{invoice.status}</Badge>
                            {invoice.estimate_id && (
                                <Badge variant="outline" title={`From estimate #${invoice.estimate_id}`}>Estimate #{invoice.estimate_id}</Badge>
                            )}
                        </div>
                        <p className="mt-1 text-sm text-[var(--blanc-ink-2)]">{invoice.contact_name || 'No customer linked'}</p>
                    </div>
                    <div className="flex items-start gap-3">
                        <div className="text-right">
                            <p className="blanc-eyebrow">Balance Due</p>
                            <p className={`font-mono text-xl font-semibold ${balanceDueNum > 0 ? 'text-[var(--blanc-ink-1)]' : 'text-emerald-700'}`}>
                                {money(invoice.balance_due)}
                            </p>
                            <p className="text-[11px] text-[var(--blanc-ink-3)]">of {money(invoice.total)}</p>
                        </div>
                    </div>
                </div>
            </div>

            {/* ONE scroll surface at every width (design review 2026-07-23) — see
                EstimateDetailPanel: the per-column scroll pair broke mobile. */}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                <div className="grid md:grid-cols-[minmax(0,1fr)_300px] md:gap-8">
                <main className="space-y-6 p-5 md:py-6 md:pl-6 md:pr-0">
                    {/* Tasks — TASKS-001 */}
                    <TaskStack parentType="invoice" parentId={invoice.id} title="Tasks" />
                    {/* Summary (stored in `notes`; labeled "Summary" to match estimates).
                        OB-28 mirror: dashed invite when empty, collapsible card when filled. */}
                    {invoice.notes ? (
                        <section className="rounded-2xl border border-[var(--blanc-line)]">
                            <div className="flex items-center justify-between px-4 py-3">
                                <button
                                    type="button"
                                    onClick={() => setNotesOpen(o => !o)}
                                    className="flex flex-1 items-center gap-2 text-left text-sm font-medium text-[var(--blanc-ink-1)]"
                                >
                                    <ChevronDown className={`size-4 text-[var(--blanc-ink-3)] transition-transform ${notesOpen ? 'rotate-180' : ''}`} />
                                    Summary
                                </button>
                                {!readOnly && (
                                    <Button type="button" size="sm" variant="ghost" className="size-7 p-0" onClick={() => setNotesDialogOpen(true)} title="Edit summary">
                                        <Pencil className="size-4" />
                                    </Button>
                                )}
                            </div>
                            {notesOpen && (
                                <div className="px-4 pb-4 text-sm whitespace-pre-wrap text-[var(--blanc-ink-2)]">{invoice.notes}</div>
                            )}
                        </section>
                    ) : (
                        <div className="rounded-2xl border border-dashed border-[var(--blanc-line)] px-4 py-5" style={{ background: 'rgba(25,25,25,0.03)' }}>
                            <p className="text-sm font-medium text-[var(--blanc-ink-1)]">Summary</p>
                            <p className="mt-1 text-sm text-[var(--blanc-ink-3)]">Add scope, findings, or any context worth highlighting to the customer.</p>
                            {!readOnly && (
                                <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => setNotesDialogOpen(true)}>
                                    <Plus className="mr-1 size-4" /> Add summary
                                </Button>
                            )}
                        </div>
                    )}

                    {/* Items */}
                    <section>
                        <div className="mb-3 flex items-end justify-between gap-3">
                            <p className="blanc-eyebrow">Items</p>
                        </div>
                        {hasItems ? (
                            <div className="space-y-2">
                                {invoice.items!.map(item => (
                                    /* Tile: name↔amount header, full-width description, meta row
                                       with actions — mirrors the estimate tile. */
                                    <div
                                        key={item.id}
                                        className={`rounded-xl border border-[var(--blanc-line)] p-4 text-sm transition-colors ${readOnly ? '' : 'cursor-pointer hover:border-[var(--blanc-ink-3)]'}`}
                                        onClick={() => { if (!readOnly) openEditItem(item); }}
                                    >
                                        <div className="flex items-start justify-between gap-3">
                                            <p className="min-w-0 font-medium text-[var(--blanc-ink-1)]">{item.name}</p>
                                            <p className="shrink-0 font-mono font-semibold whitespace-nowrap text-[var(--blanc-ink-1)]">{money((item as any).amount ?? Number(item.quantity) * Number(item.unit_price))}</p>
                                        </div>
                                        {item.description && <p className="mt-1 whitespace-pre-wrap text-[var(--blanc-ink-2)]">{item.description}</p>}
                                        <div className="mt-2 flex items-center gap-2 text-xs text-[var(--blanc-ink-3)]">
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
                            <div className="flex items-center gap-2 rounded-md border border-[var(--blanc-line)] px-4 py-3 text-sm text-[var(--blanc-ink-3)]">
                                <Loader2 className="size-4 animate-spin" /> Loading items…
                            </div>
                        ) : (
                            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                                This invoice has no items. Add at least one priced item before sending.
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

                    {/* Totals */}
                    <section className="rounded-2xl p-4" style={{ background: 'rgba(25,25,25,0.03)' }}>
                        <p className="mb-3 blanc-eyebrow">Totals</p>
                        <div className="space-y-2 text-sm">
                            <div className="flex justify-between">
                                <span className="text-[var(--blanc-ink-2)]">Subtotal</span>
                                <span className="font-mono text-[var(--blanc-ink-1)]">{money(invoice.subtotal)}</span>
                            </div>
                            {hasDiscount ? (
                                /* OB-24: wrap so the amount drops to its own line on narrow widths. */
                                <div className="flex flex-wrap items-center gap-2 text-sm">
                                    <span className="text-[var(--blanc-ink-2)]">Discount</span>
                                    <span className="text-[var(--blanc-ink-3)]">$</span>
                                    <MoneyInput
                                        value={discountAmount}
                                        onValueChange={setDiscountAmount}
                                        onBlur={() => persist({ discount_amount: discountAmount || '0' } as any)}
                                        disabled={readOnly}
                                        className="h-8 w-24 rounded-[10px] border-[1.5px] border-transparent bg-[var(--blanc-field,#F0F0F0)] px-3 text-right text-sm tabular-nums outline-none transition-colors focus-visible:border-[var(--blanc-ink-2)] disabled:opacity-50"
                                    />
                                    <Button type="button" variant="ghost" size="sm" className="size-8 p-0 shrink-0" disabled={readOnly} onClick={() => { setHasDiscount(false); setDiscountAmount('0'); persist({ discount_amount: '0' } as any); }} title="Remove discount">
                                        <Trash2 className="size-4" />
                                    </Button>
                                    <span className="font-mono text-red-600 ml-auto">-{money(invoice.discount_amount)}</span>
                                </div>
                            ) : !readOnly && (
                                <button type="button" className="text-sm text-blue-600" onClick={() => { setHasDiscount(true); setDiscountAmount('0'); }}>
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
                                        className={`${TOTALS_INPUT} w-full pr-7 text-right tabular-nums`}
                                    />
                                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-[var(--blanc-ink-3)]">%</span>
                                </div>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-[var(--blanc-ink-2)]">Tax</span>
                                <span className="font-mono text-[var(--blanc-ink-1)]">{money(invoice.tax_amount)}</span>
                            </div>
                            <div className="flex justify-between pt-2 text-base font-semibold text-[var(--blanc-ink-1)]" style={{ borderTop: '1px solid var(--blanc-line)' }}>
                                <span>Total</span>
                                <span className="font-mono">{money(invoice.total)}</span>
                            </div>
                            <div className="flex justify-between text-sm">
                                <span className="text-[var(--blanc-ink-2)]">Amount paid</span>
                                <span className="font-mono text-emerald-700">{money(invoice.amount_paid)}</span>
                            </div>
                            <div className="flex justify-between pt-2 text-base font-semibold text-[var(--blanc-ink-1)]" style={{ borderTop: '1px solid var(--blanc-line)' }}>
                                <span>Balance Due</span>
                                <span className={`font-mono ${balanceDueNum <= 0 ? 'text-emerald-700' : ''}`}>{money(invoice.balance_due)}</span>
                            </div>
                            {totalNum > 0 && (
                                <div>
                                    <div className="w-full rounded-full h-1.5" style={{ background: 'rgba(25,25,25,0.10)' }}>
                                        <div
                                            className="bg-emerald-600 h-1.5 rounded-full transition-all"
                                            style={{ width: `${paymentProgress}%` }}
                                        />
                                    </div>
                                    <p className="text-[11px] text-[var(--blanc-ink-3)] mt-1 text-right">{paymentProgress.toFixed(0)}% paid</p>
                                </div>
                            )}
                        </div>
                    </section>
                </main>

                <aside className="space-y-6 px-5 pb-6 md:sticky md:top-0 md:self-start md:py-6 md:pl-0 md:pr-6">
                    {/* Document settings */}
                    <section className="space-y-3 text-sm">
                        <p className="blanc-eyebrow">Document settings</p>
                        <div className="grid grid-cols-[auto_1fr] items-center gap-2">
                            <Label className="text-[var(--blanc-ink-2)]">Due date</Label>
                            <Input
                                type="date"
                                value={dueDate}
                                onChange={e => setDueDate(e.target.value)}
                                onBlur={() => persist({ due_date: dueDate || null } as any)}
                                disabled={readOnly}
                                className={`${TOTALS_INPUT}`}
                            />
                        </div>
                    </section>

                    {/* Fully-paid state — flat row, no box (containers invisible). */}
                    {!readOnly && balanceDueNum <= 0 && (
                        <div className="flex items-center gap-2 text-sm font-medium text-emerald-700">
                            <Check className="size-4 shrink-0" />
                            Invoice is fully paid
                        </div>
                    )}

                    {/* Payments list. OB-31: voided rows stay listed — grayed and LAST;
                        manual (non-Stripe/ZB) rows can be voided with confirmation. */}
                    {payments.length > 0 && (
                        <section className="space-y-2 text-sm">
                            <p className="blanc-eyebrow">Payments</p>
                            <div className="space-y-1">
                                {[...payments].sort((a, b) => (a.voided_at ? 1 : 0) - (b.voided_at ? 1 : 0)).map((tx: any) => {
                                    const voided = !!tx.voided_at;
                                    const manual = !tx.external_source || tx.external_source === '' || tx.external_source === 'manual';
                                    return (
                                        <div key={tx.id} className="flex items-center justify-between gap-2 text-xs">
                                            <span className={voided ? 'text-[var(--blanc-ink-3)]' : 'text-[var(--blanc-ink-2)]'}>
                                                {fmtDate(tx.transaction_date || tx.created_at)}
                                                {(tx.payment_method || tx.metadata?.payment_method) && ` · ${paymentMethodLabel(tx.payment_method || tx.metadata?.payment_method)}`}
                                                {voided && ' · Voided'}
                                            </span>
                                            <span className="flex items-center gap-1">
                                                <span className={`font-mono ${voided ? 'text-[var(--blanc-ink-3)] line-through' : 'text-emerald-700'}`}>
                                                    {money(tx.amount ?? tx.metadata?.amount)}
                                                </span>
                                                {!voided && manual && canCollectPayment && !readOnly && (
                                                    <Button
                                                        type="button" variant="ghost" size="sm"
                                                        className="size-6 p-0 text-[var(--blanc-ink-3)] hover:text-red-600"
                                                        onClick={() => setVoidTx(tx)}
                                                        title="Void payment"
                                                    >
                                                        <Ban className="size-3.5" />
                                                    </Button>
                                                )}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        </section>
                    )}

                    {/* OB-31: void-payment confirmation (short action → center modal). */}
                    <Dialog open={!!voidTx} onOpenChange={o => { if (!o) setVoidTx(null); }}>
                        <DialogContent>
                            <DialogHeader>
                                <DialogTitle>Void this payment?</DialogTitle>
                            </DialogHeader>
                            <p className="text-sm text-[var(--blanc-ink-2)]">
                                {money(voidTx?.amount ?? voidTx?.metadata?.amount)}
                                {(voidTx?.payment_method || voidTx?.metadata?.payment_method) && ` · ${paymentMethodLabel(voidTx?.payment_method || voidTx?.metadata?.payment_method)}`}
                                {' '}— the payment stays in history but no longer counts toward the invoice total.
                            </p>
                            <DialogFooter>
                                <Button variant="outline" onClick={() => setVoidTx(null)} disabled={voidingTx}>Cancel</Button>
                                <Button
                                    variant="destructive"
                                    disabled={voidingTx}
                                    onClick={async () => {
                                        if (!voidTx) return;
                                        setVoidingTx(true);
                                        try {
                                            await voidInvoicePayment(invoice.id, voidTx.id);
                                            const [fresh, ps] = await Promise.all([fetchInvoice(invoice.id), fetchInvoicePayments(invoice.id)]);
                                            setInvoice(fresh); setPayments(ps); onChanged?.(fresh);
                                            toast.success('Payment voided');
                                            setVoidTx(null);
                                        } catch (err) {
                                            toast.error(err instanceof Error ? err.message : 'Could not void the payment');
                                        } finally {
                                            setVoidingTx(false);
                                        }
                                    }}
                                >
                                    {voidingTx ? 'Voiding…' : 'Void payment'}
                                </Button>
                            </DialogFooter>
                        </DialogContent>
                    </Dialog>

                    {events.length > 0 && (
                        <section className="space-y-3 text-sm">
                            <p className="blanc-eyebrow">History</p>
                            <div className="space-y-2.5">
                                {events.map(evt => (
                                    <div key={evt.id} className="text-xs">
                                        <span className="font-medium capitalize text-[var(--blanc-ink-1)]">{evt.event_type.replace(/_/g, ' ')}</span>
                                        <p className="text-[var(--blanc-ink-3)]">{fmtDateTime(evt.created_at)}</p>
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}
                </aside>
                </div>
            </div>

            <div className="shrink-0 border-t border-[var(--blanc-line)] bg-[var(--blanc-bg,#F1F1F0)] px-5 py-3">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div className="grid grid-cols-2 gap-2 md:flex">
                        <Button variant="outline" size="sm" onClick={() => {
                            openAuthedPdf(`/api/invoices/${invoice.id}/pdf`, `${invoice.invoice_number || `Invoice-${invoice.id}`}.pdf`)
                                .catch(() => toast.error('Could not open the PDF'));
                        }}>
                            <Eye className="mr-1 size-3.5" />Preview PDF
                        </Button>
                    </div>
                    <div className="flex flex-wrap gap-2 md:justify-end">
                        {!isVoid ? (
                            <>
                                {canSend && (
                                    <Button variant="default" size="sm" onClick={onSend}>
                                        <Send className="mr-1 size-3.5" />Send
                                    </Button>
                                )}
                                {canRecordPayment && (
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button variant="default" size="sm" disabled={collecting}>
                                                <CreditCard className="mr-1 size-3.5" />Collect payment
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end" className="w-52">
                                            <DropdownMenuItem onSelect={() => collectPayment('send')}>
                                                <Send className="size-4" />Send payment link
                                            </DropdownMenuItem>
                                            <DropdownMenuItem onSelect={() => collectPayment('copy')}>
                                                <CreditCard className="size-4" />Copy payment link
                                            </DropdownMenuItem>
                                            <DropdownMenuItem onSelect={() => {
                                                setManualCardAmount(Number(invoice.balance_due) || undefined);
                                                setManualCardOpen(true);
                                            }}>
                                                <CreditCard className="size-4" />Enter card manually
                                            </DropdownMenuItem>
                                            <DropdownMenuItem disabled>Tap to Pay · mobile app</DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                )}
                                {canRecordPayment && (
                                    <Popover open={paymentOpen} onOpenChange={setPaymentOpen}>
                                        <PopoverTrigger asChild>
                                            <Button variant="outline" size="sm">
                                                <CreditCard className="mr-1 size-3.5" />Record offline payment
                                            </Button>
                                        </PopoverTrigger>
                                        <PopoverContent align="end" className="w-72">
                                            <p className="mb-2 text-sm font-semibold">Record offline payment</p>
                                            {paymentFormBody}
                                        </PopoverContent>
                                    </Popover>
                                )}
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <Button variant="outline" size="sm">
                                            <MoreHorizontal className="mr-1 size-3.5" />More
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" className="w-44">
                                        {canVoid && (
                                            <DropdownMenuItem onSelect={onVoid}>
                                                <Ban className="size-4" />Void
                                            </DropdownMenuItem>
                                        )}
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem className="text-red-600 focus:text-red-700" onSelect={onDelete}>
                                            <Trash2 className="size-4" />Delete
                                        </DropdownMenuItem>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </>
                        ) : (
                            <Badge variant="secondary" className="capitalize">{invoice.status}</Badge>
                        )}
                    </div>
                </div>
            </div>

            <EstimateSummaryDialog
                open={notesDialogOpen}
                onOpenChange={setNotesDialogOpen}
                initial={invoice.notes || ''}
                onSave={saveNotes}
            />
            <EstimateItemDialog
                open={itemDialogOpen}
                onOpenChange={setItemDialogOpen}
                isEdit={itemEditingId != null}
                initial={itemDraft}
                onSave={saveItemDraft}
            />
            <ManualCardDialog
                open={manualCardOpen}
                onOpenChange={setManualCardOpen}
                invoiceId={invoice.id}
                amount={manualCardAmount}
                balanceBefore={manualCardAmount || 0}
                contactEmail={invoice.contact_email}
                hasContact={invoice.contact_id != null}
                onPaymentConfirmed={revalidateAfterCardPayment}
            />
        </div>
    );
}
