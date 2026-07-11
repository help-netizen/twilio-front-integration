import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';

// SOFTPHONE-WARMUP-SUMMARY-001 §3: pure presentation — no fetches, no timers,
// no state beyond render. AppLayout owns the warm-up semantics (warmUpAudio,
// belts, counts plumbing) and passes everything via props.
//
// FORM-CANON ruling (pinned): confirmation-class dialog → center
// variant="dialog" stays. THE canonical center-modal exception (short, one
// primary action, exists to capture the audio-unlock gesture).
export interface WarmUpSummaryDialogProps {
    open: boolean;
    counts: {
        pulseInbox: number | null;
        newLeads: number | null;
        openTasks: number | null;
    };
    onNavigate: (path: string) => void;
    onDismiss: () => void;
}

const COLUMNS: ReadonlyArray<{ key: keyof WarmUpSummaryDialogProps['counts']; label: string; path: string }> = [
    { key: 'pulseInbox', label: 'Pulse inbox', path: '/pulse' },
    { key: 'newLeads', label: 'New leads', path: '/leads' },
    { key: 'openTasks', label: 'Open tasks', path: '/tasks' },
];

export function WarmUpSummaryDialog({ open, counts, onNavigate, onDismiss }: WarmUpSummaryDialogProps) {
    return (
        <Dialog open={open} onOpenChange={o => { if (!o) onDismiss(); }}>
            {/* Backdrop click must NOT dismiss (pinned §2.7 row 5) — Escape and the corner × still do. */}
            <DialogContent className="sm:max-w-[520px]" onPointerDownOutside={e => e.preventDefault()}>
                <DialogHeader>
                    <DialogTitle style={{ fontFamily: 'var(--blanc-font-heading)', fontWeight: 800 }}>Today at a glance</DialogTitle>
                    <DialogDescription className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>Enabling sound for incoming calls</DialogDescription>
                </DialogHeader>
                {/* Owner direction 2026-07-11: no block-in-block — columns sit directly on the dialog surface. */}
                <div className="grid grid-cols-3 gap-2">
                    {COLUMNS.map(({ key, label, path }) => {
                        const value = counts[key];
                        return (
                            <button
                                key={key}
                                type="button"
                                onClick={() => onNavigate(path)}
                                aria-label={`${label}: ${value === null ? 'not loaded' : value}`}
                                className="flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-xl px-1 py-2 hover:bg-[var(--blanc-surface-muted)]"
                            >
                                <span
                                    className="text-2xl leading-none tabular-nums"
                                    style={{
                                        fontFamily: 'var(--blanc-font-heading)',
                                        fontWeight: 700,
                                        color: value === null ? 'var(--blanc-ink-3)' : 'var(--blanc-ink-1)',
                                    }}
                                >
                                    {value === null ? '—' : value}
                                </span>
                                <span className="blanc-eyebrow">{label}</span>
                            </button>
                        );
                    })}
                </div>
                <DialogFooter>
                    <Button size="lg" className="w-full" onClick={onDismiss}>Let's go</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
