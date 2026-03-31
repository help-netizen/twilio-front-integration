/**
 * DispatchSettingsDialog — Modal for company dispatch settings:
 * timezone, work hours, work days, slot duration.
 */

import React, { useState, useEffect } from 'react';
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { Input } from '../ui/input';
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../ui/select';
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
const BUFFER_OPTIONS = [0, 15, 30, 60];

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
    const [saving, setSaving] = useState(false);
    const [validationError, setValidationError] = useState('');

    useEffect(() => {
        if (open) {
            setTimezone(settings.timezone);
            setWorkStart(settings.work_start_time);
            setWorkEnd(settings.work_end_time);
            setWorkDays(settings.work_days);
            setSlotDuration(settings.slot_duration);
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
            });
            onClose();
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Dispatch Settings</DialogTitle>
                </DialogHeader>

                <div className="space-y-4 py-2">
                    {/* Timezone */}
                    <div className="space-y-1.5">
                        <Label className="text-sm font-medium">Timezone</Label>
                        <Select value={timezone} onValueChange={setTimezone}>
                            <SelectTrigger className="h-9 text-sm">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {POPULAR_TIMEZONES.map(tz => (
                                    <SelectItem key={tz} value={tz}>{tz.replace(/_/g, ' ')}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    {/* Work Hours */}
                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                            <Label className="text-sm font-medium">Work Start</Label>
                            <Input
                                type="time"
                                className="h-9 text-sm"
                                value={workStart}
                                onChange={e => setWorkStart(e.target.value)}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label className="text-sm font-medium">Work End</Label>
                            <Input
                                type="time"
                                className="h-9 text-sm"
                                value={workEnd}
                                onChange={e => setWorkEnd(e.target.value)}
                            />
                        </div>
                    </div>

                    {/* Work Days */}
                    <div className="space-y-1.5">
                        <Label className="text-sm font-medium">Work Days</Label>
                        <div className="flex gap-1">
                            {DAY_LABELS.map(day => (
                                <button
                                    key={day.value}
                                    type="button"
                                    className={`
                                        flex-1 py-1.5 text-xs font-medium rounded-md border transition-colors
                                        ${workDays.includes(day.value)
                                            ? 'bg-blue-600 text-white border-blue-600'
                                            : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
                                        }
                                    `}
                                    onClick={() => toggleDay(day.value)}
                                >
                                    {day.short}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Slot Duration */}
                    <div className="space-y-1.5">
                        <Label className="text-sm font-medium">Slot Duration</Label>
                        <Select value={String(slotDuration)} onValueChange={v => setSlotDuration(Number(v))}>
                            <SelectTrigger className="h-9 text-sm">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {SLOT_DURATIONS.map(d => (
                                    <SelectItem key={d} value={String(d)}>{d} min</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    {/* Validation error */}
                    {validationError && (
                        <p className="text-sm text-red-600">{validationError}</p>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
                        Cancel
                    </Button>
                    <Button size="sm" onClick={handleSave} disabled={saving}>
                        {saving ? 'Saving...' : 'Save'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
