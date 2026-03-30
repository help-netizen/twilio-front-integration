/**
 * DayView — Single column with hourly time slots.
 * Timezone-aware: all positioning and labels use company TZ from settings.
 */

import React, { useMemo } from 'react';
import { format } from 'date-fns';
import { ScheduleItemCard } from './ScheduleItemCard';
import type { ScheduleItem, DispatchSettings } from '../../services/scheduleApi';
import {
    todayInTZ, dateInTZ, minutesSinceMidnight,
    formatTimeInTZ, dateKeyInTZ,
} from '../../utils/companyTime';
import { assignLanes } from '../../utils/scheduleLayout';
import type { LayoutItem } from '../../utils/scheduleLayout';

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

function buildHourSlots(startTime: string, endTime: string): number[] {
    const start = Math.floor(parseTime(startTime));
    const end = Math.ceil(parseTime(endTime));
    const hours: number[] = [];
    for (let h = start; h < end; h++) hours.push(h);
    return hours;
}

const HOUR_HEIGHT = 80; // px per hour (h-20 = 80px)

export const DayView: React.FC<DayViewProps> = ({ currentDate, items, settings, onSelectItem }) => {
    const tz = settings.timezone || 'America/New_York';
    const startHour = parseTime(settings.work_start_time);
    const endHour = parseTime(settings.work_end_time);
    const totalHours = endHour - startHour;
    const totalHeight = totalHours * HOUR_HEIGHT;

    const hourSlots = useMemo(
        () => buildHourSlots(settings.work_start_time, settings.work_end_time),
        [settings.work_start_time, settings.work_end_time],
    );

    // Current date key in company TZ
    const dateKey = format(currentDate, 'yyyy-MM-dd');

    // Filter items for this day (using company TZ)
    const dayItems = useMemo(
        () => items.filter(i => i.start_at && dateKeyInTZ(i.start_at, tz) === dateKey),
        [items, dateKey, tz],
    );

    // Today detection in company TZ
    const todayStr = todayInTZ(tz);
    const isToday = dateKey === todayStr;

    // Past-time overlay + now-line
    const nowMinFromGrid = isToday
        ? minutesSinceMidnight(new Date(), tz) - startHour * 60
        : 0;
    const pastHeight = isToday
        ? Math.max(0, Math.min(nowMinFromGrid, totalHours * 60)) / 60 * HOUR_HEIGHT
        : 0;

    // Hour labels in company TZ (using an arbitrary date to format)
    const [dy, dm, dd] = dateKey.split('-').map(Number);

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
                <div className="w-16 flex-shrink-0 border-r relative">
                    {hourSlots.map(h => (
                        <div key={h} className="h-20 border-b text-xs text-gray-400 pr-2 text-right pt-0.5">
                            {formatTimeInTZ(dateInTZ(dy, dm, dd, h, 0, tz), tz)}
                        </div>
                    ))}
                    {/* Now line on label column */}
                    {isToday && pastHeight > 0 && pastHeight < totalHeight && (
                        <div
                            className="absolute left-0 right-0 border-t-2 border-red-500 z-20 pointer-events-none"
                            style={{ top: pastHeight }}
                        />
                    )}
                </div>

                {/* Day column */}
                <div className={`flex-1 relative ${isToday ? 'bg-blue-50/30' : ''}`}>
                    {/* Slot lines */}
                    {hourSlots.map(h => (
                        <div key={h} className="h-20 border-b border-gray-100" />
                    ))}

                    {/* Past-time overlay + now-line */}
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

                    {/* Positioned items with collision lanes */}
                    {(() => {
                        const layoutItems: (LayoutItem & { item: ScheduleItem; itemMin: number; durationMin: number })[] = [];
                        for (const item of dayItems) {
                            if (!item.start_at) continue;
                            const itemMin = minutesSinceMidnight(new Date(item.start_at), tz);
                            let durationMin = 60;
                            if (item.end_at) {
                                const endMin = minutesSinceMidnight(new Date(item.end_at), tz);
                                durationMin = endMin - itemMin;
                                if (durationMin <= 0) durationMin = 60;
                            }
                            layoutItems.push({
                                key: `${item.entity_type}-${item.entity_id}`,
                                startMin: itemMin,
                                endMin: itemMin + durationMin,
                                item,
                                itemMin,
                                durationMin,
                            });
                        }
                        const lanes = assignLanes(layoutItems);

                        return layoutItems.map(({ key, item, itemMin, durationMin }) => {
                            const topPx = ((itemMin - startHour * 60) / 60) * HOUR_HEIGHT;
                            const heightPx = (durationMin / 60) * HOUR_HEIGHT;
                            const layout = lanes.get(key);
                            const lane = layout?.lane ?? 0;
                            const totalLanes = layout?.totalLanes ?? 1;
                            const widthPct = 100 / totalLanes;
                            const leftPct = lane * widthPct;

                            return (
                                <div
                                    key={key}
                                    className="absolute z-10"
                                    style={{
                                        top: topPx,
                                        height: Math.max(heightPx, 32),
                                        left: `calc(${leftPct}% + 4px)`,
                                        width: `calc(${widthPct}% - 8px)`,
                                    }}
                                >
                                    <ScheduleItemCard item={item} onClick={onSelectItem} timezone={tz} />
                                </div>
                            );
                        });
                    })()}
                </div>
            </div>
        </div>
    );
};
