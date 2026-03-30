/**
 * WeekView — 7-column calendar grid with hourly time slots.
 * Timezone-aware: all positioning and labels use company TZ from settings.
 */

import React, { useMemo } from 'react';
import { startOfWeek, addDays, format } from 'date-fns';
import { ScheduleItemCard } from './ScheduleItemCard';
import type { ScheduleItem, DispatchSettings } from '../../services/scheduleApi';
import {
    todayInTZ, dateInTZ, minutesSinceMidnight,
    formatTimeInTZ, dateKeyInTZ,
} from '../../utils/companyTime';

interface WeekViewProps {
    currentDate: Date;
    items: ScheduleItem[];
    settings: DispatchSettings;
    onSelectItem: (item: ScheduleItem) => void;
}

function parseTime(t: string): number {
    const [h, m] = t.split(':').map(Number);
    return h + (m || 0) / 60;
}

function buildHourSlots(startTime: string, endTime: string): number[] {
    const start = Math.floor(parseTime(startTime));
    const end = Math.ceil(parseTime(endTime));
    const hours: number[] = [];
    for (let h = start; h < end; h++) hours.push(h);
    return hours;
}

const HOUR_HEIGHT = 64; // px per hour (h-16 = 64px)

export const WeekView: React.FC<WeekViewProps> = ({ currentDate, items, settings, onSelectItem }) => {
    const tz = settings.timezone || 'America/New_York';
    const weekStart = startOfWeek(currentDate, { weekStartsOn: 0 });
    const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
    const dayKeys = useMemo(() => days.map(d => format(d, 'yyyy-MM-dd')), [days]);

    const startHour = parseTime(settings.work_start_time);
    const endHour = parseTime(settings.work_end_time);
    const totalHours = endHour - startHour;
    const totalHeight = totalHours * HOUR_HEIGHT;

    const hourSlots = useMemo(
        () => buildHourSlots(settings.work_start_time, settings.work_end_time),
        [settings.work_start_time, settings.work_end_time],
    );

    // Group items by day (using company TZ)
    const itemsByDay = useMemo(() => {
        const map = new Map<string, ScheduleItem[]>();
        for (const key of dayKeys) map.set(key, []);
        for (const item of items) {
            if (!item.start_at) continue;
            const key = dateKeyInTZ(item.start_at, tz);
            map.get(key)?.push(item);
        }
        return map;
    }, [items, dayKeys, tz]);

    // Today in company TZ
    const todayStr = todayInTZ(tz);
    const isTodayCol = (dayKey: string) => dayKey === todayStr;

    // Past-time overlay calculation (only for today column)
    const nowMinFromGrid = minutesSinceMidnight(new Date(), tz) - startHour * 60;
    const pastHeight = Math.max(0, Math.min(nowMinFromGrid, totalHours * 60)) / 60 * HOUR_HEIGHT;

    // For hour labels we need year/month/day from first visible day
    const [refY, refM, refD] = dayKeys[0].split('-').map(Number);

    return (
        <div className="flex flex-col flex-1 overflow-auto">
            {/* Day headers */}
            <div className="flex border-b sticky top-0 bg-white z-10">
                <div className="w-16 flex-shrink-0 border-r" /> {/* gutter */}
                {days.map((day, i) => (
                    <div
                        key={dayKeys[i]}
                        className={`flex-1 text-center py-2 border-r text-sm font-medium ${isTodayCol(dayKeys[i]) ? 'bg-blue-50 text-blue-700' : 'text-gray-600'}`}
                    >
                        <div className="text-xs uppercase">{format(day, 'EEE')}</div>
                        <div className={`text-lg ${isTodayCol(dayKeys[i]) ? 'font-bold' : ''}`}>{format(day, 'd')}</div>
                    </div>
                ))}
            </div>

            {/* Time grid */}
            <div className="flex flex-1 relative">
                {/* Time labels */}
                <div className="w-16 flex-shrink-0 border-r">
                    {hourSlots.map(h => (
                        <div key={h} className="h-16 border-b text-xs text-gray-400 pr-2 text-right pt-0.5">
                            {formatTimeInTZ(dateInTZ(refY, refM, refD, h, 0, tz), tz)}
                        </div>
                    ))}
                </div>

                {/* Day columns */}
                {days.map((day, i) => {
                    const key = dayKeys[i];
                    const dayItems = itemsByDay.get(key) || [];
                    const isToday = isTodayCol(key);

                    return (
                        <div key={key} className={`flex-1 border-r relative ${isToday ? 'bg-blue-50/30' : ''}`}>
                            {/* Slot lines */}
                            {hourSlots.map(h => (
                                <div key={h} className="h-16 border-b border-gray-100" />
                            ))}

                            {/* Past-time overlay + now-line (today only) */}
                            {isToday && pastHeight > 0 && (
                                <>
                                    <div
                                        className="absolute top-0 left-0 right-0 pointer-events-none z-[1]"
                                        style={{
                                            height: Math.min(pastHeight, totalHeight),
                                            background: 'rgba(128, 128, 128, 0.18)',
                                        }}
                                    />
                                    {pastHeight < totalHeight && (
                                        <div
                                            className="absolute left-0 right-0 border-t-2 border-red-500 z-[6] pointer-events-none"
                                            style={{ top: pastHeight }}
                                        />
                                    )}
                                </>
                            )}

                            {/* Positioned items */}
                            {dayItems.map(item => {
                                if (!item.start_at) return null;
                                const itemMin = minutesSinceMidnight(new Date(item.start_at), tz);
                                const topPx = ((itemMin - startHour * 60) / 60) * HOUR_HEIGHT;
                                const topPct = (topPx / totalHeight) * 100;

                                let durationMin = 60;
                                if (item.end_at) {
                                    const endMin = minutesSinceMidnight(new Date(item.end_at), tz);
                                    durationMin = endMin - itemMin;
                                    if (durationMin <= 0) durationMin = 60;
                                }
                                const heightPct = ((durationMin / 60) / totalHours) * 100;

                                return (
                                    <div
                                        key={`${item.entity_type}-${item.entity_id}`}
                                        className="absolute left-0.5 right-0.5 z-10"
                                        style={{
                                            top: `${topPct}%`,
                                            height: `${Math.max(heightPct, 2)}%`,
                                            minHeight: '28px',
                                        }}
                                    >
                                        <ScheduleItemCard item={item} compact onClick={onSelectItem} timezone={tz} />
                                    </div>
                                );
                            })}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
