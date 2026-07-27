/**
 * TXN-STATUS-VOID-001 — shared "Void payment" confirmation (spec §7).
 * Centered confirm modal (variant="dialog") with a required Reason field. Used by every
 * payment-void surface (Job finance, Invoice detail, Transactions ledger) so the copy,
 * validation and reason capture stay identical. The caller owns the actual void call.
 */
import { useState } from 'react';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogFooter,
    DialogTitle,
    DialogDescription,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { FloatingField } from '../ui/floating-field';
import { Loader2 } from 'lucide-react';

const REASON_MAX = 500;

interface VoidPaymentDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Perform the void with the trimmed reason. Throw to keep the dialog open (caller toasts). */
    onConfirm: (reason: string) => Promise<void>;
    /** Body copy — differs for a job-standalone vs invoice-linked payment. */
    bodyText: string;
}

export function VoidPaymentDialog({ open, onOpenChange, onConfirm, bodyText }: VoidPaymentDialogProps) {
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);
    const trimmed = reason.trim();

    const handleOpenChange = (next: boolean) => {
        if (busy) return;
        if (!next) setReason('');
        onOpenChange(next);
    };

    const submit = async () => {
        if (!trimmed || busy) return;
        setBusy(true);
        try {
            await onConfirm(trimmed);
            setReason('');
            onOpenChange(false);
        } catch {
            // The caller surfaces the error toast; keep the dialog open for a retry.
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent variant="dialog" size="sm">
                <DialogHeader>
                    <DialogTitle
                        className="text-lg font-semibold"
                        style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                    >
                        Void payment
                    </DialogTitle>
                    <DialogDescription className="text-sm text-[var(--blanc-ink-2)]">
                        {bodyText}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-1.5">
                    <FloatingField
                        label="Reason"
                        textarea
                        rows={2}
                        value={reason}
                        onChange={e => setReason(e.target.value.slice(0, REASON_MAX))}
                    />
                    <p className="px-1 text-xs text-[var(--blanc-ink-3)]">E.g. bounced check</p>
                </div>

                <DialogFooter>
                    <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={busy}>
                        Cancel
                    </Button>
                    <Button variant="destructive" onClick={() => void submit()} disabled={!trimmed || busy}>
                        {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
                        {busy ? 'Voiding…' : 'Void payment'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
