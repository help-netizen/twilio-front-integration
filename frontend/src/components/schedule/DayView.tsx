/**
 * DayView — Single column with hourly time slots.
 */

import React, { useMemo } from 'react';
import { format, parseISO, isSameDay, getHours, getMinutes } from 'date-fns';
import { ScheduleItemCard } from './ScheduleItemCard';
import type { ScheduleItem, DispatchSettings } from '../../services/scheduleApi';

interface DayViewProps {
    currentDate: Date;
    items: ScheduleItem[];
    settings: DispatchSettings;
    onSelectItem: (item: ScheduleItem) => void;
}

function parseTime(t: string): number {
    const [h, m] = t.split(':').map(Number);
    return h + (m || 0) / 60;
}

function buildTimeSlots(startTime: string, endTime: string, slotMinutes: number): string[] {
    const start = parseTime(startTime);
    const end = parseTime(endTime);
    const slots: string[] = [];
    for (let h = start; h < end; h += slotMinutes / 60) {
        const hh = Math.floor(h);
        const mm = Math.round((h - hh) * 60);
        slots.push(`${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
    }
    return slots;
}

export const DayView: React.FC<DayViewProps> = ({ currentDate, items, settings, onSelectItem }) => {
    const timeSlots = useMemo(
        () => buildTimeSlots(settings.work_start_time, settings.work_end_time, settings.slot_duration),
        [settings],
    );

    const startHour = parseTime(settings.work_start_time);
    const endHour = parseTime(settings.work_end_time);
    const totalHours = endHour - startHour;

    const dayItems = useMemo(
        () => items.filter(i => i.start_at && isSameDay(parseISO(i.start_at), currentDate)),
        [items, currentDate],
    );

    const isToday = isSameDay(currentDate, new Date());

    return (
        <div className="flex flex-col flex-1 overflow-auto">
            {/* Header */}
            <div className="flex border-b sticky top-0 bg-white z-10">
                <div className="w-16 flex-shrink-0 border-r" />
                <div className={`flex-1 text-center py-2 text-sm font-medium ${isToday ? 'bg-blue-50 text-blue-700' : 'text-gray-600'}`}>
                    <div className="text-xs uppercase">{format(currentDate, 'EEEE')}</div>
                    <div className={`text-lg ${isToday ? 'font-bold' : ''}`}>{format(currentDate, 'MMM d, yyyy')}</div>
                </div>
            </div>

            {/* Time grid */}
            <div className="flex flex-1 relative">
                {/* Time labels */}
                <div className="w-16 flex-shrink-0 border-r">
                    {timeSlots.map(slot => (
                        <div key={slot} className="h-20 border-b text-xs text-gray-400 pr-2 text-right pt-0.5">
                            {format(parseISO(`2000-01-01T${slot}`), 'h a')}
                        </div>
                    ))}
                </div>

                {/* Day column */}
                <div className={`flex-1 relative ${isToday ? 'bg-blue-50/30' : ''}`}>
                    {/* Slot lines */}
                    {timeSlots.map(slot => (
                        <div key={slot} className="h-20 border-b border-gray-100" />
                    ))}

                    {/* Positioned items */}
                    {dayItems.map(item => {
                        if (!item.start_at) return null;
                        const parsed = parseISO(item.start_at);
                        const itemHour = getHours(parsed) + getMinutes(parsed) / 60;
                        const topPct = ((itemHour - startHour) / totalHours) * 100;

                        let durationHours = 1;
                        if (item.end_at) {
                            const endParsed = parseISO(item.end_at);
                            durationHours = (getHours(endParsed) + getMinutes(endParsed) / 60) - itemHour;
                        }
                        const heightPct = (durationHours / totalHours) * 100;

                        return (
                            <div
                                key={`${item.entity_type}-${item.entity_id}`}
                                className="absolute left-1 right-1 z-10"
                                style={{
                                    top: `${topPct}%`,
                                    height: `${Math.max(heightPct, 2)}%`,
                                    minHeight: '36px',
                                }}
                            >
                                <ScheduleItemCard item={item} onClick={onSelectItem} />
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
};
