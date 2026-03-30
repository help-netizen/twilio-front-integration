/**
 * WeekView — 7-column calendar grid with hourly time slots.
 * Timezone-aware: all positioning and labels use company TZ from settings.
 */

import React, { useMemo, useState } from 'react';
import { startOfWeek, addDays, format } from 'date-fns';
import { ScheduleItemCard } from './ScheduleItemCard';
import { OverflowPopover } from './OverflowPopover';
import type { ScheduleItem, DispatchSettings } from '../../services/scheduleApi';
import {
    todayInTZ, dateInTZ, minutesSinceMidnight,
    formatTimeInTZ, dateKeyInTZ,
} from '../../utils/companyTime';
import { assignLanes } from '../../utils/scheduleLayout';
import type { LayoutItem } from '../../utils/scheduleLayout';

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

const MAX_VISIBLE_LANES = 2;

export const WeekView: React.FC<WeekViewProps> = ({ currentDate, items, settings, onSelectItem }) => {
    const tz = settings.timezone || 'America/New_York';
    const [overflowAnchor, setOverflowAnchor] = useState<{ items: ScheduleItem[]; rect: DOMRect } | null>(null);
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
                <div className="w-20 flex-shrink-0 border-r" /> {/* gutter */}
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
                <div className="w-20 flex-shrink-0 border-r">
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

                            {/* Positioned items with collision lanes (capped at MAX_VISIBLE_LANES) */}
                            {(() => {
                                // Build layout items for lane assignment
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

                                // Separate visible items (lane < MAX) from overflow (lane >= MAX)
                                const visible: typeof layoutItems = [];
                                const overflowByCluster = new Map<string, { items: ScheduleItem[]; topPx: number; heightPx: number }>();

                                for (const li of layoutItems) {
                                    const layout = lanes.get(li.key);
                                    const lane = layout?.lane ?? 0;
                                    const totalLanes = layout?.totalLanes ?? 1;

                                    if (totalLanes <= MAX_VISIBLE_LANES || lane < MAX_VISIBLE_LANES) {
                                        visible.push(li);
                                    } else {
                                        // Group overflow by approximate time cluster
                                        const clusterKey = `${Math.floor(li.itemMin / 60)}`;
                                        const existing = overflowByCluster.get(clusterKey);
                                        const topPx = ((li.itemMin - startHour * 60) / 60) * HOUR_HEIGHT;
                                        const heightPx = (li.durationMin / 60) * HOUR_HEIGHT;
                                        if (existing) {
                                            existing.items.push(li.item);
                                            existing.topPx = Math.min(existing.topPx, topPx);
                                            existing.heightPx = Math.max(existing.heightPx, topPx + heightPx) - existing.topPx;
                                        } else {
                                            overflowByCluster.set(clusterKey, { items: [li.item], topPx, heightPx: Math.max(heightPx, 32) });
                                        }
                                    }
                                }

                                const visibleLanes = Math.min(
                                    Math.max(...layoutItems.map(li => (lanes.get(li.key)?.totalLanes ?? 1)), 1),
                                    MAX_VISIBLE_LANES,
                                );

                                return (
                                    <>
                                        {visible.map(({ key, item, itemMin, durationMin }) => {
                                            const topPx = ((itemMin - startHour * 60) / 60) * HOUR_HEIGHT;
                                            const heightPx = (durationMin / 60) * HOUR_HEIGHT;
                                            const layout = lanes.get(key);
                                            const lane = layout?.lane ?? 0;
                                            const totalLanes = Math.min(layout?.totalLanes ?? 1, MAX_VISIBLE_LANES);
                                            const widthPct = 100 / totalLanes;
                                            const leftPct = lane * widthPct;

                                            return (
                                                <div
                                                    key={key}
                                                    className="absolute z-10"
                                                    style={{
                                                        top: topPx,
                                                        height: Math.max(heightPx, 32),
                                                        left: `calc(${leftPct}% + 2px)`,
                                                        width: `calc(${widthPct}% - 4px)`,
                                                    }}
                                                >
                                                    <ScheduleItemCard item={item} compact onClick={onSelectItem} timezone={tz} />
                                                </div>
                                            );
                                        })}
                                        {/* Overflow "+N" badges */}
                                        {Array.from(overflowByCluster.entries()).map(([clusterKey, cluster]) => {
                                            const leftPct = ((MAX_VISIBLE_LANES - 1) / visibleLanes) * 100;
                                            return (
                                                <button
                                                    key={`overflow-${clusterKey}`}
                                                    type="button"
                                                    className="absolute z-20 bg-gray-600 text-white text-[10px] rounded-full px-1.5 py-0.5 hover:bg-gray-700 cursor-pointer focus-visible:ring-2 focus-visible:ring-blue-500 outline-none"
                                                    style={{
                                                        top: cluster.topPx + 2,
                                                        right: 4,
                                                    }}
                                                    onClick={(e) => {
                                                        const rect = (e.target as HTMLElement).getBoundingClientRect();
                                                        setOverflowAnchor({ items: cluster.items, rect });
                                                    }}
                                                >
                                                    +{cluster.items.length}
                                                </button>
                                            );
                                        })}
                                    </>
                                );
                            })()}
                        </div>
                    );
                })}
            </div>

            {/* Overflow popover */}
            {overflowAnchor && (
                <OverflowPopover
                    items={overflowAnchor.items}
                    anchorRect={overflowAnchor.rect}
                    onSelectItem={(item) => { setOverflowAnchor(null); onSelectItem(item); }}
                    onClose={() => setOverflowAnchor(null)}
                    timezone={tz}
                />
            )}
        </div>
    );
};
