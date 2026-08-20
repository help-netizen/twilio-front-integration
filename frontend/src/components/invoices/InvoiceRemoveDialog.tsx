import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
    previewInvoiceRemoval,
    removeInvoice,
    type InvoiceRemovalPreview,
} from '../../services/invoicesApi';
import { Checkbox } from '../ui/checkbox';
import { InvoiceConfirmDialog } from './InvoiceConfirmDialog';

function money(value: string | number | null | undefined): string {
    const amount = Number(value || 0);
    const body = Math.abs(amount).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
    return (amount < 0 ? '−$' : '$') + body;
}

/**
 * OB-70 — removing an invoice without losing the money.
 *
 * ONE dialog for every surface that offers it (the card and the list row), because the
 * two destructive items it replaces — "Delete draft" and "Void invoice" — were written
 * twice and drifted: a draft that had taken a card payment matched neither, so the card
 * offered Void and the server answered "Draft invoices must be deleted, not voided".
 *
 * It asks the server what removal would cost BEFORE promising anything: how much is
 * applied here, and whether another invoice could take it. A confirm that cannot name
 * the figure is not a confirm. Re-applying is always the dispatcher's answer — never
 * assumed, even when exactly one invoice matches (owner, 19.08).
 */
export function InvoiceRemoveDialog({
    invoice, open, onOpenChange, onRemoved,
}: {
    invoice: { id: number; invoice_number: string };
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onRemoved: () => void;
}) {
    const [preview, setPreview] = useState<InvoiceRemovalPreview | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [reapply, setReapply] = useState(false);
    const [busy, setBusy] = useState(false);
    // One id per opening: a double-tapped Remove is the same request, a second opening
    // is a new one.
    const requestId = useRef('');

    useEffect(() => {
        if (!open) return;
        let live = true;
        setPreview(null);
        setError(null);
        setReapply(false);
        requestId.current = crypto.randomUUID ? crypto.randomUUID() : `${invoice.id}-${Date.now()}`;
        previewInvoiceRemoval(invoice.id)
            .then(next => { if (live) setPreview(next); })
            .catch(err => { if (live) setError(err instanceof Error ? err.message : 'Could not check this invoice'); });
        return () => { live = false; };
    }, [invoice.id, open]);

    const paid = Number(preview?.payments_total || 0);
    const candidate = paid > 0 ? preview?.candidate ?? null : null;

    const confirm = async () => {
        if (!preview || busy) return;
        const target = reapply ? candidate : null;
        setBusy(true);
        try {
            await removeInvoice(invoice.id, {
                payment_action: target ? 'apply' : 'leave_unapplied',
                ...(target ? { target_invoice_id: target.id } : {}),
                preview_version: preview.preview_version,
                request_id: requestId.current,
            });
            onOpenChange(false);
            toast.success(target
                ? `Invoice removed — ${money(preview.payments_total)} moved to ${target.invoice_number}`
                : 'Invoice removed');
            onRemoved();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Could not remove invoice');
        } finally {
            setBusy(false);
        }
    };

    return (
        <InvoiceConfirmDialog
            open={open}
            onOpenChange={next => { if (!next && !busy) onOpenChange(false); }}
            title={`Remove invoice ${invoice.invoice_number}?`}
            description={error
                ? <span className="text-[var(--blanc-danger)]">{error}</span>
                : !preview
                    ? <span className="inline-flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Checking what is paid on it…</span>
                    : paid > 0
                        ? <>The <span className="font-semibold text-[var(--blanc-ink-1)]">{money(preview.payments_total)}</span> already paid stays on the job as credit — you can put it on the next invoice.</>
                        : <>This takes the invoice off the job. Nothing has been paid on it.</>}
            cancelLabel="Keep"
            confirmLabel="Remove invoice"
            confirmTestId="invoice-remove-confirm"
            onConfirm={confirm}
            busy={busy}
        >
            {candidate ? (
                <label
                    data-testid="invoice-remove-reapply"
                    className="blanc-l2 mt-3.5 flex cursor-pointer items-start gap-2.5 rounded-[12px] bg-[var(--blanc-surface-muted)] p-3"
                >
                    <Checkbox
                        checked={reapply}
                        onCheckedChange={next => setReapply(next === true)}
                        className="mt-0.5"
                    />
                    <span className="text-[var(--blanc-ink-1)]">
                        Put {money(preview?.payments_total)} on invoice {candidate.invoice_number}
                        <span className="text-[var(--blanc-ink-3)]"> — {money(candidate.balance_due)} due</span>
                    </span>
                </label>
            ) : null}
        </InvoiceConfirmDialog>
    );
}
