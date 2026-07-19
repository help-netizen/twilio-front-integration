import { useEffect, useState, type FormEvent } from 'react';
import type { DispatchSettings } from '../../services/scheduleApi';
import { Button } from '../ui/button';
import { FloatingField } from '../ui/floating-field';
import { FloatingSelect } from '../ui/floating-select';
import { SelectItem } from '../ui/select';
import { dispatchSettingsValidationError } from './dispatchSettingsModel';

const POPULAR_TIMEZONES = [
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'America/Phoenix',
    'America/Anchorage',
    'Pacific/Honolulu',
    'America/Toronto',
    'America/Vancouver',
    'Europe/London',
    'Europe/Paris',
    'Europe/Berlin',
    'Asia/Tokyo',
    'Australia/Sydney',
];

const SLOT_DURATIONS = [15, 30, 45, 60, 90, 120];
const DAY_LABELS = [
    { value: 0, short: 'Sun' },
    { value: 1, short: 'Mon' },
    { value: 2, short: 'Tue' },
    { value: 3, short: 'Wed' },
    { value: 4, short: 'Thu' },
    { value: 5, short: 'Fri' },
    { value: 6, short: 'Sat' },
] as const;

interface DispatchSettingsFormProps {
    settings: DispatchSettings;
    onSave: (updates: Partial<DispatchSettings>) => Promise<unknown>;
    onSaved?: () => void;
    onCancel?: () => void;
    idPrefix?: string;
}

/** Form extracted from the former Schedule dispatch-settings panel. */
export function DispatchSettingsForm({
    settings,
    onSave,
    onSaved,
    onCancel,
    idPrefix = 'company-schedule',
}: DispatchSettingsFormProps) {
    const [form, setForm] = useState<DispatchSettings>(settings);
    const [saving, setSaving] = useState(false);
    const [validationError, setValidationError] = useState('');

    useEffect(() => {
        setForm({ ...settings, distance_unit: settings.distance_unit || 'mi' });
        setValidationError('');
    }, [settings]);

    const toggleDay = (day: number) => {
        setForm(current => ({
            ...current,
            work_days: current.work_days.includes(day)
                ? current.work_days.filter(value => value !== day)
                : [...current.work_days, day].sort(),
        }));
    };

    const handleSubmit = async (event: FormEvent) => {
        event.preventDefault();
        const error = dispatchSettingsValidationError(form);
        if (error) {
            setValidationError(error);
            return;
        }
        setValidationError('');
        setSaving(true);
        try {
            await onSave(form);
            onSaved?.();
        } catch {
            // The owning page/dialog reports the request error.
        } finally {
            setSaving(false);
        }
    };

    return (
        <form onSubmit={handleSubmit} className="space-y-6">
            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                <FloatingSelect
                    label="Timezone"
                    id={`${idPrefix}-timezone`}
                    value={form.timezone}
                    onValueChange={timezone => setForm(current => ({ ...current, timezone }))}
                >
                    {POPULAR_TIMEZONES.map(timezone => (
                        <SelectItem key={timezone} value={timezone}>{timezone.replace(/_/g, ' ')}</SelectItem>
                    ))}
                </FloatingSelect>

                <FloatingSelect
                    label="Distance unit"
                    id={`${idPrefix}-distance-unit`}
                    value={form.distance_unit || 'mi'}
                    onValueChange={distance_unit => setForm(current => ({
                        ...current,
                        distance_unit: distance_unit as 'mi' | 'km',
                    }))}
                >
                    <SelectItem value="mi">Miles (mi)</SelectItem>
                    <SelectItem value="km">Kilometers (km)</SelectItem>
                </FloatingSelect>
            </div>

            <div className="space-y-3.5">
                <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                    <FloatingField
                        label="Work start"
                        type="time"
                        value={form.work_start_time}
                        onChange={event => setForm(current => ({ ...current, work_start_time: event.target.value }))}
                    />
                    <FloatingField
                        label="Work end"
                        type="time"
                        value={form.work_end_time}
                        onChange={event => setForm(current => ({ ...current, work_end_time: event.target.value }))}
                    />
                </div>

                <div className="space-y-1.5">
                    <span className="blanc-eyebrow">Work days</span>
                    <div className="flex gap-1">
                        {DAY_LABELS.map(day => {
                            const selected = form.work_days.includes(day.value);
                            return (
                                <button
                                    key={day.value}
                                    type="button"
                                    aria-pressed={selected}
                                    className={`flex-1 rounded-md border-[1.5px] py-2 text-xs font-medium transition-colors ${selected
                                        ? 'border-[var(--blanc-ink-1)] text-[var(--blanc-ink-1)]'
                                        : 'border-[var(--blanc-line)] bg-transparent text-[var(--blanc-ink-3)] hover:border-[var(--blanc-ink-3)]'
                                    }`}
                                    style={selected ? { background: 'var(--blanc-field)' } : undefined}
                                    onClick={() => toggleDay(day.value)}
                                >
                                    {day.short}
                                </button>
                            );
                        })}
                    </div>
                </div>
            </div>

            <FloatingSelect
                label="Slot duration"
                id={`${idPrefix}-slot-duration`}
                value={String(form.slot_duration)}
                onValueChange={slot_duration => setForm(current => ({ ...current, slot_duration: Number(slot_duration) }))}
            >
                {SLOT_DURATIONS.map(duration => (
                    <SelectItem key={duration} value={String(duration)}>{duration} min</SelectItem>
                ))}
            </FloatingSelect>

            {validationError && <p className="text-sm text-[var(--blanc-danger)]">{validationError}</p>}

            <div className="flex items-center justify-end gap-3">
                {onCancel && <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>}
                <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
            </div>
        </form>
    );
}
