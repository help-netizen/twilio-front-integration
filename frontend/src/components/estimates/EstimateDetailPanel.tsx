import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Archive, Check, ChevronDown, Clock, Eye, FileText, Link2, Loader2, Pencil, Plus, RotateCcw, Send, Trash2, XCircle } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { MoneyInput } from '../ui/MoneyInput';
import { Label } from '../ui/label';
import { Checkbox } from '../ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Textarea } from '../ui/textarea';
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
import { StatusPill } from './EstimateStatusPill';
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
import { formatCompanyTime, useCompanyTime } from '../../lib/companyTime';

function money(value: string | number | null | undefined): string {
    return '$' + Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDateTime(value: string | null | undefined, timeZone: string): string {
    if (!value) return '-';
    return formatCompanyTime(value, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }, timeZone);
}

/**
 * History reads as events, not as a log. "Sent" with a timestamp under it is a
 * row in a table; "The customer opened it" is the sentence you would actually
 * say out loud, and it names who did the thing — which is the part that settles
 * an argument later. Anything unmapped degrades to its own words rather than
 * disappearing.
 */
const EVENT_SENTENCE: Record<string, string> = {
    created: 'Estimate created',
    updated: 'Estimate edited',
    sent: 'Sent to the customer',
    resent: 'Sent to the customer again',
    viewed: 'The customer opened it',
    approved: 'Approved',
    approved_by_client: 'The customer approved it',
    declined: 'Declined',
    declined_by_client: 'The customer declined it',
    converted: 'Turned into an invoice',
    invoice_created: 'Turned into an invoice',
    archived: 'Archived',
    restored: 'Restored to draft',
    job_linked: 'Linked to a job',
};

function describeEvent(evt: EstimateEvent): string {
    const mapped = EVENT_SENTENCE[evt.event_type];
    if (mapped) return mapped;
    const words = evt.event_type.replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
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
    const { timeZone } = useCompanyTime();
    const navigate = useNavigate();
    const { hasPermission } = useAuthz();
    const canSend = hasPermission('estimates.send');
    const canManagePriceBook = hasPermission('price_book.manage');
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
    // VIEW-FIRST (owner 2026-08-08): the panel opens as a read-only document preview —
    // items and totals render as plain info with no add/remove/edit affordances. The
    // footer's explicit Edit switches to the editing state (all existing readOnly-gated
    // affordances light up); Save returns to the preview. Archived estimates have no
    // Edit at all (permanently read-only, as before).
    const [editing, setEditing] = useState(false);
    useEffect(() => setEditing(false), [initialEstimate.id]);
    const canEdit = !archived;
    const readOnly = !editing || !canEdit;

    /**
     * Editing a non-draft estimate resets it to draft and clears the customer's
     * answer — that is existing backend behaviour (spec §2.12) and it is not
     * changing here. What changes is that it stops being silent: the warning
     * belongs to the tap, not to a caption sitting on the card forever, since
     * editing an answered estimate is rare and reading one is not.
     */
    const [confirmEditOpen, setConfirmEditOpen] = useState(false);
    const startEditing = () => {
        if (estimate.status === 'draft') { setEditing(true); return; }
        setConfirmEditOpen(true);
    };

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
                // so the item is searchable on future estimates. Only users with
                // price_book.manage may write the catalog; for everyone else the
                // item simply lands on this document (no scary 403 toast).
                if (savePresetOnNextItem && canManagePriceBook) {
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
                    } catch {
                        toast.warning('Item added — could not save it to the Price Book');
                    } finally {
                        setSavePresetOnNextItem(false);
                    }
                } else {
                    setSavePresetOnNextItem(false);
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

    /**
     * Creating the invoice IS the record that the customer agreed, so from a
     * draft or a sent estimate it approves at the same time (ESTIMATE-REDESIGN-001
     * §2.2). There is deliberately no confirmation dialog in front of it: this is
     * the frequent, constructive action — the technician is standing in the
     * kitchen and the customer just said yes — and the answer to those is Undo,
     * not a question. The toast says what changed, because a silent status jump
     * is how a funnel starts lying.
     */
    const handleConvertToInvoice = async () => {
        const wasApproved = estimate.status === 'approved';
        setConverting(true);
        try {
            const invoice = await convertEstimateToInvoice(estimate.id);
            const number = invoice.invoice_number || `#${invoice.id}`;
            toast.success(
                wasApproved ? `Invoice ${number} created` : `Invoice ${number} created · marked approved`,
                {
                    duration: 10_000,
                    action: {
                        label: <span data-testid="estimate-convert-undo">Undo</span>,
                        onClick: () => undoConversion(invoice.id),
                    },
                }
            );
            onInvoiceCreated?.();
            if (hasPermission('invoices.view')) navigate(`/invoices?openId=${invoice.id}`);
        } catch (err: any) {
            toast.error(err.message || 'Failed to create invoice');
        } finally {
            setConverting(false);
        }
    };

    /**
     * Undo is only offered because it is real: the backend refuses the moment the
     * invoice has been paid, sent, voided or edited, and expires after five
     * minutes. A refusal is shown as-is rather than swallowed — an Undo that
     * quietly does nothing is worse than no Undo at all.
     */
    const undoConversion = async (invoiceId: number) => {
        try {
            const { undoEstimateConversion } = await import('../../services/estimatesApi');
            const fresh = await undoEstimateConversion(estimate.id, invoiceId);
            setEstimate(fresh);
            onChanged?.(fresh);
            onInvoiceCreated?.();
            toast.success('Invoice removed · estimate restored');
        } catch (err: any) {
            toast.error(err?.message || 'That invoice can no longer be undone');
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

    // ESTIMATE-FOOTER-001: exactly ONE primary CTA per state; everything else → "More".
    // Owner amendment 2026-08-03: an explicit Save sits beside it — edits already
    // persist inline, so Save flushes any in-progress field and confirms, letting
    // the user keep the document without sending it.
    const previewPdf = () => openAuthedPdf(`/api/estimates/${estimate.id}/pdf`, `${estimate.estimate_number || `Estimate-${estimate.id}`}.pdf`)
        .catch(() => toast.error('Could not open the PDF'));
    const handleExplicitSave = async () => {
        (document.activeElement as HTMLElement | null)?.blur?.();
        await new Promise(resolve => setTimeout(resolve, 150)); // let on-blur saves land
        await refreshAfterItemChange().catch(() => {});
        toast.success('All changes saved');
        setEditing(false); // back to the read-only preview (VIEW-FIRST)
    };
    const doSend = () => { if (requireItems()) setSendOpen(true); };
    const doApprove = () => { if (requireItems()) onApprove(); };
    const openLinkedInvoice = () => navigate(`/invoices?openId=${estimate.invoice_id}`);

    /**
     * The action matrix (ESTIMATE-REDESIGN-001 §2.2). One primary — the next real
     * move toward an answer — and "Create invoice" beside it at EVERY live status,
     * because the customer usually says yes on the spot and recording that should
     * not cost three taps. Everything else is visible and quiet; there is no kebab,
     * because hiding an action does not make a screen simpler, only slower.
     *
     * Declined is the one place the shortcut is withheld: they said no, and if they
     * changed their mind the estimate gets revived deliberately.
     */
    type Action = { label: string; icon?: React.ReactNode; onClick: () => void; disabled?: boolean; testid?: string };

    const invoiceAction: Action = estimate.invoice_id
        ? { label: `Open invoice${estimate.invoice_number ? ` #${estimate.invoice_number}` : ''}`, icon: <FileText className="size-4" />, onClick: openLinkedInvoice, testid: 'estimate-open-invoice' }
        : { label: converting ? 'Creating…' : 'Create invoice', icon: <FileText className="size-4" />, onClick: handleConvertToInvoice, disabled: converting, testid: 'estimate-create-invoice' };

    const live = !archived;
    const waiting = estimate.status === 'sent' || estimate.status === 'viewed';
    const approved = estimate.status === 'approved';
    const declined = estimate.status === 'declined';

    const primaryAction: Action | null =
        archived ? { label: 'Restore to draft', icon: <RotateCcw className="size-4" />, onClick: onRestore }
        : approved ? invoiceAction
        : waiting ? { label: 'Mark approved', icon: <Check className="size-4" />, onClick: doApprove, testid: 'estimate-approve' }
        : declined ? { label: 'Revise & resend', icon: <Send className="size-4" />, onClick: doSend, testid: 'estimate-revise' }
        : canSend ? { label: 'Send estimate', icon: <Send className="size-4" />, onClick: doSend, testid: 'estimate-send' }
        : { label: 'Mark approved', icon: <Check className="size-4" />, onClick: doApprove, testid: 'estimate-approve' };

    const secondaryAction: Action | null =
        !live || declined ? null
        : approved ? { label: 'Resend', icon: <Send className="size-4" />, onClick: doSend, testid: 'estimate-resend' }
        : invoiceAction;

    const quietActions: Action[] = live
        ? [
            ...(waiting ? [{ label: 'Resend', icon: <Send className="size-4" />, onClick: doSend, testid: 'estimate-resend' }] : []),
            { label: 'Preview PDF', icon: <Eye className="size-4" />, onClick: previewPdf },
            ...(readOnly ? [{ label: 'Edit', icon: <Pencil className="size-4" />, onClick: startEditing, testid: 'estimate-edit' }] : []),
            ...(declined ? [invoiceAction] : []),
            ...(estimate.job_id ? [] : [{ label: 'Link a job', icon: <Link2 className="size-4" />, onClick: openLinkJobPrompt }]),
        ]
        : [];

    return (
        <div className={`flex h-full min-h-0 flex-col bg-[var(--blanc-panel-surface,#fffdf9)] text-[var(--blanc-ink-1)] ${archived ? 'grayscale opacity-60' : ''}`}>
            {/* ONE scroll surface at every width (design review 2026-07-23): the old
                per-column overflow-y-auto pair split the mobile viewport into two
                half-height scroll boxes — the meta column ate half the screen and
                scrolling only worked in whichever half you tapped first. Desktop keeps
                two columns inside the shared scroll; the meta column is sticky. The header
                lives INSIDE this scroller (owner 2026-08-08: it scrolls with the content,
                not pinned); overflow-x-hidden blocks the mobile horizontal rubber-band. */}
            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain">
                <div className="border-b border-[var(--blanc-line)] bg-[var(--blanc-panel-surface,#fffdf9)] px-5 py-4 pr-14">
                {/* IDENTITY (ESTIMATE-REDESIGN-001): the amount is the title, one grey
                    line names who it is for and what it belongs to, then the status.
                    Contact and job were a section with an icon in the first draft —
                    which fairly invited the question of why the job did not get one
                    too. A line answers both and claims to be neither. */}
                <p className="blanc-l2 blanc-l2-quiet">{estimate.estimate_number}</p>
                <h2
                    className="mt-1.5 text-[32px] font-semibold leading-none tabular-nums"
                    style={{ fontFamily: 'var(--blanc-font-heading)', letterSpacing: '-0.025em' }}
                    data-testid="estimate-total"
                >
                    {money(estimate.total)}
                </h2>
                <p className="blanc-l2 blanc-l2-quiet mt-1.5">
                    {estimate.contact_name || 'No customer linked'}
                    {estimate.job_id && (
                        <>
                            {' · '}
                            <a
                                href={`/jobs/${estimate.job_id}`}
                                onClick={e => { e.preventDefault(); window.open(`/jobs/${estimate.job_id}`, '_blank', 'noopener,noreferrer'); }}
                                style={{ color: 'var(--blanc-job)' }}
                                className="hover:underline"
                            >
                                Job #{estimate.job_number || estimate.job_id}
                            </a>
                        </>
                    )}
                </p>
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <StatusPill estimate={estimate} />
                    {archived && <Badge variant="outline">Archived</Badge>}
                </div>

                {/* ACTIONS — visible, never in a kebab, ordered by how often each is
                    the right one. Hidden while editing: then the only move is Save. */}
                {!editing && (primaryAction || secondaryAction || quietActions.length > 0) && (
                    <div className="mt-4 space-y-2">
                        {primaryAction && (
                            <Button
                                className="h-[50px] w-full text-[15px]"
                                onClick={primaryAction.onClick}
                                disabled={primaryAction.disabled}
                                data-testid={primaryAction.testid}
                            >
                                {primaryAction.icon}
                                <span className="ml-1.5">{primaryAction.label}</span>
                            </Button>
                        )}
                        {secondaryAction && (
                            <Button
                                variant="secondary"
                                className="h-[50px] w-full text-[15px]"
                                onClick={secondaryAction.onClick}
                                disabled={secondaryAction.disabled}
                                data-testid={secondaryAction.testid}
                            >
                                {secondaryAction.icon}
                                <span className="ml-1.5">{secondaryAction.label}</span>
                            </Button>
                        )}
                        {quietActions.map(action => (
                            <Button
                                key={action.label}
                                variant="ghost"
                                className="h-11 w-full justify-center text-[15px] font-medium"
                                style={{ color: 'var(--blanc-ink-2)' }}
                                onClick={action.onClick}
                                disabled={action.disabled}
                                data-testid={action.testid}
                            >
                                {action.icon}
                                <span className="ml-1.5">{action.label}</span>
                            </Button>
                        ))}
                        {/* Refusing on the customer's behalf, and archiving, sit last and
                            muted: rare, and one of them is how you lose a proposal. */}
                        {live && !declined && (
                            <Button
                                variant="ghost"
                                className="h-11 w-full justify-center text-[15px] font-medium"
                                style={{ color: 'var(--blanc-danger)' }}
                                onClick={() => setDeclineOpen(true)}
                                data-testid="estimate-decline"
                            >
                                <XCircle className="size-4" />
                                <span className="ml-1.5">Decline on customer’s behalf</span>
                            </Button>
                        )}
                        {live && (
                            <Button
                                variant="ghost"
                                className="h-11 w-full justify-center text-[15px] font-medium"
                                style={{ color: 'var(--blanc-danger)' }}
                                onClick={onArchive}
                                data-testid="estimate-archive"
                            >
                                <Archive className="size-4" />
                                <span className="ml-1.5">Archive estimate</span>
                            </Button>
                        )}
                    </div>
                )}
            </div>
                <div className="grid grid-cols-[minmax(0,1fr)] md:grid-cols-[minmax(0,1fr)_300px] md:gap-8">
                <main className="min-w-0 space-y-6 p-5 md:py-6 md:pl-6 md:pr-0">
                    {/* Summary — OB-28: same presentation as the create/edit form (owner):
                        dashed invite block when empty, collapsible card when filled. */}
                    {estimate.summary ? readOnly ? (
                        /* VIEW MODE: flat — no box; the eyebrow row keeps the collapse chevron. */
                        <section>
                            <button
                                type="button"
                                onClick={() => setSummaryOpen(o => !o)}
                                className="flex items-center gap-1.5"
                            >
                                <span className="blanc-eyebrow">Summary</span>
                                <ChevronDown className={`size-3.5 text-[var(--blanc-ink-3)] transition-transform ${summaryOpen ? 'rotate-180' : ''}`} />
                            </button>
                            {summaryOpen && (
                                <p className="mt-3 text-sm whitespace-pre-wrap text-[var(--blanc-ink-2)]">{estimate.summary}</p>
                            )}
                        </section>
                    ) : (
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
                    ) : !readOnly ? (
                        /* Edit mode only — no empty-state box in the preview. */
                        <div className="rounded-md border border-dashed border-[var(--blanc-line)] px-4 py-5" style={{ background: 'rgba(25,25,25,0.03)' }}>
                            <p className="text-sm font-medium">Summary</p>
                            <p className="mt-1 text-sm text-[var(--blanc-ink-3)]">Add make, model, issue, findings, needs, and cause when the estimate needs client context.</p>
                            {!readOnly && (
                                <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => setSummaryDialogOpen(true)}>
                                    <Plus className="mr-1 size-4" /> Add summary
                                </Button>
                            )}
                        </div>
                    ) : null}

                    {/* Items */}
                    <section>
                        <div className="mb-3 flex items-end justify-between gap-3">
                            <div>
                                <p className="blanc-eyebrow">Items</p>
                            </div>
                        </div>
                        {hasItems ? (
                            <div className={readOnly ? 'space-y-4' : 'space-y-2'}>
                                {estimate.items!.map(item => readOnly ? (
                                    /* VIEW MODE: flat row, no tile chrome (owner: flat design).
                                       Qty × price folds into the price line — `2 × $140.00 = $280.00` —
                                       and is omitted for qty 1 (the overwhelmingly common case, so the
                                       row stays one line shorter). Long names truncate. Taxable trails
                                       the description on the same line. */
                                    <div key={item.id} className="text-sm">
                                        <div className="flex items-baseline justify-between gap-3">
                                            <p className="min-w-0 truncate font-medium">{item.name}</p>
                                            <p className="shrink-0 font-mono whitespace-nowrap">
                                                {Number(item.quantity) !== 1 && (
                                                    <span className="text-[var(--blanc-ink-3)]">{Number(item.quantity)} × {money(item.unit_price)} = </span>
                                                )}
                                                <span className="font-semibold">{money(item.amount)}</span>
                                            </p>
                                        </div>
                                        {(item.description || item.taxable) && (
                                            <p className="mt-0.5 whitespace-pre-wrap text-[var(--blanc-ink-2)]">
                                                {item.description}
                                                {item.taxable && <span className="text-xs text-[var(--blanc-ink-3)]">{item.description ? ' · ' : ''}Taxable</span>}
                                            </p>
                                        )}
                                    </div>
                                ) : (
                                    /* EDIT MODE tile: name↔amount header, full-width description, meta
                                       row with actions — no dead right gutter on narrow widths. */
                                    <div
                                        key={item.id}
                                        className="rounded-md border border-[var(--blanc-line)] bg-[var(--blanc-panel-surface,#fffdf9)] p-4 text-sm transition-colors cursor-pointer hover:bg-white"
                                        onClick={() => openEditItem(item)}
                                    >
                                        <div className="flex items-start justify-between gap-3">
                                            <p className="min-w-0 font-medium">{item.name}</p>
                                            <p className="shrink-0 font-mono font-semibold whitespace-nowrap">{money(item.amount)}</p>
                                        </div>
                                        {item.description && <p className="mt-1 whitespace-pre-wrap text-[var(--blanc-ink-2)]">{item.description}</p>}
                                        <div className="mt-2 flex items-center gap-2 text-xs text-[var(--blanc-ink-2)]">
                                            <span>{Number(item.quantity)} × {money(item.unit_price)}</span>
                                            {item.taxable && <span className="blanc-l2 blanc-l2-quiet">· taxable</span>}
                                            <span className="ml-auto flex items-center gap-1">
                                                <Button type="button" size="sm" variant="ghost" className="size-7 p-0" onClick={(e) => { e.stopPropagation(); openEditItem(item); }} title="Edit item">
                                                    <Pencil className="size-4" />
                                                </Button>
                                                <Button type="button" size="sm" variant="ghost" className="size-7 p-0 text-red-600" onClick={(e) => { e.stopPropagation(); handleRemoveItem(item.id); }} title="Remove item">
                                                    <Trash2 className="size-4" />
                                                </Button>
                                            </span>
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
                            {discountType ? readOnly ? (
                                /* View mode: the discount is a plain info row like Subtotal/Tax
                                   (percentage discounts show the rate beside the label). */
                                <div className="flex justify-between">
                                    <span className="text-[var(--blanc-ink-2)]">
                                        Discount{discountType === 'percentage' && Number(discountValue) > 0 ? ` (${Number(discountValue)}%)` : ''}
                                    </span>
                                    <span className="font-mono text-red-600">-{money(estimate.discount_amount)}</span>
                                </div>
                            ) : (
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
                            {readOnly ? Number(taxRate) > 0 && (
                                /* View mode: plain rate row (omitted when 0 — no empty states). */
                                <div className="flex justify-between">
                                    <span className="text-[var(--blanc-ink-2)]">Tax rate</span>
                                    <span className="font-mono">{taxRate}%</span>
                                </div>
                            ) : (
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
                                            className="h-8 w-full pr-7 text-right tabular-nums"
                                        />
                                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-[var(--blanc-ink-3)]">%</span>
                                    </div>
                                </div>
                            )}
                            <div className="flex justify-between">
                                <span className="text-[var(--blanc-ink-2)]">Tax</span>
                                <span className="font-mono">{money(estimate.tax_amount)}</span>
                            </div>
                            <div className="flex justify-between border-t pt-2 text-base font-semibold">
                                <span>Total</span>
                                <span className="font-mono">{money(estimate.total)}</span>
                            </div>
                            {Number(estimate.deposit_paid || 0) > 0 && (
                                <>
                                    <div className="flex justify-between">
                                        <span className="text-[var(--blanc-ink-2)]">Total Paid</span>
                                        <span className="font-mono">{money(estimate.deposit_paid)}</span>
                                    </div>
                                    <div className="flex justify-between font-semibold">
                                        <span>Total Due</span>
                                        <span className="font-mono">{money(estimate.balance_due ?? Number(estimate.total) - Number(estimate.deposit_paid))}</span>
                                    </div>
                                </>
                            )}
                        </div>
                    </section>
                </main>

                {/* Meta column: invisible container (no tint, no border) — flows under
                    the document on mobile, sticks beside it on desktop. */}
                <aside className="min-w-0 space-y-6 px-5 pb-6 md:sticky md:top-0 md:self-start md:py-6 md:pl-0 md:pr-6">
                    {/* Tasks are meta, not document content — they live beside the
                        document (desktop) / after it (mobile), so the first screen
                        belongs to the estimate itself (green-path review). */}
                    <TaskStack parentType="estimate" parentId={estimate.id} title="Tasks" />

                    <section className="space-y-3 text-sm">
                        <p className="blanc-eyebrow">Document settings</p>
                        {readOnly ? (
                            /* View mode: plain Yes/No — same style as the Deposit row below. */
                            <div className="flex items-center justify-between">
                                <span className="text-[var(--blanc-ink-2)]">Require signature</span>
                                <span className="font-medium">{estimate.signature_required ? 'Yes' : 'No'}</span>
                            </div>
                        ) : (
                            <label className="flex items-center justify-between cursor-pointer">
                                <span className="text-[var(--blanc-ink-2)]">Require signature</span>
                                <Checkbox
                                    checked={!!estimate.signature_required}
                                    onCheckedChange={(checked) => persist({ signature_required: !!checked } as any)}
                                />
                            </label>
                        )}
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
                                        <p className="text-xs text-[var(--blanc-ink-3)]">{fmtDateTime(estimate.signature_consented_at, timeZone)}</p>
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
                        <section data-testid="estimate-history">
                            <p
                                className="blanc-l2 blanc-l2-quiet flex items-center gap-1.5"
                                style={{ fontWeight: 600, marginBottom: 4 }}
                            >
                                <Clock className="size-3.5" /> History
                            </p>
                            {events.map(evt => (
                                <div
                                    key={evt.id}
                                    className="py-1.5"
                                    data-testid="estimate-history-event"
                                    data-event-type={evt.event_type}
                                >
                                    <span className="blanc-l2 block">{describeEvent(evt)}</span>
                                    <span className="blanc-l2 blanc-l2-quiet block">{fmtDateTime(evt.created_at, timeZone)}</span>
                                </div>
                            ))}
                        </section>
                    )}
                </aside>
                </div>
            </div>

            {/* While editing, Save is the only thing that matters — the document is in
                flight and every other action would act on a half-written state. Once
                saved the panel returns to view-first and the action stack takes over. */}
            {editing && canEdit && (
                <div className="shrink-0 border-t border-[var(--blanc-line)] bg-[var(--blanc-panel-surface,#fffdf9)] px-5 py-3">
                    <div className="flex items-center justify-end gap-2">
                        <Button variant="secondary" onClick={handleExplicitSave} data-testid="estimate-save">
                            <Check className="mr-1.5 size-4" />Save
                        </Button>
                    </div>
                </div>
            )}

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

            {/* Editing an answered estimate throws the answer away (spec §2.12). The
                backend has always done this; saying so at the tap is the whole fix. */}
            <Dialog open={confirmEditOpen} onOpenChange={setConfirmEditOpen}>
                <DialogContent variant="dialog" size="sm">
                    <DialogHeader><DialogTitle>Edit this estimate?</DialogTitle></DialogHeader>
                    <p className="blanc-l2" style={{ color: 'var(--blanc-ink-2)' }}>
                        {estimate.estimate_number} will go back to <b style={{ color: 'var(--blanc-ink-1)' }}>Draft</b>
                        {estimate.status === 'approved' ? ' and the approval will be cleared' : ''}
                        {estimate.invoice_id ? '. The invoice already created stays.' : '.'}
                    </p>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setConfirmEditOpen(false)}>Keep as is</Button>
                        <Button
                            onClick={() => { setConfirmEditOpen(false); setEditing(true); }}
                            data-testid="estimate-edit-confirm"
                        >
                            Edit anyway
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
