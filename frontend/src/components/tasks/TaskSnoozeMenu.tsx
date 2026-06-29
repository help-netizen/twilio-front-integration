import { useState } from 'react';
import { Clock, CalendarDays } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '../ui/popover';
import { snoozePresets, customDateToDueIso } from './taskUtils';

interface Props {
    tz: string;
    onSnooze: (dueIso: string) => void;
    /** Render just the icon (compact list rows) vs. icon + label. */
    iconOnly?: boolean;
}

const itemStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
    padding: '7px 10px', fontSize: 13, color: 'var(--blanc-ink-1)', background: 'none',
    border: 'none', borderRadius: 8, cursor: 'pointer',
};

export function TaskSnoozeMenu({ tz, onSnooze, iconOnly }: Props) {
    const [open, setOpen] = useState(false);
    const [pickDate, setPickDate] = useState(false);
    const presets = snoozePresets(tz);

    const pick = (iso: string) => {
        setOpen(false);
        setPickDate(false);
        onSnooze(iso);
    };

    return (
        <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setPickDate(false); }}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    title="Snooze"
                    className="inline-flex items-center gap-1.5 transition-opacity hover:opacity-70"
                    style={{
                        fontSize: 12, padding: iconOnly ? '4px 7px' : '4px 10px', borderRadius: 8,
                        border: '1px solid var(--blanc-line)', background: 'transparent', color: 'var(--blanc-ink-2)', cursor: 'pointer',
                    }}
                >
                    <Clock className="size-3.5" />{!iconOnly && 'Snooze'}
                </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 p-1" style={{ background: 'var(--blanc-surface-strong, #fffdf9)', border: '1px solid var(--blanc-line)' }}>
                {presets.map(p => (
                    <button key={p.key} type="button" style={itemStyle} className="hover:bg-[rgba(117,106,89,0.06)]" onClick={() => pick(p.dueIso)}>
                        {p.label}
                    </button>
                ))}
                {!pickDate ? (
                    <button type="button" style={{ ...itemStyle, color: 'var(--blanc-ink-2)' }} className="hover:bg-[rgba(117,106,89,0.06)]" onClick={() => setPickDate(true)}>
                        <CalendarDays className="size-3.5" /> Pick a date…
                    </button>
                ) : (
                    <input
                        type="date"
                        autoFocus
                        className="w-full text-sm outline-none"
                        style={{ border: '1px solid var(--blanc-line)', borderRadius: 8, padding: '6px 10px', margin: '2px', color: 'var(--blanc-ink-1)', background: 'transparent' }}
                        onChange={(e) => {
                            const iso = customDateToDueIso(e.target.value, tz);
                            if (iso) pick(iso);
                        }}
                    />
                )}
            </PopoverContent>
        </Popover>
    );
}
