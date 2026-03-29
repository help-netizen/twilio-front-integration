/**
 * TimelineView — Horizontal timeline with provider rows.
 * Each row = one provider (or "Unassigned"). Columns = hours of the day.
 */

import React, { useMemo } from 'react';
import { format, parseISO, getHours, getMinutes } from 'date-fns';
import { ScheduleItemCard } from './ScheduleItemCard';
import type { ScheduleItem, DispatchSettings } from '../../services/scheduleApi';

interface TimelineViewProps {
    currentDate: Date;
    items: ScheduleItem[];
    settings: DispatchSettings;
    onSelectItem: (item: ScheduleItem) => void;
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

export const TimelineView: React.FC<TimelineViewProps> = ({ currentDate, items, settings, onSelectItem }) => {
    const startHour = parseTime(settings.work_start_time);
    const endHour = parseTime(settings.work_end_time);
    const totalHours = endHour - startHour;

    // Build hourly columns
    const hours = useMemo(() => {
        const result: number[] = [];
        for (let h = Math.floor(startHour); h < Math.ceil(endHour); h++) result.push(h);
        return result;
    }, [startHour, endHour]);

    // Filter items for selected day
    const dayKey = format(currentDate, 'yyyy-MM-dd');
    const dayItems = useMemo(
        () => items.filter(i => i.start_at && format(parseISO(i.start_at), 'yyyy-MM-dd') === dayKey),
        [items, dayKey],
    );

    // Group by provider
    const providerGroups: ProviderGroup[] = useMemo(() => {
        const map = new Map<string, ProviderGroup>();
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
        // Ensure "Unassigned" row always at end
        const groups = Array.from(map.values());
        groups.sort((a, b) => {
            if (a.id === '__unassigned') return 1;
            if (b.id === '__unassigned') return -1;
            return a.label.localeCompare(b.label);
        });
        if (groups.length === 0) groups.push({ id: '__unassigned', label: 'Unassigned', items: [] });
        return groups;
    }, [dayItems]);

    return (
        <div className="flex flex-col flex-1 overflow-auto">
            {/* Header: date + hour columns */}
            <div className="flex border-b sticky top-0 bg-white z-10">
                <div className="w-36 flex-shrink-0 border-r p-2 text-sm font-medium text-gray-700">
                    {format(currentDate, 'EEE, MMM d')}
                </div>
                {hours.map(h => (
                    <div key={h} className="flex-1 text-center py-2 border-r text-xs text-gray-500 min-w-[80px]">
                        {format(new Date(2000, 0, 1, h), 'h a')}
                    </div>
                ))}
            </div>

            {/* Provider rows */}
            {providerGroups.map(group => (
                <div key={group.id} className="flex border-b min-h-[56px]">
                    {/* Provider label */}
                    <div className="w-36 flex-shrink-0 border-r p-2 flex items-center">
                        <span className={`text-sm truncate ${group.id === '__unassigned' ? 'text-gray-400 italic' : 'text-gray-700 font-medium'}`}>
                            {group.label}
                        </span>
                    </div>
                    {/* Timeline area */}
                    <div className="flex-1 relative min-w-0" style={{ minWidth: `${hours.length * 80}px` }}>
                        {/* Grid lines */}
                        <div className="absolute inset-0 flex">
                            {hours.map(h => (
                                <div key={h} className="flex-1 border-r border-gray-100" />
                            ))}
                        </div>
                        {/* Items */}
                        {group.items.map(item => {
                            if (!item.start_at) return null;
                            const parsed = parseISO(item.start_at);
                            const itemHour = getHours(parsed) + getMinutes(parsed) / 60;
                            const leftPct = ((itemHour - startHour) / totalHours) * 100;

                            let durationHours = 1;
                            if (item.end_at) {
                                const endP = parseISO(item.end_at);
                                durationHours = (getHours(endP) + getMinutes(endP) / 60) - itemHour;
                            }
                            const widthPct = (durationHours / totalHours) * 100;

                            return (
                                <div
                                    key={`${item.entity_type}-${item.entity_id}`}
                                    className="absolute top-1 bottom-1 z-10"
                                    style={{
                                        left: `${leftPct}%`,
                                        width: `${Math.max(widthPct, 3)}%`,
                                        minWidth: '60px',
                                    }}
                                >
                                    <ScheduleItemCard item={item} compact onClick={onSelectItem} />
                                </div>
                            );
                        })}
                    </div>
                </div>
            ))}
        </div>
    );
};
