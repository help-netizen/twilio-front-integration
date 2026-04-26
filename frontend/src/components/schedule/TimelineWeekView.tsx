/**
 * TimelineWeekView — 7-day rows × provider columns.
 * Primary dispatch view: see all providers across a full week.
 * Transposed layout: days are rows, providers are columns.
 * Supports DnD reassign between provider columns.
 */

import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { startOfWeek, addDays, format } from 'date-fns';
import { ScheduleItemCard } from './ScheduleItemCard';
import { NewJobPlaceholder, NEW_JOB_DEFAULT_DURATION_MIN } from './NewJobPlaceholder';
import type { ScheduleItem, DispatchSettings } from '../../services/scheduleApi';
import type { ProviderInfo } from '../../hooks/useScheduleData';
import { todayInTZ, dateKeyInTZ, dateInTZ } from '../../utils/companyTime';
import { setDragData, getDragData, hasDragData } from '../../hooks/useScheduleDnD';
import { getProviderColor } from '../../utils/providerColors';

function parseTime(t: string): number {
    const [h, m] = t.split(':').map(Number);
    return h + (m || 0) / 60;
}

interface TimelineWeekViewProps {
    currentDate: Date;
    items: ScheduleItem[];
    settings: DispatchSettings;
    allProviders?: ProviderInfo[];
    onSelectItem: (item: ScheduleItem) => void;
    onReassign?: (entityType: string, entityId: number, assigneeId: string | null, assigneeName?: string, title?: string) => void;
    onCreateFromSlot?: (title: string, startAt: string, endAt: string) => void;
}

interface ProviderGroup {
    id: string;
    label: string;
    items: ScheduleItem[];
}

export const TimelineWeekView: React.FC<TimelineWeekViewProps> = ({
    currentDate, items, settings, allProviders = [], onSelectItem, onReassign, onCreateFromSlot,
}) => {
    const tz = settings.timezone || 'America/New_York';
    const workStartHour = parseTime(settings.work_start_time);
    const weekStart = startOfWeek(currentDate, { weekStartsOn: 0 });
    const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
    const dayKeys = useMemo(() => days.map(d => format(d, 'yyyy-MM-dd')), [days]);

    const [dropHighlightCol, setDropHighlightCol] = useState<string | null>(null);
    const [slotPlaceholder, setSlotPlaceholder] = useState<{
        cellKey: string;       // `${dayKey}|${groupId}`
        startAt: string;
        endAt: string;
        providerId?: string;
        providerName?: string;
    } | null>(null);
    const placeholderRef = useRef<HTMLDivElement>(null);

    // Close placeholder on outside click / Esc
    useEffect(() => {
        if (!slotPlaceholder) return;
        const onMouseDown = (e: MouseEvent) => {
            if (placeholderRef.current && !placeholderRef.current.contains(e.target as Node)) {
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

    const providerGroups: ProviderGroup[] = useMemo(() => {
        const map = new Map<string, ProviderGroup>();
        for (const p of allProviders) {
            map.set(p.id, { id: p.id, label: p.name, items: [] });
        }
        for (const item of items) {
            if (!item.start_at) continue;
            const techs = item.assigned_techs;
            if (techs && techs.length > 0) {
                for (const tech of techs) {
                    const id = tech.id || tech.name;
                    if (!map.has(id)) map.set(id, { id, label: tech.name, items: [] });
                    map.get(id)!.items.push(item);
                }
            } else {
                if (!map.has('__unassigned')) map.set('__unassigned', { id: '__unassigned', label: 'Unassigned', items: [] });
                map.get('__unassigned')!.items.push(item);
            }
        }
        const groups = Array.from(map.values());
        groups.sort((a, b) => {
            if (a.id === '__unassigned') return 1;
            if (b.id === '__unassigned') return -1;
            return a.label.localeCompare(b.label);
        });
        if (groups.length === 0) groups.push({ id: '__unassigned', label: 'Unassigned', items: [] });
        return groups;
    }, [items, allProviders]);

    const todayStr = todayInTZ(tz);
    const colCount = providerGroups.length;

    // ── DnD handlers ─────────────────────────────────────────────────────

    const handleDragOver = useCallback((providerId: string, e: React.DragEvent) => {
        if (!hasDragData(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDropHighlightCol(providerId);
    }, []);

    const handleDrop = useCallback((group: ProviderGroup, e: React.DragEvent) => {
        e.preventDefault();
        setDropHighlightCol(null);
        const data = getDragData(e);
        if (!data || !onReassign) return;
        const assigneeId = group.id === '__unassigned' ? null : group.id;
        const assigneeName = group.id === '__unassigned' ? undefined : group.label;
        onReassign(data.entityType, data.entityId, assigneeId, assigneeName, data.title);
    }, [onReassign]);

    // ── Slot click for create-from-slot ────────────────────────────────────

    const handleSlotClick = useCallback((dayKey: string, group: ProviderGroup, e: React.MouseEvent) => {
        if (!onCreateFromSlot) return;
        if ((e.target as HTMLElement).closest('[data-schedule-item]')) return;
        if ((e.target as HTMLElement).closest('[data-slot-placeholder]')) return;
        const [y, m, d] = dayKey.split('-').map(Number);
        const startHr = Math.floor(workStartHour);
        const startMn = Math.round((workStartHour - startHr) * 60);
        const endMin = startHr * 60 + startMn + NEW_JOB_DEFAULT_DURATION_MIN;
        const startAt = dateInTZ(y, m, d, startHr, startMn, tz).toISOString();
        const endAt = dateInTZ(y, m, d, Math.floor(endMin / 60), endMin % 60, tz).toISOString();
        setSlotPlaceholder({
            cellKey: `${dayKey}|${group.id}`,
            startAt,
            endAt,
            providerId: group.id === '__unassigned' ? undefined : group.id,
            providerName: group.id === '__unassigned' ? undefined : group.label,
        });
    }, [onCreateFromSlot, workStartHour, tz]);

    // Grid: 1 day-label column + N provider columns
    const gridCols = `140px repeat(${colCount}, minmax(140px, 1fr))`;

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
            {/* Header row: corner + provider names */}
            <div
                className="grid sticky top-0 z-10"
                style={{
                    gridTemplateColumns: gridCols,
                    borderBottom: '1px solid var(--sched-line)',
                    background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.66), rgba(244, 237, 226, 0.42))',
                }}
            >
                {/* Corner cell */}
                <div
                    className="p-3 flex items-end"
                    style={{
                        borderRight: '1px solid var(--sched-line)',
                        fontFamily: 'Manrope, sans-serif',
                    }}
                >
                    <span className="text-[11px] uppercase font-semibold" style={{ color: 'var(--sched-ink-3)', letterSpacing: '0.14em' }}>
                        Day
                    </span>
                </div>
                {/* Provider column headers */}
                {providerGroups.map(group => {
                    const provColor = group.id !== '__unassigned' ? getProviderColor(group.id) : null;
                    return (
                        <div
                            key={group.id}
                            className="py-3 px-2 text-center"
                            style={{
                                borderRight: '1px solid var(--sched-line)',
                                background: dropHighlightCol === group.id ? 'rgba(27, 139, 99, 0.06)' : 'transparent',
                            }}
                            onDragOver={(e) => handleDragOver(group.id, e)}
                            onDrop={(e) => handleDrop(group, e)}
                            onDragLeave={() => setDropHighlightCol(null)}
                        >
                            <div className="flex items-center justify-center gap-1.5 text-[13px] font-semibold truncate" style={{
                                color: group.id === '__unassigned' ? 'var(--sched-ink-3)' : 'var(--sched-ink-1)',
                                fontStyle: group.id === '__unassigned' ? 'italic' : 'normal',
                                fontFamily: 'Manrope, sans-serif',
                            }}>
                                {provColor && (
                                    <span
                                        className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
                                        style={{ background: provColor.accent }}
                                    />
                                )}
                                <span className="truncate">{group.label}</span>
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Day rows */}
            {days.map((day, dayIdx) => {
                const dayKey = dayKeys[dayIdx];
                const isToday = dayKey === todayStr;

                return (
                    <div
                        key={dayKey}
                        className="grid"
                        style={{
                            gridTemplateColumns: gridCols,
                            minHeight: '80px',
                            borderBottom: '1px solid var(--sched-line)',
                            background: isToday ? 'rgba(255, 247, 231, 0.4)' : 'transparent',
                        }}
                    >
                        {/* Day label */}
                        <div
                            className="p-3 flex flex-col justify-start"
                            style={{
                                borderRight: '1px solid var(--sched-line)',
                                background: isToday ? 'var(--sched-today-soft)' : 'transparent',
                            }}
                        >
                            <div className="text-[11px] uppercase font-semibold" style={{ color: 'var(--sched-ink-3)', letterSpacing: '0.14em' }}>
                                {format(day, 'EEE')}
                            </div>
                            <div className="text-sm" style={{
                                color: isToday ? 'var(--sched-job)' : 'var(--sched-ink-1)',
                            }}>
                                {format(day, 'MMM d')}
                            </div>
                        </div>

                        {/* Provider cells for this day */}
                        {providerGroups.map(group => {
                            const cellItems = group.items.filter(
                                item => item.start_at && dateKeyInTZ(item.start_at, tz) === dayKey,
                            );
                            return (
                                <div
                                    key={group.id}
                                    className="p-1.5 space-y-1"
                                    style={{
                                        borderRight: '1px solid var(--sched-line)',
                                        background: dropHighlightCol === group.id ? 'rgba(27, 139, 99, 0.06)' : 'transparent',
                                    }}
                                    onDragOver={(e) => handleDragOver(group.id, e)}
                                    onDrop={(e) => handleDrop(group, e)}
                                    onDragLeave={() => setDropHighlightCol(null)}
                                    onClick={(e) => handleSlotClick(dayKey, group, e)}
                                >
                                    {cellItems.map(item => {
                                        const isDraggable = item.entity_type !== 'lead';
                                        let durationMin = 60;
                                        if (item.start_at && item.end_at) {
                                            durationMin = Math.max(
                                                (new Date(item.end_at).getTime() - new Date(item.start_at).getTime()) / 60000,
                                                60,
                                            );
                                        }
                                        return (
                                            <div
                                                key={`${item.entity_type}-${item.entity_id}`}
                                                data-schedule-item
                                                draggable={isDraggable}
                                                className={isDraggable ? 'cursor-grab active:cursor-grabbing' : ''}
                                                onDragStart={isDraggable ? (e) => {
                                                    setDragData(e, item, durationMin);
                                                    (e.target as HTMLElement).style.opacity = '0.5';
                                                } : undefined}
                                                onDragEnd={(e) => {
                                                    (e.target as HTMLElement).style.opacity = '1';
                                                    setDropHighlightCol(null);
                                                }}
                                            >
                                                <ScheduleItemCard
                                                    item={item}
                                                    compact
                                                    onClick={onSelectItem}
                                                    timezone={tz}
                                                />
                                            </div>
                                        );
                                    })}

                                    {/* New-job placeholder — renders inline at the bottom of this cell.
                                        TimelineWeekView has no time-grid inside the cell, so the placeholder
                                        is a stack item rather than absolutely positioned. */}
                                    {slotPlaceholder && slotPlaceholder.cellKey === `${dayKey}|${group.id}` && onCreateFromSlot && (
                                        <NewJobPlaceholder
                                            ref={placeholderRef}
                                            inline
                                            topPx={0}
                                            heightPx={0}
                                            startAt={slotPlaceholder.startAt}
                                            endAt={slotPlaceholder.endAt}
                                            providerName={slotPlaceholder.providerName}
                                            timezone={tz}
                                            onCreate={() => {
                                                onCreateFromSlot('', slotPlaceholder.startAt, slotPlaceholder.endAt);
                                                setSlotPlaceholder(null);
                                            }}
                                            onClose={() => setSlotPlaceholder(null)}
                                        />
                                    )}
                                </div>
                            );
                        })}
                    </div>
                );
            })}
        </div>
    );
};
