import { useState } from 'react';
import type { ReactNode } from 'react';
import { format } from 'date-fns';
import { Moon, CalendarDays, ChevronLeft } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '../ui/popover';
import { Calendar } from '../ui/calendar';
import { snoozePresets, customDateToDueIso, SNOOZE_MORNING_HOUR } from './taskUtils';

interface Props {
    tz: string;
    /** Receives the snoozed-until ISO instant (deadline/due_at is left intact). */
    onSnooze: (iso: string) => void;
    /** Render just the icon (compact list rows) vs. icon + label. */
    iconOnly?: boolean;
    /** Optional surface-owned trigger; the shared menu keeps the snooze semantics. */
    trigger?: ReactNode;
}

const itemStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left',
    padding: '8px 10px', fontSize: 13, color: 'var(--blanc-ink-1)', background: 'none',
    border: 'none', borderRadius: 8, cursor: 'pointer',
};

export function TaskSnoozeMenu({ tz, onSnooze, iconOnly, trigger }: Props) {
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
                {trigger || (
                    <button
                        type="button"
                        title="Snooze"
                        className="inline-flex items-center gap-1.5 transition-opacity hover:opacity-70"
                        style={{
                            fontSize: 12, padding: iconOnly ? '4px 7px' : '4px 10px', borderRadius: 8,
                            border: '1px solid var(--blanc-line)', background: 'transparent', color: 'var(--blanc-ink-2)', cursor: 'pointer',
                        }}
                    >
                        <Moon className="size-3.5" />{!iconOnly && 'Snooze'}
                    </button>
                )}
            </PopoverTrigger>
            <PopoverContent
                align="end"
                className={pickDate ? 'p-2 w-auto' : 'w-60 p-1.5'}
                style={{ background: 'var(--blanc-surface-strong, #fffdf9)', border: '1px solid var(--blanc-line)' }}
            >
                {!pickDate ? (
                    <>
                        <div className="blanc-eyebrow" style={{ padding: '4px 10px 6px' }}>Snooze until</div>
                        {presets.map(p => (
                            <button key={p.key} type="button" style={itemStyle} className="hover:bg-[rgba(25,25,25,0.06)]" onClick={() => pick(p.dueIso)}>
                                {p.label}
                            </button>
                        ))}
                        <div style={{ height: 1, background: 'var(--blanc-line)', margin: '5px 8px' }} />
                        <button type="button" style={{ ...itemStyle, color: 'var(--blanc-ink-2)' }} className="hover:bg-[rgba(25,25,25,0.06)]" onClick={() => setPickDate(true)}>
                            <CalendarDays className="size-3.5" /> Pick a date…
                        </button>
                    </>
                ) : (
                    <div className="flex flex-col">
                        <button
                            type="button"
                            onClick={() => setPickDate(false)}
                            className="inline-flex items-center gap-1 self-start px-1.5 py-1 rounded-md hover:bg-[rgba(25,25,25,0.06)]"
                            style={{ fontSize: 12, color: 'var(--blanc-ink-2)', background: 'none', border: 'none', cursor: 'pointer' }}
                        >
                            <ChevronLeft className="size-3.5" /> Back
                        </button>
                        <Calendar
                            mode="single"
                            disabled={{ before: new Date() }}
                            onSelect={(date) => {
                                if (!date) return;
                                const iso = customDateToDueIso(format(date, 'yyyy-MM-dd'), tz);
                                if (iso) pick(iso);
                            }}
                        />
                        <div style={{ fontSize: 11, color: 'var(--blanc-ink-3)', textAlign: 'center', paddingBottom: 2 }}>
                            Wakes that morning at {SNOOZE_MORNING_HOUR}:00 AM
                        </div>
                    </div>
                )}
            </PopoverContent>
        </Popover>
    );
}
