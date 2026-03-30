/**
 * TimelineWeekView — Provider rows × 7-day columns.
 * Primary dispatch view: see all providers across a full week.
 * Timezone-aware: today highlight and item grouping use company TZ.
 */

import React, { useMemo } from 'react';
import { startOfWeek, addDays, format } from 'date-fns';
import { ScheduleItemCard } from './ScheduleItemCard';
import type { ScheduleItem, DispatchSettings } from '../../services/scheduleApi';
import type { ProviderInfo } from '../../hooks/useScheduleData';
import { todayInTZ, dateKeyInTZ } from '../../utils/companyTime';

interface TimelineWeekViewProps {
    currentDate: Date;
    items: ScheduleItem[];
    settings: DispatchSettings;
    /** All company providers — show rows even if they have no items this week */
    allProviders?: ProviderInfo[];
    onSelectItem: (item: ScheduleItem) => void;
}

interface ProviderGroup {
    id: string;
    label: string;
    items: ScheduleItem[];
}

export const TimelineWeekView: React.FC<TimelineWeekViewProps> = ({ currentDate, items, settings, allProviders = [], onSelectItem }) => {
    const tz = settings.timezone || 'America/New_York';
    const weekStart = startOfWeek(currentDate, { weekStartsOn: 0 });
    const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
    const dayKeys = useMemo(() => days.map(d => format(d, 'yyyy-MM-dd')), [days]);

    // Group by provider — include ALL known providers even if they have no items this week
    const providerGroups: ProviderGroup[] = useMemo(() => {
        const map = new Map<string, ProviderGroup>();

        // Seed with all known providers (empty rows)
        for (const p of allProviders) {
            map.set(p.id, { id: p.id, label: p.name, items: [] });
        }

        // Distribute items to provider rows
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

    // Today in company TZ
    const todayStr = todayInTZ(tz);
    const isTodayCol = (dayKey: string) => dayKey === todayStr;

    return (
        <div className="flex flex-col flex-1 overflow-auto">
            {/* Day headers */}
            <div className="flex border-b sticky top-0 bg-white z-10">
                <div className="w-36 flex-shrink-0 border-r p-2 text-sm font-medium text-gray-500">
                    Provider
                </div>
                {days.map((day, i) => (
                    <div
                        key={dayKeys[i]}
                        className={`flex-1 text-center py-2 border-r text-sm font-medium ${isTodayCol(dayKeys[i]) ? 'bg-blue-50 text-blue-700' : 'text-gray-600'}`}
                    >
                        <div className="text-xs uppercase">{format(day, 'EEE')}</div>
                        <div className={`${isTodayCol(dayKeys[i]) ? 'font-bold' : ''}`}>{format(day, 'MMM d')}</div>
                    </div>
                ))}
            </div>

            {/* Provider rows */}
            {providerGroups.map(group => (
                <div key={group.id} className="flex border-b" style={{ minHeight: '72px' }}>
                    {/* Provider name */}
                    <div className="w-36 flex-shrink-0 border-r p-2 flex items-start pt-3">
                        <span className={`text-sm truncate ${group.id === '__unassigned' ? 'text-gray-400 italic' : 'text-gray-700 font-medium'}`}>
                            {group.label}
                        </span>
                    </div>
                    {/* Day cells */}
                    {days.map((day, i) => {
                        const key = dayKeys[i];
                        const cellItems = group.items.filter(
                            item => item.start_at && dateKeyInTZ(item.start_at, tz) === key,
                        );
                        return (
                            <div
                                key={key}
                                className={`flex-1 border-r p-1 space-y-1 ${isTodayCol(key) ? 'bg-blue-50/30' : ''}`}
                            >
                                {cellItems.map(item => (
                                    <ScheduleItemCard
                                        key={`${item.entity_type}-${item.entity_id}`}
                                        item={item}
                                        compact
                                        onClick={onSelectItem}
                                        timezone={tz}
                                    />
                                ))}
                            </div>
                        );
                    })}
                </div>
            ))}
        </div>
    );
};
