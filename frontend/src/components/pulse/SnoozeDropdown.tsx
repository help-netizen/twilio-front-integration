import { useState, useEffect, useRef } from 'react';
import { Clock, X } from 'lucide-react';
import { SNOOZE_OPTIONS, getSnoozeUntil } from './PulseContactItem';
import { isMobileViewport, clampToViewport } from '../../hooks/useViewportSafePosition';

interface SnoozeDropdownProps {
    onSnooze: (until: string) => void;
    companyTz: string;
}

export function SnoozeDropdown({ onSnooze, companyTz }: SnoozeDropdownProps) {
    const [open, setOpen] = useState(false);
    const btnRef = useRef<HTMLButtonElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            const target = e.target as Node;
            if (btnRef.current?.contains(target) || dropdownRef.current?.contains(target)) return;
            setOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    const isMobile = open && isMobileViewport();
    const rect = btnRef.current?.getBoundingClientRect();
    const desktopPos = rect && !isMobile ? clampToViewport(rect, 190, 220) : null;

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
        <div className="relative">
            <button
                ref={btnRef}
                onClick={() => setOpen(!open)}
                className="inline-flex items-center gap-1.5 px-4 text-sm font-semibold transition-opacity hover:opacity-70"
                style={{ color: 'var(--blanc-ink-1)', background: 'var(--blanc-surface-strong)', border: '1px solid rgba(104, 95, 80, 0.14)', minHeight: 42, borderRadius: 14, boxShadow: 'rgba(48, 39, 28, 0.06) 0px 6px 16px' }}
            >
                <Clock className="size-4" /> Snooze
            </button>
            {open && isMobile && (
                <>
                    <div className="blanc-mobile-sheet-backdrop" onClick={() => setOpen(false)} />
                    <div ref={dropdownRef} className="blanc-mobile-sheet">
                        <div className="blanc-mobile-sheet-header">
                            <h3>Snooze</h3>
                            <button onClick={() => setOpen(false)} className="p-1 rounded-lg" style={{ color: 'var(--blanc-ink-3)' }}>
                                <X className="size-5" />
                            </button>
                        </div>
                        {dropdownContent}
                    </div>
                </>
            )}
            {open && !isMobile && desktopPos && (
                <div
                    ref={dropdownRef}
                    className="fixed z-[101] rounded-xl shadow-lg py-1 min-w-[190px]"
                    style={{
                        background: 'var(--blanc-surface-strong)',
                        border: '1px solid var(--blanc-line)',
                        left: desktopPos.left,
                        top: desktopPos.top,
                    }}
                >
                    {dropdownContent}
                </div>
            )}
        </div>
    );
}
