/**
 * TimelineView — Vertical timeline with provider columns.
 * Each column = one provider (or "Unassigned"). Rows = hours of the day.
 * Timezone-aware: positioning and labels use company TZ from settings.
 * Supports DnD reschedule (vertical, within column) + reassign (between columns).
 */

import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { format } from 'date-fns';
import { ScheduleItemCard } from './ScheduleItemCard';
import { NewJobPlaceholder, NEW_JOB_DEFAULT_DURATION_MIN } from './NewJobPlaceholder';
import type { ScheduleItem, DispatchSettings } from '../../services/scheduleApi';
import type { ProviderInfo } from '../../hooks/useScheduleData';
import {
    todayInTZ, dateInTZ, minutesSinceMidnight,
    formatTimeInTZ, dateKeyInTZ,
} from '../../utils/companyTime';
import { serverDate } from '../../utils/serverClock';
import { setDragData, getDragData, hasDragData } from '../../hooks/useScheduleDnD';
import { getProviderColor } from '../../utils/providerColors';
import { assignLanes, type LayoutItem } from '../../utils/scheduleLayout';

const HOUR_HEIGHT = 86;

interface TimelineViewProps {
    currentDate: Date;
    items: ScheduleItem[];
    settings: DispatchSettings;
    allProviders?: ProviderInfo[];
    onSelectItem: (item: ScheduleItem) => void;
    onReschedule?: (entityType: string, entityId: number, startAt: string, endAt: string, title?: string) => void;
    onReassign?: (entityType: string, entityId: number, assigneeId: string | null, assigneeName?: string, title?: string) => void;
    onCreateFromSlot?: (title: string, startAt: string, endAt: string) => void;
}

function parseTime(t: string): number {
    const [h, m] = t.split(':').map(Number);
    return h + (m || 0) / 60;
}

interface ProviderGroup {
    id: string;
    label: string;
    items: ScheduleItem[];
}

interface PositionedItem {
    item: ScheduleItem;
    topPx: number;
    heightPx: number;
    durationMin: number;
    lane: number;       // 0-indexed lane within its overlap cluster
    laneCount: number;  // total lanes in that cluster (== max parallel overlap)
}

/** Compute top/height + lane assignment for items in a single provider column,
 *  using the shared `assignLanes` utility so layout matches Day/Week views. */
function layoutItems(items: ScheduleItem[], tz: string, startHour: number): PositionedItem[] {
    const layoutInput: (LayoutItem & { item: ScheduleItem; topPx: number; heightPx: number; durationMin: number })[] = [];
    for (const item of items) {
        if (!item.start_at) continue;
        const startMin = minutesSinceMidnight(new Date(item.start_at), tz);
        let durationMin = 60;
        if (item.end_at) {
            const endMin = minutesSinceMidnight(new Date(item.end_at), tz);
            durationMin = endMin - startMin;
            if (durationMin <= 0) durationMin = 60;
        }
        layoutInput.push({
            key: `${item.entity_type}-${item.entity_id}`,
            startMin,
            endMin: startMin + durationMin,
            item,
            durationMin,
            topPx: (startMin - startHour * 60) / 60 * HOUR_HEIGHT,
            heightPx: Math.max(durationMin / 60 * HOUR_HEIGHT, HOUR_HEIGHT * 0.6),
        });
    }
    const lanes = assignLanes(layoutInput);
    return layoutInput.map(li => {
        const r = lanes.get(li.key);
        return {
            item: li.item,
            topPx: li.topPx,
            heightPx: li.heightPx,
            durationMin: li.durationMin,
            lane: r?.lane ?? 0,
            laneCount: r?.totalLanes ?? 1,
        };
    });
}

export const TimelineView: React.FC<TimelineViewProps> = ({
    currentDate, items, settings, allProviders = [], onSelectItem, onReschedule, onReassign, onCreateFromSlot,
}) => {
    const tz = settings.timezone || 'America/New_York';
    const slotDuration = settings.slot_duration || 60;
    const startHour = parseTime(settings.work_start_time);
    const endHour = parseTime(settings.work_end_time);
    const totalHours = endHour - startHour;

    const [dropHighlight, setDropHighlight] = useState<{ providerId: string; topPct: number } | null>(null);
    const [slotPlaceholder, setSlotPlaceholder] = useState<{
        groupId: string;
        startMin: number;
        endMin: number;
        startAt: string;
        endAt: string;
        providerId?: string;
        providerName?: string;
    } | null>(null);
    const colRefs = useRef<Map<string, HTMLDivElement>>(new Map());
    const placeholderRef = useRef<HTMLDivElement>(null);

    // Close inline placeholder on outside click / Esc
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

    const hours = useMemo(() => {
        const result: number[] = [];
        for (let h = Math.floor(startHour); h < Math.ceil(endHour); h++) result.push(h);
        return result;
    }, [startHour, endHour]);

    const dateKey = format(currentDate, 'yyyy-MM-dd');
    const dayItems = useMemo(
        () => items.filter(i => i.start_at && dateKeyInTZ(i.start_at, tz) === dateKey),
        [items, dateKey, tz],
    );

    const providerGroups: ProviderGroup[] = useMemo(() => {
        const map = new Map<string, ProviderGroup>();
        for (const p of allProviders) {
            map.set(p.id, { id: p.id, label: p.name, items: [] });
        }
        for (const item of dayItems) {
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
    }, [dayItems, allProviders]);

    const todayStr = todayInTZ(tz);
    const isToday = dateKey === todayStr;
    const nowMinFromGrid = isToday
        ? minutesSinceMidnight(serverDate(), tz) - startHour * 60
        : 0;
    const nowPx = isToday
        ? Math.max(0, Math.min(nowMinFromGrid / 60 * HOUR_HEIGHT, totalHours * HOUR_HEIGHT))
        : 0;

    const [refY, refM, refD] = dateKey.split('-').map(Number);
    const bodyHeight = totalHours * HOUR_HEIGHT;

    // ── DnD helpers ──────────────────────────────────────────────────────

    const pctToMinutes = useCallback((pct: number): number => {
        const rawMin = startHour * 60 + pct * totalHours * 60;
        return Math.round(rawMin / slotDuration) * slotDuration;
    }, [startHour, totalHours, slotDuration]);

    const handleDragOver = useCallback((providerId: string, e: React.DragEvent) => {
        if (!hasDragData(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const col = colRefs.current.get(providerId);
        if (!col) return;
        const rect = col.getBoundingClientRect();
        const topPct = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
        setDropHighlight({ providerId, topPct });
    }, []);

    const handleDrop = useCallback((group: ProviderGroup, e: React.DragEvent) => {
        e.preventDefault();
        setDropHighlight(null);
        const data = getDragData(e);
        if (!data) return;
        const col = colRefs.current.get(group.id);
        if (!col) return;
        const rect = col.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
        const newStartMin = pctToMinutes(pct);
        const newEndMin = newStartMin + data.durationMin;

        if (onReschedule) {
            const startAt = dateInTZ(refY, refM, refD, Math.floor(newStartMin / 60), newStartMin % 60, tz).toISOString();
            const endAt = dateInTZ(refY, refM, refD, Math.floor(newEndMin / 60), newEndMin % 60, tz).toISOString();
            onReschedule(data.entityType, data.entityId, startAt, endAt, data.title);
        }

        if (onReassign) {
            const assigneeId = group.id === '__unassigned' ? null : group.id;
            const assigneeName = group.id === '__unassigned' ? undefined : group.label;
            onReassign(data.entityType, data.entityId, assigneeId, assigneeName, data.title);
        }
    }, [onReschedule, onReassign, pctToMinutes, refY, refM, refD, tz]);

    // ── Slot click for create-from-slot ────────────────────────────────────

    const handleSlotClick = useCallback((group: ProviderGroup, e: React.MouseEvent) => {
        if (!onCreateFromSlot) return;
        // Don't trigger when clicking an existing item or the placeholder itself
        if ((e.target as HTMLElement).closest('[data-schedule-item]')) return;
        if ((e.target as HTMLElement).closest('[data-slot-placeholder]')) return;
        const col = colRefs.current.get(group.id);
        if (!col) return;
        const rect = col.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
        const clickMin = pctToMinutes(pct);
        const endMin = clickMin + NEW_JOB_DEFAULT_DURATION_MIN;
        const startAt = dateInTZ(refY, refM, refD, Math.floor(clickMin / 60), clickMin % 60, tz).toISOString();
        const endAt = dateInTZ(refY, refM, refD, Math.floor(endMin / 60), endMin % 60, tz).toISOString();
        setSlotPlaceholder({
            groupId: group.id,
            startMin: clickMin,
            endMin,
            startAt,
            endAt,
            providerId: group.id === '__unassigned' ? undefined : group.id,
            providerName: group.id === '__unassigned' ? undefined : group.label,
        });
    }, [onCreateFromSlot, pctToMinutes, refY, refM, refD, tz]);

    return (
        <div
            className="flex flex-col overflow-auto"
            style={{
                background: 'var(--sched-surface)',
                border: '1px solid rgba(255, 255, 255, 0.55)',
                borderRadius: 'var(--sched-radius-xl)',
                boxShadow: 'var(--sched-shadow-main)',
                backdropFilter: 'blur(24px)',
            }}
        >
            {/* Header: date corner + provider columns */}
            <div
                className="sticky top-0 z-10 flex"
                style={{
                    borderBottom: '1px solid var(--sched-line)',
                    background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.66), rgba(244, 237, 226, 0.42))',
                }}
            >
                {/* Corner: date */}
                <div
                    className="flex-shrink-0 w-[72px] p-3 text-[11px] font-semibold uppercase"
                    style={{ borderRight: '1px solid var(--sched-line)', color: 'var(--sched-ink-3)', fontFamily: 'Manrope, sans-serif', letterSpacing: '0.14em' }}
                >
                    Hour
                </div>

                {/* Provider headers */}
                <div
                    className="flex-1 flex"
                    style={{ minWidth: `${providerGroups.length * 140}px` }}
                >
                    {providerGroups.map(group => {
                        const provColor = group.id !== '__unassigned' ? getProviderColor(group.id) : null;
                        return (
                            <div
                                key={group.id}
                                className="flex-1 flex items-center justify-center gap-1.5 py-3 px-2 text-[13px] font-semibold min-w-[140px]"
                                style={{
                                    borderRight: '1px solid var(--sched-line)',
                                    color: group.id === '__unassigned' ? 'var(--sched-ink-3)' : 'var(--sched-ink-1)',
                                    fontStyle: group.id === '__unassigned' ? 'italic' : 'normal',
                                    fontWeight: group.id === '__unassigned' ? 400 : undefined,
                                    fontFamily: 'Manrope, sans-serif',
                                }}
                            >
                                {provColor && (
                                    <span
                                        className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
                                        style={{ background: provColor.accent }}
                                    />
                                )}
                                <span className="truncate">{group.label}</span>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Body: time gutter + provider columns */}
            <div className="flex">
                {/* Time gutter */}
                <div
                    className="flex-shrink-0 w-[72px]"
                    style={{ borderRight: '1px solid var(--sched-line)' }}
                >
                    {hours.map(h => (
                        <div
                            key={h}
                            className="flex items-start justify-end pr-2 pt-1"
                            style={{
                                height: HOUR_HEIGHT,
                                borderBottom: '1px solid rgba(118, 106, 89, 0.1)',
                                color: 'var(--sched-ink-1)',
                                fontSize: '14px',
                            }}
                        >
                            {formatTimeInTZ(dateInTZ(refY, refM, refD, h, 0, tz), tz)}
                        </div>
                    ))}
                </div>

                {/* Provider columns */}
                <div
                    className="flex-1 flex"
                    style={{ minWidth: `${providerGroups.length * 140}px` }}
                >
                    {providerGroups.map(group => (
                        <div
                            key={group.id}
                            ref={el => { if (el) colRefs.current.set(group.id, el); }}
                            className="flex-1 relative min-w-[140px]"
                            style={{
                                height: bodyHeight,
                                borderRight: '1px solid var(--sched-line)',
                                background: dropHighlight?.providerId === group.id
                                    ? 'rgba(27, 139, 99, 0.06)'
                                    : 'transparent',
                            }}
                            onDragOver={(e) => handleDragOver(group.id, e)}
                            onDrop={(e) => handleDrop(group, e)}
                            onDragLeave={() => setDropHighlight(null)}
                            onClick={(e) => handleSlotClick(group, e)}
                        >
                            {/* Hour grid lines */}
                            {hours.map(h => (
                                <div
                                    key={h}
                                    className="absolute left-0 right-0 pointer-events-none"
                                    style={{
                                        top: (h - Math.floor(startHour)) * HOUR_HEIGHT,
                                        height: HOUR_HEIGHT,
                                        borderBottom: '1px solid rgba(118, 106, 89, 0.1)',
                                    }}
                                />
                            ))}

                            {/* Past-time overlay */}
                            {isToday && nowPx > 0 && (
                                <>
                                    <div
                                        className="absolute top-0 left-0 right-0 pointer-events-none z-[1]"
                                        style={{
                                            height: Math.min(nowPx, bodyHeight),
                                            background: 'rgba(58, 48, 39, 0.06)',
                                        }}
                                    />
                                    {nowPx < bodyHeight && (
                                        <div
                                            className="absolute left-0 right-0 z-[6] pointer-events-none"
                                            style={{ top: nowPx, borderTop: '2px solid var(--sched-danger)' }}
                                        />
                                    )}
                                </>
                            )}

                            {/* Drop highlight line (horizontal) */}
                            {dropHighlight?.providerId === group.id && (
                                <div
                                    className="absolute left-0 right-0 border-t-2 border-dashed pointer-events-none z-[5]"
                                    style={{
                                        top: `${dropHighlight.topPct * 100}%`,
                                        borderColor: 'var(--sched-job)',
                                    }}
                                />
                            )}

                            {/* Items — laid out into lanes so overlapping events split width instead of stacking */}
                            {layoutItems(group.items, tz, startHour).map(({ item, topPx, heightPx, durationMin, lane, laneCount }) => {
                                const isDraggable = item.entity_type !== 'lead';
                                const widthPct = 100 / laneCount;
                                const leftPct = lane * widthPct;

                                return (
                                    <div
                                        key={`${item.entity_type}-${item.entity_id}`}
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
                                            top: topPx + 2,
                                            height: heightPx - 4,
                                            left: `calc(${leftPct}% + 2px)`,
                                            width: `calc(${widthPct}% - 4px)`,
                                        }}
                                    >
                                        <ScheduleItemCard item={item} compact onClick={onSelectItem} timezone={tz} />
                                    </div>
                                );
                            })}

                            {/* New-job placeholder — inline, dashed border, sized to default arrival window.
                                Vertically draggable within this column to fine-tune the time. */}
                            {slotPlaceholder && slotPlaceholder.groupId === group.id && onCreateFromSlot && (
                                <NewJobPlaceholder
                                    ref={placeholderRef}
                                    topPx={((slotPlaceholder.startMin - startHour * 60) / 60) * HOUR_HEIGHT}
                                    heightPx={((slotPlaceholder.endMin - slotPlaceholder.startMin) / 60) * HOUR_HEIGHT}
                                    startAt={slotPlaceholder.startAt}
                                    endAt={slotPlaceholder.endAt}
                                    providerName={slotPlaceholder.providerName}
                                    timezone={tz}
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
                                        const newStartAt = dateInTZ(refY, refM, refD, Math.floor(newStart / 60), newStart % 60, tz).toISOString();
                                        const newEndAt = dateInTZ(refY, refM, refD, Math.floor(newEnd / 60), newEnd % 60, tz).toISOString();
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
                    ))}
                </div>
            </div>
        </div>
    );
};

