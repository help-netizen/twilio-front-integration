/**
 * ListView — Vertical list of jobs per technician column, grouped by day.
 * No hourly grid — items simply stack vertically, sorted by start time.
 * Days separated by Pulse-style DateSeparator headings (no lines).
 */

import React, { useMemo, useState, useCallback } from 'react';
import { startOfWeek, addDays, format } from 'date-fns';
import { ScheduleItemCard } from './ScheduleItemCard';
import type { ScheduleItem, DispatchSettings } from '../../services/scheduleApi';
import type { ProviderInfo } from '../../hooks/useScheduleData';
import { todayInTZ, dateKeyInTZ } from '../../utils/companyTime';
import { setDragData, getDragData, hasDragData } from '../../hooks/useScheduleDnD';
import { getProviderColor } from '../../utils/providerColors';

interface ListViewProps {
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

/** Format date for day heading — compact: "Mon, Apr 15" or "Today" / "Yesterday" */
function formatDayHeading(day: Date, todayStr: string, tz: string): string {
    const dayKey = format(day, 'yyyy-MM-dd');
    if (dayKey === todayStr) return 'Today';

    // Check yesterday
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = format(yesterday, 'yyyy-MM-dd');
    if (dayKey === yesterdayKey) return 'Yesterday';

    return day.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export const ListView: React.FC<ListViewProps> = ({
    currentDate, items, settings, allProviders = [], onSelectItem, onReassign,
}) => {
    const tz = settings.timezone || 'America/New_York';
    const weekStart = startOfWeek(currentDate, { weekStartsOn: 0 });
    const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
    const dayKeys = useMemo(() => days.map(d => format(d, 'yyyy-MM-dd')), [days]);

    const [dropHighlightCol, setDropHighlightCol] = useState<string | null>(null);

    // ── Provider grouping (same logic as TimelineWeekView) ───────────────
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

    const gridCols = `repeat(${colCount}, minmax(200px, 1fr))`;

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
            {/* Sticky header: provider column names */}
            <div
                className="grid sticky top-0 z-10"
                style={{
                    gridTemplateColumns: gridCols,
                    borderBottom: '1px solid var(--sched-line)',
                    background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.66), rgba(244, 237, 226, 0.42))',
                }}
            >
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

            {/* Body: provider columns side by side */}
            <div
                className="grid flex-1"
                style={{ gridTemplateColumns: gridCols, alignItems: 'start' }}
            >
                {providerGroups.map(group => (
                    <div
                        key={group.id}
                        className="min-h-[200px]"
                        style={{
                            borderRight: '1px solid var(--sched-line)',
                            background: dropHighlightCol === group.id ? 'rgba(27, 139, 99, 0.06)' : 'transparent',
                        }}
                        onDragOver={(e) => handleDragOver(group.id, e)}
                        onDrop={(e) => handleDrop(group, e)}
                        onDragLeave={() => setDropHighlightCol(null)}
                    >
                        {days.map((day, dayIdx) => {
                            const dayKey = dayKeys[dayIdx];
                            const dayItems = group.items
                                .filter(item => item.start_at && dateKeyInTZ(item.start_at, tz) === dayKey)
                                .sort((a, b) => new Date(a.start_at!).getTime() - new Date(b.start_at!).getTime());

                            if (dayItems.length === 0) return null;

                            return (
                                <div key={dayKey}>
                                    {/* Day heading — Pulse DateSeparator style */}
                                    <div className="px-3 pt-4 pb-1">
                                        <h3
                                            className="text-[13px] font-bold"
                                            style={{
                                                color: dayKey === todayStr ? 'var(--sched-job)' : 'var(--blanc-ink-1)',
                                                fontFamily: 'var(--blanc-font-heading)',
                                                letterSpacing: '-0.01em',
                                            }}
                                        >
                                            {formatDayHeading(day, todayStr, tz)}
                                        </h3>
                                    </div>

                                    {/* Items */}
                                    <div className="px-1.5 pb-1 space-y-1">
                                        {dayItems.map(item => {
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
                                                        onClick={onSelectItem}
                                                        timezone={tz}
                                                    />
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                ))}
            </div>
        </div>
    );
};
