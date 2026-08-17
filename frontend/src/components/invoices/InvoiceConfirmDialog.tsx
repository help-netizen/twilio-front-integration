import type { ReactNode } from 'react';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description: ReactNode;
    confirmLabel: string;
    onConfirm: () => void | Promise<void>;
    confirmTestId: string;
    confirmTone?: 'neutral' | 'danger';
    cancelLabel?: string;
    busy?: boolean;
    children?: ReactNode;
}

/** Centered confirmation at every width. The full-screen mobile Dialog shell only
 * supplies focus trapping and viewport safety; the visible card remains centered. */
export function InvoiceConfirmDialog({
    open,
    onOpenChange,
    title,
    description,
    confirmLabel,
    onConfirm,
    confirmTestId,
    confirmTone = 'danger',
    cancelLabel = 'Keep',
    busy = false,
    children,
}: Props) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                variant="dialog"
                size="sm"
                mobileFullScreen
                className="max-md:flex max-md:items-center max-md:justify-center max-md:border-0 max-md:bg-transparent max-md:p-4 max-md:shadow-none [&>button[aria-label='Close']]:hidden"
            >
                <div className="w-full rounded-[18px] bg-[var(--blanc-panel-surface)] p-5 shadow-lg md:contents">
                    <DialogTitle
                        className="pr-8 text-[20px] font-semibold leading-tight text-[var(--blanc-ink-1)]"
                        style={{ fontFamily: 'var(--blanc-font-heading)' }}
                    >
                        {title}
                    </DialogTitle>
                    <DialogDescription asChild>
                        <div className="mt-2 text-[14px] leading-relaxed text-[var(--blanc-ink-2)]">
                            {description}
                        </div>
                    </DialogDescription>
                    {children}
                    <div className="mt-[18px] grid grid-cols-2 gap-2.5">
                        <Button
                            type="button"
                            variant="ghost"
                            size="action" className="h-[46px] rounded-[13px] bg-[var(--blanc-field)] text-[15px] text-[var(--blanc-ink-1)]"
                            onClick={() => onOpenChange(false)}
                            disabled={busy}
                        >
                            {cancelLabel}
                        </Button>
                        <Button
                            type="button"
                            variant={confirmTone === 'danger' ? 'destructive' : 'default'}
                            className={`h-[46px] rounded-[13px] text-[15px] font-semibold ${
                                confirmTone === 'neutral'
                                    ? 'bg-[var(--blanc-ink-1)] text-white hover:bg-[var(--blanc-ink-1)]/90'
                                    : ''
                            }`}
                            onClick={onConfirm}
                            disabled={busy}
                            data-testid={confirmTestId}
                        >
                            {busy ? 'Working…' : confirmLabel}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
