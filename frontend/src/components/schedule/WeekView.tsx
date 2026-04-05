/**
 * WeekView — 7-column calendar grid with hourly time slots.
 * Timezone-aware: all positioning and labels use company TZ from settings.
 * Supports DnD reschedule (including cross-day) and create-from-slot.
 */

import React, { useMemo, useState, useCallback, useRef } from 'react';
import { startOfWeek, addDays, format } from 'date-fns';
import { ScheduleItemCard } from './ScheduleItemCard';
import { OverflowPopover } from './OverflowPopover';
import { SlotContextMenu } from './SlotContextMenu';
import type { ScheduleItem, DispatchSettings } from '../../services/scheduleApi';
import {
    todayInTZ, dateInTZ, minutesSinceMidnight,
    formatTimeInTZ, dateKeyInTZ,
} from '../../utils/companyTime';
import { serverDate } from '../../utils/serverClock';
import { assignLanes } from '../../utils/scheduleLayout';
import type { LayoutItem } from '../../utils/scheduleLayout';
import { setDragData, getDragData, hasDragData } from '../../hooks/useScheduleDnD';

interface WeekViewProps {
    currentDate: Date;
    items: ScheduleItem[];
    settings: DispatchSettings;
    onSelectItem: (item: ScheduleItem) => void;
    onReschedule?: (entityType: string, entityId: number, startAt: string, endAt: string, title?: string) => void;
    onCreateFromSlot?: (title: string, startAt: string, endAt: string) => void;
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

const HOUR_HEIGHT = 86; // Sprint 7 design refresh
const MAX_VISIBLE_LANES = 2;

export const WeekView: React.FC<WeekViewProps> = ({ currentDate, items, settings, onSelectItem, onReschedule, onCreateFromSlot }) => {
    const tz = settings.timezone || 'America/New_York';
    const slotDuration = settings.slot_duration || 60;
    const [overflowAnchor, setOverflowAnchor] = useState<{ items: ScheduleItem[]; rect: DOMRect } | null>(null);
    const [dropHighlight, setDropHighlight] = useState<{ dayIdx: number; min: number } | null>(null);
    const [slotMenu, setSlotMenu] = useState<{ top: number; left: number; startAt: string; endAt: string } | null>(null);
    const colRefs = useRef<(HTMLDivElement | null)[]>([]);

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

    const todayStr = todayInTZ(tz);
    const isTodayCol = (dayKey: string) => dayKey === todayStr;

    const nowMinFromGrid = minutesSinceMidnight(serverDate(), tz) - startHour * 60;
    const pastHeight = Math.max(0, Math.min(nowMinFromGrid, totalHours * 60)) / 60 * HOUR_HEIGHT;

    const [refY, refM, refD] = dayKeys[0].split('-').map(Number);

    // ── DnD helpers ──────────────────────────────────────────────────────

    const pxToMinutes = useCallback((offsetY: number): number => {
        const rawMin = (offsetY / HOUR_HEIGHT) * 60 + startHour * 60;
        return Math.round(rawMin / slotDuration) * slotDuration;
    }, [startHour, slotDuration]);

    const makeDragOver = useCallback((dayIdx: number) => (e: React.DragEvent) => {
        if (!hasDragData(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const col = colRefs.current[dayIdx];
        if (!col) return;
        const rect = col.getBoundingClientRect();
        setDropHighlight({ dayIdx, min: pxToMinutes(e.clientY - rect.top) });
    }, [pxToMinutes]);

    const makeDrop = useCallback((dayIdx: number) => (e: React.DragEvent) => {
        e.preventDefault();
        setDropHighlight(null);
        const data = getDragData(e);
        if (!data || !onReschedule) return;
        const col = colRefs.current[dayIdx];
        if (!col) return;
        const rect = col.getBoundingClientRect();
        const newStartMin = pxToMinutes(e.clientY - rect.top);
        const newEndMin = newStartMin + data.durationMin;
        const [y, m, d] = dayKeys[dayIdx].split('-').map(Number);
        const startAt = dateInTZ(y, m, d, Math.floor(newStartMin / 60), newStartMin % 60, tz).toISOString();
        const endAt = dateInTZ(y, m, d, Math.floor(newEndMin / 60), newEndMin % 60, tz).toISOString();
        onReschedule(data.entityType, data.entityId, startAt, endAt, data.title);
    }, [onReschedule, pxToMinutes, dayKeys, tz]);

    const handleSlotClick = useCallback((dayIdx: number, e: React.MouseEvent) => {
        if (!onCreateFromSlot) return;
        if ((e.target as HTMLElement).closest('[data-schedule-item]')) return;
        const col = colRefs.current[dayIdx];
        if (!col) return;
        const rect = col.getBoundingClientRect();
        const clickMin = pxToMinutes(e.clientY - rect.top);
        const endMin = clickMin + slotDuration;
        const [y, m, d] = dayKeys[dayIdx].split('-').map(Number);
        const startAt = dateInTZ(y, m, d, Math.floor(clickMin / 60), clickMin % 60, tz).toISOString();
        const endAt = dateInTZ(y, m, d, Math.floor(endMin / 60), endMin % 60, tz).toISOString();
        setSlotMenu({ top: e.clientY, left: e.clientX, startAt, endAt });
    }, [onCreateFromSlot, pxToMinutes, slotDuration, dayKeys, tz]);

    return (
        <div
            className="flex flex-col flex-1 overflow-auto"
            style={{
                background: 'var(--sched-surface)',
                border: '1px solid rgba(255, 255, 255, 0.55)',
                borderRadius: 'var(--sched-radius-xl)',
                boxShadow: 'var(--sched-shadow-main)',
                backdropFilter: 'blur(24px)',
            }}
        >
            {/* Calendar frame with min-width for scrolling */}
            <div style={{ minWidth: '1320px' }}>
            {/* Day headers */}
            <div className="grid sticky top-0 z-10" style={{
                gridTemplateColumns: '92px repeat(7, minmax(150px, 1fr))',
                borderBottom: '1px solid var(--sched-line)',
                background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.66), rgba(244, 237, 226, 0.42))',
            }}>
                {/* Corner cell */}
                <div className="flex items-end p-3 text-[11px] font-semibold uppercase" style={{ minHeight: '104px', borderRight: '1px solid var(--sched-line)', color: 'var(--sched-ink-3)', fontFamily: 'Manrope, sans-serif', letterSpacing: '0.14em' }}>
                    Hour
                </div>
                {days.map((day, i) => {
                    const isToday = isTodayCol(dayKeys[i]);
                    const dayCount = (itemsByDay.get(dayKeys[i]) || []).length;
                    return (
                        <div
                            key={dayKeys[i]}
                            className="flex flex-col justify-start gap-2 p-3"
                            style={{
                                minHeight: '104px',
                                borderRight: '1px solid var(--sched-line)',
                                background: isToday ? 'linear-gradient(180deg, rgba(255, 248, 235, 0.96), rgba(255, 244, 224, 0.76))' : 'transparent',
                            }}
                        >
                            <span className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: 'var(--sched-ink-3)', letterSpacing: '0.14em' }}>
                                {format(day, 'EEE')}
                            </span>
                            <span className="text-[30px] leading-none" style={{ fontFamily: 'Manrope, sans-serif', letterSpacing: '-0.05em', color: 'var(--sched-ink-1)' }}>
                                {format(day, 'd')}
                            </span>
                            {dayCount > 0 && (
                                <span className="inline-flex items-center w-fit min-h-[28px] px-2.5 rounded-full text-[12px] font-semibold" style={{ background: 'rgba(255, 255, 255, 0.6)', color: 'var(--sched-ink-2)' }}>
                                    {dayCount} item{dayCount > 1 ? 's' : ''}
                                </span>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* Time grid */}
            <div className="grid" style={{ gridTemplateColumns: '92px repeat(7, minmax(150px, 1fr))' }}>
                {/* Time labels */}
                <div className="relative" style={{
                    borderRight: '1px solid var(--sched-line)',
                    background: `linear-gradient(180deg, rgba(255, 255, 255, 0.52), rgba(242, 235, 223, 0.62)), repeating-linear-gradient(to bottom, transparent 0 ${HOUR_HEIGHT - 1}px, rgba(118, 106, 89, 0.14) ${HOUR_HEIGHT - 1}px ${HOUR_HEIGHT}px)`,
                }}>
                    {hourSlots.map(h => (
                        <div key={h} className="flex justify-end pr-3 pt-2 text-sm" style={{ height: `${HOUR_HEIGHT}px`, color: 'var(--sched-ink-1)' }}>
                            {formatTimeInTZ(dateInTZ(refY, refM, refD, h, 0, tz), tz)}
                        </div>
                    ))}
                </div>

                {/* Day columns */}
                {days.map((_day, i) => {
                    const key = dayKeys[i];
                    const dayItems = itemsByDay.get(key) || [];
                    const isToday = isTodayCol(key);

                    return (
                        <div
                            key={key}
                            ref={el => { colRefs.current[i] = el; }}
                            className="relative"
                            style={{
                                borderRight: '1px solid var(--sched-line)',
                                background: isToday
                                    ? `linear-gradient(180deg, rgba(255, 249, 237, 0.88), rgba(255, 249, 237, 0.58)), repeating-linear-gradient(to bottom, transparent 0 ${HOUR_HEIGHT - 1}px, rgba(118, 106, 89, 0.14) ${HOUR_HEIGHT - 1}px ${HOUR_HEIGHT}px)`
                                    : `linear-gradient(180deg, rgba(255, 255, 255, 0.38), rgba(255, 255, 255, 0.06)), repeating-linear-gradient(to bottom, transparent 0 ${HOUR_HEIGHT - 1}px, rgba(118, 106, 89, 0.14) ${HOUR_HEIGHT - 1}px ${HOUR_HEIGHT}px)`,
                            }}
                            onDragOver={makeDragOver(i)}
                            onDrop={makeDrop(i)}
                            onDragLeave={() => setDropHighlight(null)}
                            onClick={(e) => handleSlotClick(i, e)}
                        >
                            {/* Slot spacers for height */}
                            {hourSlots.map(h => (
                                <div key={h} style={{ height: `${HOUR_HEIGHT}px` }} />
                            ))}

                            {/* Past-time overlay + now-line (today only) */}
                            {isToday && pastHeight > 0 && (
                                <>
                                    <div
                                        className="absolute top-0 left-0 right-0 pointer-events-none z-[1]"
                                        style={{
                                            height: Math.min(pastHeight, totalHeight),
                                            background: 'rgba(58, 48, 39, 0.06)',
                                        }}
                                    />
                                    {pastHeight < totalHeight && (
                                        <div
                                            className="absolute left-0 right-0 z-[6] pointer-events-none"
                                            style={{ top: pastHeight, borderTop: '2px solid var(--sched-danger)' }}
                                        />
                                    )}
                                </>
                            )}

                            {/* Drop highlight */}
                            {dropHighlight && dropHighlight.dayIdx === i && (
                                <div
                                    className="absolute left-1 right-1 border-2 border-dashed rounded pointer-events-none z-[5]"
                                    style={{
                                        top: ((dropHighlight.min - startHour * 60) / 60) * HOUR_HEIGHT,
                                        height: (slotDuration / 60) * HOUR_HEIGHT,
                                        background: 'rgba(47, 99, 216, 0.1)',
                                        borderColor: 'var(--sched-job)',
                                    }}
                                />
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

                                const visible: typeof layoutItems = [];
                                const overflowByCluster = new Map<string, { items: ScheduleItem[]; topPx: number; heightPx: number }>();

                                for (const li of layoutItems) {
                                    const layout = lanes.get(li.key);
                                    const lane = layout?.lane ?? 0;
                                    const totalLanes = layout?.totalLanes ?? 1;

                                    if (totalLanes <= MAX_VISIBLE_LANES || lane < MAX_VISIBLE_LANES) {
                                        visible.push(li);
                                    } else {
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

                                return (
                                    <>
                                        {visible.map(({ key: itemKey, item, itemMin, durationMin }) => {
                                            const topPx = ((itemMin - startHour * 60) / 60) * HOUR_HEIGHT;
                                            const heightPx = (durationMin / 60) * HOUR_HEIGHT;
                                            const layout = lanes.get(itemKey);
                                            const lane = layout?.lane ?? 0;
                                            const totalLanes = Math.min(layout?.totalLanes ?? 1, MAX_VISIBLE_LANES);
                                            const widthPct = 100 / totalLanes;
                                            const leftPct = lane * widthPct;
                                            const isDraggable = item.entity_type !== 'lead';

                                            return (
                                                <div
                                                    key={itemKey}
                                                    data-schedule-item
                                                    className={`absolute z-10 ${isDraggable ? 'cursor-grab active:cursor-grabbing' : ''}`}
                                                    draggable={isDraggable}
                                                    onDragStart={isDraggable ? (e) => {
                                                        setDragData(e, item, durationMin);
                                                        (e.target as HTMLElement).style.opacity = '0.5';
                                                    } : undefined}
                                                    onDragEnd={(e) => {
                                                        (e.target as HTMLElement).style.opacity = '1';
                                                        setDropHighlight(null);
                                                    }}
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
                                        {Array.from(overflowByCluster.entries()).map(([clusterKey, cluster]) => (
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
                                        ))}
                                    </>
                                );
                            })()}
                        </div>
                    );
                })}
            </div>
            </div>{/* end calendar frame min-width wrapper */}

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

            {/* Slot context menu */}
            {slotMenu && onCreateFromSlot && (
                <SlotContextMenu
                    anchorRect={{ top: slotMenu.top, left: slotMenu.left }}
                    startAt={slotMenu.startAt}
                    endAt={slotMenu.endAt}
                    timezone={tz}
                    onCreateJob={(title) => onCreateFromSlot(title, slotMenu.startAt, slotMenu.endAt)}
                    onClose={() => setSlotMenu(null)}
                />
            )}
        </div>
    );
};
