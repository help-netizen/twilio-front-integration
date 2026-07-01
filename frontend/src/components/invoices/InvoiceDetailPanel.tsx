import { useEffect, useRef, useState } from 'react';
import {
    Ban,
    Check,
    ChevronDown,
    Clock,
    CreditCard,
    Eye,
    Loader2,
    MoreHorizontal,
    Pencil,
    Send,
    Trash2,
} from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
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
    deleteInvoiceItem,
    fetchInvoice,
    fetchInvoicePayments,
    updateInvoice,
    updateInvoiceItem,
} from '../../services/invoicesApi';
import { useAuthz } from '../../hooks/useAuthz';
import { TaskStack } from '../tasks/TaskStack';
import { toast } from 'sonner';

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
            <Input
                type="number"
                min="0.01"
                step="0.01"
                placeholder="Amount"
                value={paymentAmount}
                onChange={e => setPaymentAmount(e.target.value)}
                className="h-8 tabular-nums"
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

            <div className="grid min-h-0 flex-1 overflow-hidden md:grid-cols-[minmax(0,1fr)_310px]">
                <main className="min-h-0 space-y-6 overflow-y-auto p-5">
                    {/* Tasks — TASKS-001 */}
                    <TaskStack parentType="invoice" parentId={invoice.id} title="Tasks" />
                    {/* Summary (stored in `notes` field; labeled "Summary" to match estimates) */}
                    <section className="rounded-2xl border border-[var(--blanc-line)]">
                        <div className="flex items-center justify-between px-4 py-3">
                            <button
                                type="button"
                                onClick={() => setNotesOpen(o => !o)}
                                className="flex flex-1 items-center gap-2 text-left text-sm font-medium text-[var(--blanc-ink-1)]"
                            >
                                <ChevronDown className={`size-4 text-[var(--blanc-ink-3)] transition-transform ${notesOpen ? 'rotate-180' : ''}`} />
                                Summary
                                {!invoice.notes && <span className="text-xs font-normal text-[var(--blanc-ink-3)]">— add notes</span>}
                            </button>
                            {!readOnly && (
                                <Button type="button" size="sm" variant="ghost" className="size-7 p-0" onClick={() => setNotesDialogOpen(true)} title="Edit summary">
                                    <Pencil className="size-4" />
                                </Button>
                            )}
                        </div>
                        {notesOpen && invoice.notes && (
                            <div className="px-4 pb-4 text-sm whitespace-pre-wrap text-[var(--blanc-ink-2)]">{invoice.notes}</div>
                        )}
                    </section>

                    {/* Items */}
                    <section>
                        <div className="mb-3 flex items-end justify-between gap-3">
                            <div>
                                <p className="blanc-eyebrow">Items</p>
                                <p className="text-xs text-[var(--blanc-ink-3)]">Line items billed on the invoice.</p>
                            </div>
                        </div>
                        {hasItems ? (
                            <div className="space-y-2">
                                {invoice.items!.map(item => (
                                    <div
                                        key={item.id}
                                        className={`grid grid-cols-[1fr_auto_auto_auto] gap-3 rounded-xl border border-[var(--blanc-line)] p-4 text-sm transition-colors ${readOnly ? '' : 'cursor-pointer hover:border-[var(--blanc-ink-3)]'}`}
                                        onClick={() => { if (!readOnly) openEditItem(item); }}
                                    >
                                        <div className="min-w-0">
                                            <p className="font-medium text-[var(--blanc-ink-1)]">{item.name}</p>
                                            {item.description && <p className="mt-1 whitespace-pre-wrap text-[var(--blanc-ink-2)]">{item.description}</p>}
                                            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--blanc-ink-3)]">
                                                <span>{Number(item.quantity)} x {money(item.unit_price)}</span>
                                                {item.taxable && <Badge variant="outline" className="text-[10px]">Taxable</Badge>}
                                            </div>
                                        </div>
                                        <p className="font-mono font-semibold whitespace-nowrap text-[var(--blanc-ink-1)]">{money((item as any).amount ?? Number(item.quantity) * Number(item.unit_price))}</p>
                                        {!readOnly && (
                                            <>
                                                <Button type="button" size="sm" variant="ghost" className="size-7 p-0" onClick={(e) => { e.stopPropagation(); openEditItem(item); }} title="Edit item">
                                                    <Pencil className="size-4" />
                                                </Button>
                                                <Button type="button" size="sm" variant="ghost" className="size-7 p-0 text-red-600" onClick={(e) => { e.stopPropagation(); handleRemoveItem(item.id); }} title="Remove item">
                                                    <Trash2 className="size-4" />
                                                </Button>
                                            </>
                                        )}
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
                                />
                            </div>
                        )}
                    </section>

                    {/* Totals */}
                    <section className="rounded-2xl p-4" style={{ background: 'rgba(117,106,89,0.04)' }}>
                        <div className="space-y-2 text-sm">
                            <div className="flex justify-between">
                                <span className="text-[var(--blanc-ink-2)]">Subtotal</span>
                                <span className="font-mono text-[var(--blanc-ink-1)]">{money(invoice.subtotal)}</span>
                            </div>
                            {hasDiscount ? (
                                <div className="flex items-center gap-2 text-sm">
                                    <span className="text-[var(--blanc-ink-2)]">Discount</span>
                                    <span className="text-[var(--blanc-ink-3)]">$</span>
                                    <Input
                                        type="number"
                                        min="0"
                                        step="0.01"
                                        value={discountAmount}
                                        onChange={e => setDiscountAmount(e.target.value)}
                                        onBlur={() => persist({ discount_amount: discountAmount || '0' } as any)}
                                        disabled={readOnly}
                                        className={`${TOTALS_INPUT} w-24 text-right tabular-nums`}
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
                                <Input
                                    type="number"
                                    min="0"
                                    step="0.05"
                                    value={taxRate}
                                    onChange={e => setTaxRate(e.target.value)}
                                    onBlur={() => {
                                        const n = Number(taxRate);
                                        const formatted = Number.isFinite(n) ? n.toFixed(2) : '0';
                                        setTaxRate(formatted);
                                        persist({ tax_rate: formatted } as any);
                                    }}
                                    disabled={readOnly}
                                    className={`${TOTALS_INPUT} w-24 text-right tabular-nums`}
                                />
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
                                    <div className="w-full rounded-full h-1.5" style={{ background: 'rgba(117,106,89,0.12)' }}>
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

                <aside className="min-h-0 space-y-5 overflow-y-auto border-t border-[var(--blanc-line)] p-5 md:border-l md:border-t-0" style={{ background: 'rgba(117,106,89,0.05)' }}>
                    {/* Document settings */}
                    <section className="space-y-2 text-sm">
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

                    {/* Fully-paid banner */}
                    {!readOnly && balanceDueNum <= 0 && (
                        <section className="space-y-2 text-sm">
                            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                                <div className="flex items-center gap-2 font-medium">
                                    <Check className="size-3.5" />
                                    Invoice is fully paid
                                </div>
                            </div>
                        </section>
                    )}

                    {/* Payments list */}
                    {payments.length > 0 && (
                        <section className="space-y-2 text-sm">
                            <p className="blanc-eyebrow">Payments</p>
                            <div className="space-y-1">
                                {payments.map((tx: any) => (
                                    <div key={tx.id} className="flex justify-between text-xs">
                                        <span className="text-[var(--blanc-ink-2)] capitalize">
                                            {fmtDate(tx.transaction_date || tx.created_at)}
                                            {(tx.payment_method || tx.metadata?.payment_method) && ` · ${tx.payment_method || tx.metadata?.payment_method}`}
                                        </span>
                                        <span className="font-mono text-emerald-700">{money(tx.amount ?? tx.metadata?.amount)}</span>
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}

                    {events.length > 0 && (
                        <section className="space-y-2 text-sm">
                            <p className="blanc-eyebrow">History</p>
                            <div className="space-y-2">
                                {events.map(evt => (
                                    <div key={evt.id} className="flex items-start gap-2 text-xs">
                                        <Clock className="mt-0.5 size-3 shrink-0 text-[var(--blanc-ink-3)]" />
                                        <div>
                                            <span className="font-medium capitalize text-[var(--blanc-ink-1)]">{evt.event_type.replace(/_/g, ' ')}</span>
                                            <p className="text-[var(--blanc-ink-2)]">{fmtDateTime(evt.created_at)}</p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}
                </aside>
            </div>

            <div className="shrink-0 border-t border-[var(--blanc-line)] bg-[var(--blanc-bg,#efe9df)] px-5 py-3">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div className="grid grid-cols-2 gap-2 md:flex">
                        <Button variant="outline" size="sm" onClick={() => window.open(`/api/invoices/${invoice.id}/pdf`, '_blank', 'noopener,noreferrer')}>
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
                                            <DropdownMenuItem onSelect={() => setManualCardOpen(true)}>
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
                onSuccess={() => { onChanged?.(invoice); }}
            />
        </div>
    );
}
