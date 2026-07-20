import { Checkbox } from '../ui/checkbox';
import { FloatingField } from '../ui/floating-field';

export type AgentCallWindowMode = 'company' | 'custom';

const DAYS = [
    { value: 1, label: 'Mon' },
    { value: 2, label: 'Tue' },
    { value: 3, label: 'Wed' },
    { value: 4, label: 'Thu' },
    { value: 5, label: 'Fri' },
    { value: 6, label: 'Sat' },
    { value: 0, label: 'Sun' },
];

interface AgentCallWindowFieldsProps {
    name: string;
    mode: AgentCallWindowMode;
    onModeChange: (mode: AgentCallWindowMode) => void;
    customStart: string;
    onCustomStartChange: (value: string) => void;
    customEnd: string;
    onCustomEndChange: (value: string) => void;
    workDays: number[];
    onWorkDaysChange: (days: number[]) => void;
}

export function AgentCallWindowFields({
    name,
    mode,
    onModeChange,
    customStart,
    onCustomStartChange,
    customEnd,
    onCustomEndChange,
    workDays,
    onWorkDaysChange,
}: AgentCallWindowFieldsProps) {
    const toggleDay = (day: number, checked: boolean) => {
        const next = checked
            ? [...new Set([...workDays, day])]
            : workDays.filter(value => value !== day);
        onWorkDaysChange(next.sort((a, b) => a - b));
    };

    return (
        <div className="space-y-3.5">
            <label className="flex cursor-pointer items-start gap-3 text-sm text-[var(--blanc-ink-1)]">
                <input
                    type="radio"
                    name={name}
                    value="company"
                    checked={mode === 'company'}
                    onChange={() => onModeChange('company')}
                    className="mt-0.5 h-4 w-4 accent-[var(--blanc-accent)]"
                />
                <span className="space-y-1">
                    <span className="block font-medium">Same as company settings</span>
                    <span className="block text-xs text-[var(--blanc-ink-3)]">
                        Uses the days, hours, and timezone from Company schedule.
                    </span>
                </span>
            </label>

            <label className="flex cursor-pointer items-start gap-3 text-sm text-[var(--blanc-ink-1)]">
                <input
                    type="radio"
                    name={name}
                    value="custom"
                    checked={mode === 'custom'}
                    onChange={() => onModeChange('custom')}
                    className="mt-0.5 h-4 w-4 accent-[var(--blanc-accent)]"
                />
                <span className="font-medium">Custom schedule</span>
            </label>

            {mode === 'custom' && (
                <div className="ml-7 space-y-3.5">
                    <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                        <FloatingField
                            id={`${name}-start`}
                            type="time"
                            label="Calls start"
                            value={customStart}
                            onChange={event => onCustomStartChange(event.target.value)}
                        />
                        <FloatingField
                            id={`${name}-end`}
                            type="time"
                            label="Calls end"
                            value={customEnd}
                            onChange={event => onCustomEndChange(event.target.value)}
                        />
                    </div>

                    <div className="space-y-3.5">
                        <div className="blanc-eyebrow">CALLING DAYS</div>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                            {DAYS.map(day => {
                                const id = `${name}-day-${day.value}`;
                                return (
                                    <label
                                        key={day.value}
                                        htmlFor={id}
                                        className="flex cursor-pointer items-center gap-2 text-sm text-[var(--blanc-ink-1)]"
                                    >
                                        <Checkbox
                                            id={id}
                                            checked={workDays.includes(day.value)}
                                            onCheckedChange={checked => toggleDay(day.value, checked === true)}
                                        />
                                        {day.label}
                                    </label>
                                );
                            })}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
