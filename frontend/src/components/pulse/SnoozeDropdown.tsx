import { useState, useEffect, useRef } from 'react';
import { Clock } from 'lucide-react';
import { SNOOZE_OPTIONS, getSnoozeUntil } from './PulseContactItem';

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

    const rect = btnRef.current?.getBoundingClientRect();

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
            {open && rect && (
                <div
                    ref={dropdownRef}
                    className="fixed z-[101] rounded-xl shadow-lg py-1 min-w-[170px]"
                    style={{
                        background: 'var(--blanc-surface-strong)',
                        border: '1px solid var(--blanc-line)',
                        left: rect.left,
                        top: rect.bottom + 4,
                    }}
                >
                    {SNOOZE_OPTIONS.map(opt => (
                        <div
                            key={opt.label}
                            role="button"
                            tabIndex={0}
                            onClick={() => { onSnooze(getSnoozeUntil(opt, companyTz)); setOpen(false); }}
                            className="px-3 py-2 text-sm hover:bg-muted/60 cursor-pointer"
                            style={{ color: 'var(--blanc-ink-1)' }}
                        >
                            {opt.label}
                        </div>
                    ))}
                    <div className="mt-1 pt-1 px-3 py-1" style={{ borderTop: '1px solid var(--blanc-line)' }}>
                        <label className="text-[10px] block mb-1" style={{ color: 'var(--blanc-ink-3)' }}>Specific date</label>
                        <input
                            type="date"
                            className="text-xs rounded-lg px-2 py-1 w-full"
                            style={{ border: '1px solid var(--blanc-line)', background: 'var(--blanc-surface-strong)', color: 'var(--blanc-ink-1)' }}
                            min={new Date().toISOString().split('T')[0]}
                            onChange={(e) => {
                                if (!e.target.value) return;
                                const d = new Date(e.target.value + 'T09:00:00');
                                onSnooze(d.toISOString());
                                setOpen(false);
                            }}
                        />
                    </div>
                </div>
            )}
        </div>
    );
}
