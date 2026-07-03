/**
 * DispatchSettingsDialog — Modal for company dispatch settings:
 * timezone, work hours, work days, slot duration.
 */

import React, { useState, useEffect } from 'react';
import {
    Dialog, DialogContent, DialogPanelHeader, DialogBody, DialogPanelFooter, DialogTitle, DialogDescription,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { SelectItem } from '../ui/select';
import { FloatingSelect } from '../ui/floating-select';
import type { DispatchSettings } from '../../services/scheduleApi';

interface DispatchSettingsDialogProps {
    open: boolean;
    onClose: () => void;
    settings: DispatchSettings;
    onSave: (updates: Partial<DispatchSettings>) => Promise<void>;
}

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
const DAY_LABELS: { value: number; label: string; short: string }[] = [
    { value: 0, label: 'Sunday', short: 'Sun' },
    { value: 1, label: 'Monday', short: 'Mon' },
    { value: 2, label: 'Tuesday', short: 'Tue' },
    { value: 3, label: 'Wednesday', short: 'Wed' },
    { value: 4, label: 'Thursday', short: 'Thu' },
    { value: 5, label: 'Friday', short: 'Fri' },
    { value: 6, label: 'Saturday', short: 'Sat' },
];

export const DispatchSettingsDialog: React.FC<DispatchSettingsDialogProps> = ({
    open, onClose, settings, onSave,
}) => {
    const [timezone, setTimezone] = useState(settings.timezone);
    const [workStart, setWorkStart] = useState(settings.work_start_time);
    const [workEnd, setWorkEnd] = useState(settings.work_end_time);
    const [workDays, setWorkDays] = useState<number[]>(settings.work_days);
    const [slotDuration, setSlotDuration] = useState(settings.slot_duration);
    const [distanceUnit, setDistanceUnit] = useState<'mi' | 'km'>(settings.distance_unit || 'mi');
    const [saving, setSaving] = useState(false);
    const [validationError, setValidationError] = useState('');

    useEffect(() => {
        if (open) {
            setTimezone(settings.timezone);
            setWorkStart(settings.work_start_time);
            setWorkEnd(settings.work_end_time);
            setWorkDays(settings.work_days);
            setSlotDuration(settings.slot_duration);
            setDistanceUnit(settings.distance_unit || 'mi');
            setValidationError('');
        }
    }, [open, settings]);

    const toggleDay = (day: number) => {
        setWorkDays(prev =>
            prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day].sort(),
        );
    };

    const handleSave = async () => {
        if (workEnd <= workStart) {
            setValidationError('End time must be after start time');
            return;
        }
        if (workDays.length === 0) {
            setValidationError('Select at least one work day');
            return;
        }
        setValidationError('');
        setSaving(true);
        try {
            await onSave({
                timezone,
                work_start_time: workStart,
                work_end_time: workEnd,
                work_days: workDays,
                slot_duration: slotDuration,
                distance_unit: distanceUnit,
            });
            onClose();
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle
                        className="text-[22px] font-semibold leading-tight"
                        style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                    >
                        Dispatch settings
                    </DialogTitle>
                    <DialogDescription className="sr-only">Company timezone, work hours, work days and slot duration</DialogDescription>
                </DialogPanelHeader>

                <DialogBody className="md:px-8 md:py-7">
                  <div className="mx-auto w-full max-w-[740px] space-y-6">
                    {/* Timezone & distance unit */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                        <FloatingSelect label="Timezone" id="dsd-timezone" value={timezone} onValueChange={setTimezone}>
                            {POPULAR_TIMEZONES.map(tz => (
                                <SelectItem key={tz} value={tz}>{tz.replace(/_/g, ' ')}</SelectItem>
                            ))}
                        </FloatingSelect>

                        {/* Distance unit (SCHED-ROUTE-001 C-13) */}
                        <FloatingSelect label="Distance unit" id="dsd-distance-unit" value={distanceUnit} onValueChange={(v) => setDistanceUnit(v as 'mi' | 'km')}>
                            <SelectItem value="mi">Miles (mi)</SelectItem>
                            <SelectItem value="km">Kilometers (km)</SelectItem>
                        </FloatingSelect>
                    </div>

                    {/* Work hours — native time pickers kept as labeled controls */}
                    <div className="space-y-3.5">
                        <div className="grid grid-cols-2 gap-3.5">
                            <div className="space-y-1.5">
                                <span className="blanc-eyebrow">Work start</span>
                                <Input
                                    type="time"
                                    className="h-[50px] rounded-xl border-[1.5px] bg-transparent text-[15px]"
                                    value={workStart}
                                    onChange={e => setWorkStart(e.target.value)}
                                />
                            </div>
                            <div className="space-y-1.5">
                                <span className="blanc-eyebrow">Work end</span>
                                <Input
                                    type="time"
                                    className="h-[50px] rounded-xl border-[1.5px] bg-transparent text-[15px]"
                                    value={workEnd}
                                    onChange={e => setWorkEnd(e.target.value)}
                                />
                            </div>
                        </div>

                        {/* Work days — day-of-week toggle set kept as labeled control */}
                        <div className="space-y-1.5">
                            <span className="blanc-eyebrow">Work days</span>
                            <div className="flex gap-1">
                                {DAY_LABELS.map(day => (
                                    <button
                                        key={day.value}
                                        type="button"
                                        className={`
                                            flex-1 py-2 text-xs font-medium rounded-md border-[1.5px] transition-colors
                                            ${workDays.includes(day.value)
                                                ? 'border-[var(--blanc-ink-1)] bg-[rgba(25,25,25,0.06)] text-[var(--blanc-ink-1)]'
                                                : 'border-[var(--blanc-line)] bg-transparent text-[var(--blanc-ink-3)] hover:border-[var(--blanc-ink-3)]'
                                            }
                                        `}
                                        onClick={() => toggleDay(day.value)}
                                    >
                                        {day.short}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>

                    {/* Slot duration */}
                    <FloatingSelect label="Slot duration" id="dsd-slot-duration" value={String(slotDuration)} onValueChange={v => setSlotDuration(Number(v))}>
                        {SLOT_DURATIONS.map(d => (
                            <SelectItem key={d} value={String(d)}>{d} min</SelectItem>
                        ))}
                    </FloatingSelect>

                    {/* Validation error */}
                    {validationError && (
                        <p className="text-sm text-red-600">{validationError}</p>
                    )}
                  </div>
                </DialogBody>

                <DialogPanelFooter>
                    <Button variant="ghost" onClick={onClose} disabled={saving}>
                        Cancel
                    </Button>
                    <Button onClick={handleSave} disabled={saving}>
                        {saving ? 'Saving...' : 'Save'}
                    </Button>
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
};
