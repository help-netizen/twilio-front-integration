import { useState } from 'react';
import { Clock } from 'lucide-react';
import { SNOOZE_OPTIONS, getSnoozeUntil } from './PulseContactItem';
import { isMobileViewport } from '../../hooks/useViewportSafePosition';
import { BottomSheet } from '../ui/BottomSheet';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

interface SnoozeDropdownProps {
    onSnooze: (until: string) => void;
    companyTz: string;
    compact?: boolean;
}

export function SnoozeDropdown({ onSnooze, companyTz, compact = false }: SnoozeDropdownProps) {
    const [open, setOpen] = useState(false);
    const isMobile = isMobileViewport();

    const dropdownContent = (
        <>
            {SNOOZE_OPTIONS.map(opt => (
                <div
                    key={opt.label}
                    role="button"
                    tabIndex={0}
                    onClick={() => { onSnooze(getSnoozeUntil(opt, companyTz)); setOpen(false); }}
                    className="px-4 py-3 text-sm hover:bg-muted/60 cursor-pointer"
                    style={{ color: 'var(--blanc-ink-1)' }}
                >
                    {opt.label}
                </div>
            ))}
            <div className="mt-1 pt-1 px-4 py-2" style={{ borderTop: '1px solid var(--blanc-line)' }}>
                <label className="text-[10px] block mb-1" style={{ color: 'var(--blanc-ink-3)' }}>Specific date</label>
                <input
                    type="date"
                    className="text-sm rounded-lg px-3 py-2 w-full"
                    style={{ border: '1px solid var(--blanc-line)', background: 'var(--blanc-surface-strong)', color: 'var(--blanc-ink-1)', minHeight: 42 }}
                    min={new Date().toISOString().split('T')[0]}
                    onChange={(e) => {
                        if (!e.target.value) return;
                        const d = new Date(e.target.value + 'T09:00:00');
                        onSnooze(d.toISOString());
                        setOpen(false);
                    }}
                />
            </div>
        </>
    );

    return (
        <>
            {/* desktop = канонный Popover (тир z-150, dismiss из коробки — самодельный
                fixed z-[101] + click-outside/clampToViewport снесены, W3-аудит),
                mobile = канонный BottomSheet как и был. */}
            <Popover open={open && !isMobile} onOpenChange={setOpen}>
                <PopoverTrigger asChild>
                    <button
                        type="button"
                        className={compact ? 'pulse-ar-task-action' : 'inline-flex items-center gap-1.5 px-4 text-sm font-semibold transition-opacity hover:opacity-70'}
                        style={compact ? undefined : { color: 'var(--blanc-ink-1)', background: 'var(--blanc-surface-strong)', border: '1px solid rgba(104, 95, 80, 0.14)', minHeight: 42, borderRadius: 14, boxShadow: 'rgba(48, 39, 28, 0.06) 0px 6px 16px' }}
                        aria-label="Snooze"
                        title="Snooze"
                    >
                        <Clock className="size-4" />
                        <span className={compact ? 'pulse-ar-task-action-label' : undefined}>Snooze</span>
                    </button>
                </PopoverTrigger>
                <PopoverContent align="start" sideOffset={4} className="w-auto min-w-[190px] p-0 py-1 rounded-xl">
                    {dropdownContent}
                </PopoverContent>
            </Popover>
            {open && isMobile && (
                <BottomSheet open={open} onClose={() => setOpen(false)} title="Snooze" size="auto">
                    {dropdownContent}
                </BottomSheet>
            )}
        </>
    );
}
