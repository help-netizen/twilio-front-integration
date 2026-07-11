import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog';
import { Button } from '../ui/button';

// SOFTPHONE-WARMUP-SUMMARY-001 §3: pure presentation — no fetches, no timers,
// no state beyond render. AppLayout owns the warm-up semantics (warmUpAudio,
// belts, counts plumbing) and passes everything via props.
//
// FORM-CANON ruling (pinned): confirmation-class dialog → center
// variant="dialog" stays. THE canonical center-modal exception (short, one
// primary action, exists to capture the audio-unlock gesture).
//
// Owner iteration #2 (2026-07-11): humanized — time-of-day greeting, airy
// rhythm, plain stat phrases written as literal strings — "in Pulse inbox" keeps
// its capital P (product section name; no text-transform) — centered
// auto-width button, tiny footnote explaining the sound gesture.
//
// Owner iteration #3: a LOADED ZERO hides its column (remaining ones
// re-center); all three loaded zeros → one human "all clear" line instead of
// the grid. null (loading/error) is NOT a zero — it keeps its "—" column.
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

const COLUMNS: ReadonlyArray<{ key: keyof WarmUpSummaryDialogProps['counts']; label: string; phrase: string; path: string }> = [
    { key: 'pulseInbox', label: 'Pulse inbox', phrase: 'in Pulse inbox', path: '/pulse' },
    { key: 'newLeads', label: 'New leads', phrase: 'new leads', path: '/leads' },
    { key: 'openTasks', label: 'Open tasks', phrase: 'open tasks', path: '/tasks' },
];

function timeOfDayGreeting(): string {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
}

export function WarmUpSummaryDialog({ open, counts, onNavigate, onDismiss }: WarmUpSummaryDialogProps) {
    // Iteration #3 zero-hiding: only a confirmed 0 hides; null stays as "—".
    const visible = COLUMNS.filter(({ key }) => counts[key] !== 0);
    return (
        <Dialog open={open} onOpenChange={o => { if (!o) onDismiss(); }}>
            {/* Backdrop click must NOT dismiss (pinned §2.7 row 5) — Escape and the corner × still do. */}
            <DialogContent className="sm:max-w-[480px] gap-0 p-8 sm:p-10" onPointerDownOutside={e => e.preventDefault()}>
                <DialogHeader className="text-center sm:text-center space-y-2">
                    <DialogTitle
                        className="text-[28px] leading-tight"
                        style={{ fontFamily: 'var(--blanc-font-heading)', fontWeight: 800, color: 'var(--blanc-ink-1)' }}
                    >
                        {timeOfDayGreeting()}
                    </DialogTitle>
                    <DialogDescription className="text-[15px] normal-case" style={{ color: 'var(--blanc-ink-2)' }}>
                        Here's your day at a glance.
                    </DialogDescription>
                </DialogHeader>
                {/* Visually plain stat columns — no plates, no borders, no uppercase.
                    Still real buttons (a11y + click-to-navigate); hover tints the number.
                    Flex + justify-center so 1-2 surviving columns sit centered. */}
                {visible.length === 0 ? (
                    <p className="mt-8 text-center text-[15px]" style={{ color: 'var(--blanc-ink-2)' }}>
                        All clear — nothing urgent right now.
                    </p>
                ) : (
                <div className="mt-8 flex justify-center gap-8 sm:gap-10">
                    {visible.map(({ key, label, phrase, path }) => {
                        const value = counts[key];
                        return (
                            <button
                                key={key}
                                type="button"
                                onClick={() => onNavigate(path)}
                                aria-label={`${label}: ${value === null ? 'not loaded' : value}`}
                                className="group flex min-h-[44px] flex-col items-center justify-start gap-1.5 bg-transparent"
                            >
                                <span
                                    className={`text-4xl leading-none tabular-nums transition-colors ${
                                        value === null
                                            ? 'text-[var(--blanc-ink-3)]'
                                            : 'text-[var(--blanc-ink-1)] group-hover:text-[var(--blanc-accent)]'
                                    }`}
                                    style={{ fontFamily: 'var(--blanc-font-heading)', fontWeight: 800 }}
                                >
                                    {value === null ? '—' : value}
                                </span>
                                <span className="text-[13px]" style={{ color: 'var(--blanc-ink-2)' }}>
                                    {phrase}
                                </span>
                            </button>
                        );
                    })}
                </div>
                )}
                <div className="mt-9 flex justify-center">
                    <Button size="lg" className="px-10" onClick={onDismiss}>Let's go</Button>
                </div>
                <p className="mt-6 text-center text-[11px]" style={{ color: 'var(--blanc-ink-3)' }}>
                    Sound for incoming calls turns on when you continue.
                </p>
            </DialogContent>
        </Dialog>
    );
}
