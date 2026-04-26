/**
 * DayView — Single column with hourly time slots.
 * Timezone-aware: all positioning and labels use company TZ from settings.
 * Supports DnD reschedule and create-from-slot.
 */

import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { format } from 'date-fns';
import { ScheduleItemCard } from './ScheduleItemCard';
import { NewJobPlaceholder, NEW_JOB_DEFAULT_DURATION_MIN } from './NewJobPlaceholder';
import type { ScheduleItem, DispatchSettings } from '../../services/scheduleApi';
import {
    todayInTZ, dateInTZ, minutesSinceMidnight,
    formatTimeInTZ, dateKeyInTZ,
} from '../../utils/companyTime';
import { serverDate } from '../../utils/serverClock';
import { assignLanes } from '../../utils/scheduleLayout';
import type { LayoutItem } from '../../utils/scheduleLayout';
import { setDragData, getDragData, hasDragData } from '../../hooks/useScheduleDnD';

interface DayViewProps {
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

const HOUR_HEIGHT = 86; // px per hour — Sprint 7 design refresh

export const DayView: React.FC<DayViewProps> = ({ currentDate, items, settings, onSelectItem, onReschedule, onCreateFromSlot }) => {
    const tz = settings.timezone || 'America/New_York';
    const slotDuration = settings.slot_duration || 60;
    const [dropHighlightMin, setDropHighlightMin] = useState<number | null>(null);
    const [slotPlaceholder, setSlotPlaceholder] = useState<{
        startMin: number; endMin: number; startAt: string; endAt: string;
    } | null>(null);
    const gridRef = useRef<HTMLDivElement>(null);
    const placeholderRef = useRef<HTMLDivElement>(null);

    // Close placeholder on outside click / Esc
    useEffect(() => {
        if (!slotPlaceholder) return;
        const onMouseDown = (e: MouseEvent) => {
            if (placeholderRef.current && !placeholderRef.current.contains(e.target as Node)) {
                // Allow another empty-grid click to relocate the placeholder
                // (handleSlotClick will run after this and create the new one).
                setSlotPlaceholder(null);
            }
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSlotPlaceholder(null); };
        document.addEventListener('mousedown', onMouseDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onMouseDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [slotPlaceholder]);
    const startHour = parseTime(settings.work_start_time);
    const endHour = parseTime(settings.work_end_time);
    const totalHours = endHour - startHour;
    const totalHeight = totalHours * HOUR_HEIGHT;

    const hourSlots = useMemo(
        () => buildHourSlots(settings.work_start_time, settings.work_end_time),
        [settings.work_start_time, settings.work_end_time],
    );

    const dateKey = format(currentDate, 'yyyy-MM-dd');
    const dayItems = useMemo(
        () => items.filter(i => i.start_at && dateKeyInTZ(i.start_at, tz) === dateKey),
        [items, dateKey, tz],
    );

    const todayStr = todayInTZ(tz);
    const isToday = dateKey === todayStr;

    const nowMinFromGrid = isToday
        ? minutesSinceMidnight(serverDate(), tz) - startHour * 60
        : 0;
    const pastHeight = isToday
        ? Math.max(0, Math.min(nowMinFromGrid, totalHours * 60)) / 60 * HOUR_HEIGHT
        : 0;

    const [dy, dm, dd] = dateKey.split('-').map(Number);

    // ── DnD helpers ──────────────────────────────────────────────────────────

    const pxToMinutes = useCallback((offsetY: number): number => {
        const rawMin = (offsetY / HOUR_HEIGHT) * 60 + startHour * 60;
        return Math.round(rawMin / slotDuration) * slotDuration;
    }, [startHour, slotDuration]);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        if (!hasDragData(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = gridRef.current?.getBoundingClientRect();
        if (!rect) return;
        const offsetY = e.clientY - rect.top;
        setDropHighlightMin(pxToMinutes(offsetY));
    }, [pxToMinutes]);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setDropHighlightMin(null);
        const data = getDragData(e);
        if (!data || !onReschedule) return;
        const rect = gridRef.current?.getBoundingClientRect();
        if (!rect) return;
        const offsetY = e.clientY - rect.top;
        const newStartMin = pxToMinutes(offsetY);
        const newEndMin = newStartMin + data.durationMin;
        const newStartHour = Math.floor(newStartMin / 60);
        const newStartMinute = newStartMin % 60;
        const newEndHour = Math.floor(newEndMin / 60);
        const newEndMinute = newEndMin % 60;
        const startAt = dateInTZ(dy, dm, dd, newStartHour, newStartMinute, tz).toISOString();
        const endAt = dateInTZ(dy, dm, dd, newEndHour, newEndMinute, tz).toISOString();
        onReschedule(data.entityType, data.entityId, startAt, endAt, data.title);
    }, [onReschedule, pxToMinutes, dy, dm, dd, tz]);

    const handleDragLeave = useCallback(() => setDropHighlightMin(null), []);

    // ── Slot click for create-from-slot ────────────────────────────────────

    const handleSlotClick = useCallback((e: React.MouseEvent) => {
        if (!onCreateFromSlot) return;
        // Only trigger if clicking directly on the grid background, not on items / placeholder
        if ((e.target as HTMLElement).closest('[data-schedule-item]')) return;
        if ((e.target as HTMLElement).closest('[data-slot-placeholder]')) return;
        const rect = gridRef.current?.getBoundingClientRect();
        if (!rect) return;
        const offsetY = e.clientY - rect.top;
        const clickMin = pxToMinutes(offsetY);
        const endMin = clickMin + NEW_JOB_DEFAULT_DURATION_MIN;
        const startAt = dateInTZ(dy, dm, dd, Math.floor(clickMin / 60), clickMin % 60, tz).toISOString();
        const endAt = dateInTZ(dy, dm, dd, Math.floor(endMin / 60), endMin % 60, tz).toISOString();
        setSlotPlaceholder({ startMin: clickMin, endMin, startAt, endAt });
    }, [onCreateFromSlot, pxToMinutes, dy, dm, dd, tz]);

    return (
        <div
            className="flex flex-col flex-1 overflow-auto"
            style={{
                background: 'var(--sched-surface)',
                border: '1px solid rgba(255, 255, 255, 0.55)',
                borderRadius: 'var(--sched-radius-xl)',
                boxShadow: 'var(--sched-shadow-main)',
                backdropFilter: 'blur(24px)',
                minWidth: '800px',
            }}
        >
            {/* Header */}
            <div className="flex sticky top-0 z-10" style={{ borderBottom: '1px solid var(--sched-line)', background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.66), rgba(244, 237, 226, 0.42))' }}>
                <div className="flex-shrink-0 flex items-end p-3 text-[11px] font-semibold uppercase" style={{ width: '92px', borderRight: '1px solid var(--sched-line)', color: 'var(--sched-ink-3)', fontFamily: 'Manrope, sans-serif', letterSpacing: '0.14em' }}>
                    Hour
                </div>
                <div
                    className="flex-1 flex flex-col justify-start gap-2 p-3"
                    style={{
                        minHeight: '104px',
                        background: isToday ? 'linear-gradient(180deg, rgba(255, 248, 235, 0.96), rgba(255, 244, 224, 0.76))' : 'transparent',
                    }}
                >
                    <span className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: 'var(--sched-ink-3)', letterSpacing: '0.14em' }}>
                        {format(currentDate, 'EEEE')}
                    </span>
                    <span className="text-[30px] leading-none" style={{ fontFamily: 'Manrope, sans-serif', letterSpacing: '-0.05em', color: 'var(--sched-ink-1)' }}>
                        {format(currentDate, 'd')}
                    </span>
                </div>
            </div>

            {/* Time grid */}
            <div className="flex flex-1 relative">
                {/* Time labels */}
                <div className="flex-shrink-0 relative" style={{
                    width: '92px',
                    borderRight: '1px solid var(--sched-line)',
                    background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.52), rgba(242, 235, 223, 0.62))',
                    backgroundImage: `linear-gradient(180deg, rgba(255, 255, 255, 0.52), rgba(242, 235, 223, 0.62)), repeating-linear-gradient(to bottom, transparent 0 ${HOUR_HEIGHT - 1}px, rgba(118, 106, 89, 0.14) ${HOUR_HEIGHT - 1}px ${HOUR_HEIGHT}px)`,
                }}>
                    {hourSlots.map(h => (
                        <div key={h} className="flex justify-end pr-3 pt-2 text-sm" style={{ height: `${HOUR_HEIGHT}px`, color: 'var(--sched-ink-1)' }}>
                            {formatTimeInTZ(dateInTZ(dy, dm, dd, h, 0, tz), tz)}
                        </div>
                    ))}
                    {isToday && pastHeight > 0 && pastHeight < totalHeight && (
                        <div
                            className="absolute left-0 right-0 z-20 pointer-events-none"
                            style={{ top: pastHeight, borderTop: '2px solid var(--sched-danger)' }}
                        />
                    )}
                </div>

                {/* Day column */}
                <div
                    ref={gridRef}
                    className="flex-1 relative"
                    style={{
                        borderRight: '1px solid var(--sched-line)',
                        background: isToday
                            ? `linear-gradient(180deg, rgba(255, 249, 237, 0.88), rgba(255, 249, 237, 0.58)), repeating-linear-gradient(to bottom, transparent 0 ${HOUR_HEIGHT - 1}px, rgba(118, 106, 89, 0.14) ${HOUR_HEIGHT - 1}px ${HOUR_HEIGHT}px)`
                            : `linear-gradient(180deg, rgba(255, 255, 255, 0.38), rgba(255, 255, 255, 0.06)), repeating-linear-gradient(to bottom, transparent 0 ${HOUR_HEIGHT - 1}px, rgba(118, 106, 89, 0.14) ${HOUR_HEIGHT - 1}px ${HOUR_HEIGHT}px)`,
                    }}
                    onDragOver={handleDragOver}
                    onDrop={handleDrop}
                    onDragLeave={handleDragLeave}
                    onClick={handleSlotClick}
                >
                    {/* Slot lines (spacers for height) */}
                    {hourSlots.map(h => (
                        <div key={h} style={{ height: `${HOUR_HEIGHT}px` }} />
                    ))}

                    {/* Past-time overlay + now-line */}
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
                                <>
                                    <div
                                        className="absolute left-0 right-0 z-[6] pointer-events-none"
                                        style={{ top: pastHeight, borderTop: '2px solid var(--sched-danger)' }}
                                    />
                                    <div
                                        className="absolute z-[7] pointer-events-none inline-flex items-center px-2.5 rounded-full text-[12px] font-bold"
                                        style={{
                                            top: pastHeight - 14,
                                            right: '12px',
                                            minHeight: '28px',
                                            background: 'var(--sched-danger)',
                                            color: '#fff',
                                        }}
                                    >
                                        {formatTimeInTZ(serverDate(), tz)}
                                    </div>
                                </>
                            )}
                        </>
                    )}

                    {/* Drop highlight */}
                    {dropHighlightMin != null && (
                        <div
                            className="absolute left-1 right-1 border-2 border-dashed rounded pointer-events-none z-[5]"
                            style={{
                                top: ((dropHighlightMin - startHour * 60) / 60) * HOUR_HEIGHT,
                                height: (slotDuration / 60) * HOUR_HEIGHT,
                                background: 'rgba(47, 99, 216, 0.1)',
                                borderColor: 'var(--sched-job)',
                            }}
                        />
                    )}

                    {/* Positioned items — each overlap cluster splits column width across all lanes (no hidden "+N") */}
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
                            const isDraggable = item.entity_type !== 'lead';

                            return (
                                <div
                                    key={key}
                                    data-schedule-item
                                    className={`absolute z-10 ${isDraggable ? 'cursor-grab active:cursor-grabbing' : ''}`}
                                    draggable={isDraggable}
                                    onDragStart={isDraggable ? (e) => {
                                        setDragData(e, item, durationMin);
                                        (e.target as HTMLElement).style.opacity = '0.5';
                                    } : undefined}
                                    onDragEnd={(e) => {
                                        (e.target as HTMLElement).style.opacity = '1';
                                        setDropHighlightMin(null);
                                    }}
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

                    {/* New-job placeholder — inline, dashed border, draggable vertically */}
                    {slotPlaceholder && onCreateFromSlot && (
                        <NewJobPlaceholder
                            ref={placeholderRef}
                            topPx={((slotPlaceholder.startMin - startHour * 60) / 60) * HOUR_HEIGHT}
                            heightPx={((slotPlaceholder.endMin - slotPlaceholder.startMin) / 60) * HOUR_HEIGHT}
                            startAt={slotPlaceholder.startAt}
                            endAt={slotPlaceholder.endAt}
                            timezone={tz}
                            leftCss="4px"
                            rightCss="4px"
                            onCreate={() => {
                                onCreateFromSlot('', slotPlaceholder.startAt, slotPlaceholder.endAt);
                                setSlotPlaceholder(null);
                            }}
                            onClose={() => setSlotPlaceholder(null)}
                            onDragMove={(newTopPx) => {
                                const duration = slotPlaceholder.endMin - slotPlaceholder.startMin;
                                const rawMin = startHour * 60 + (newTopPx / HOUR_HEIGHT) * 60;
                                const snapped = Math.round(rawMin / slotDuration) * slotDuration;
                                const minStart = Math.floor(startHour * 60);
                                const maxStart = Math.floor(endHour * 60 - duration);
                                const newStart = Math.max(minStart, Math.min(maxStart, snapped));
                                const newEnd = newStart + duration;
                                const newStartAt = dateInTZ(dy, dm, dd, Math.floor(newStart / 60), newStart % 60, tz).toISOString();
                                const newEndAt = dateInTZ(dy, dm, dd, Math.floor(newEnd / 60), newEnd % 60, tz).toISOString();
                                setSlotPlaceholder(prev => prev && {
                                    ...prev,
                                    startMin: newStart,
                                    endMin: newEnd,
                                    startAt: newStartAt,
                                    endAt: newEndAt,
                                });
                            }}
                        />
                    )}
                </div>
            </div>
        </div>
    );
};
