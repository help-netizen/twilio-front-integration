/**
 * MonthView — Calendar month grid with item counts and preview titles.
 */

import React, { useMemo } from 'react';
import {
    startOfMonth, endOfMonth, startOfWeek, endOfWeek,
    addDays, format, parseISO, isSameMonth, isSameDay,
} from 'date-fns';
import { Badge } from '../ui/badge';
import type { ScheduleItem } from '../../services/scheduleApi';

interface MonthViewProps {
    currentDate: Date;
    items: ScheduleItem[];
    onSelectDay: (date: Date) => void;
    onSelectItem: (item: ScheduleItem) => void;
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const MonthView: React.FC<MonthViewProps> = ({ currentDate, items, onSelectDay, onSelectItem }) => {
    // Build grid of weeks
    const weeks = useMemo(() => {
        const monthStart = startOfMonth(currentDate);
        const monthEnd = endOfMonth(currentDate);
        const gridStart = startOfWeek(monthStart, { weekStartsOn: 0 });
        const gridEnd = endOfWeek(monthEnd, { weekStartsOn: 0 });

        const result: Date[][] = [];
        let day = gridStart;
        while (day <= gridEnd) {
            const week: Date[] = [];
            for (let i = 0; i < 7; i++) {
                week.push(day);
                day = addDays(day, 1);
            }
            result.push(week);
        }
        return result;
    }, [currentDate]);

    // Group items by day
    const itemsByDay = useMemo(() => {
        const map = new Map<string, ScheduleItem[]>();
        for (const item of items) {
            if (!item.start_at) continue;
            const key = format(parseISO(item.start_at), 'yyyy-MM-dd');
            if (!map.has(key)) map.set(key, []);
            map.get(key)!.push(item);
        }
        return map;
    }, [items]);

    const today = new Date();

    return (
        <div className="flex flex-col flex-1 overflow-auto">
            {/* Weekday headers */}
            <div className="grid grid-cols-7 border-b sticky top-0 bg-white z-10">
                {WEEKDAY_LABELS.map(label => (
                    <div key={label} className="text-center py-2 text-xs font-medium text-gray-500 uppercase border-r last:border-r-0">
                        {label}
                    </div>
                ))}
            </div>

            {/* Week rows */}
            <div className="flex-1">
                {weeks.map((week, wi) => (
                    <div key={wi} className="grid grid-cols-7 border-b">
                        {week.map(day => {
                            const key = format(day, 'yyyy-MM-dd');
                            const dayItems = itemsByDay.get(key) || [];
                            const inMonth = isSameMonth(day, currentDate);
                            const isToday = isSameDay(day, today);
                            const jobCount = dayItems.filter(i => i.entity_type === 'job').length;
                            const leadCount = dayItems.filter(i => i.entity_type === 'lead').length;
                            const taskCount = dayItems.filter(i => i.entity_type === 'task').length;

                            return (
                                <button
                                    key={key}
                                    type="button"
                                    onClick={() => onSelectDay(day)}
                                    className={`
                                        min-h-24 p-1.5 border-r last:border-r-0 text-left
                                        hover:bg-gray-50 transition-colors cursor-pointer
                                        ${!inMonth ? 'bg-gray-50/50' : ''}
                                    `}
                                >
                                    <div className={`
                                        text-sm mb-1
                                        ${isToday ? 'bg-blue-600 text-white rounded-full w-7 h-7 flex items-center justify-center font-bold' : ''}
                                        ${!inMonth ? 'text-gray-300' : 'text-gray-700'}
                                    `}>
                                        {format(day, 'd')}
                                    </div>

                                    {/* Count badges */}
                                    {dayItems.length > 0 && (
                                        <div className="flex flex-wrap gap-0.5 mb-1">
                                            {jobCount > 0 && <Badge variant="outline" className="text-[10px] px-1 py-0 bg-blue-50 text-blue-700 border-blue-200">{jobCount} job{jobCount > 1 ? 's' : ''}</Badge>}
                                            {leadCount > 0 && <Badge variant="outline" className="text-[10px] px-1 py-0 bg-amber-50 text-amber-700 border-amber-200">{leadCount} lead{leadCount > 1 ? 's' : ''}</Badge>}
                                            {taskCount > 0 && <Badge variant="outline" className="text-[10px] px-1 py-0 bg-green-50 text-green-700 border-green-200">{taskCount} task{taskCount > 1 ? 's' : ''}</Badge>}
                                        </div>
                                    )}

                                    {/* First 2 item titles */}
                                    <div className="space-y-0.5">
                                        {dayItems.slice(0, 2).map(item => (
                                            <div
                                                key={`${item.entity_type}-${item.entity_id}`}
                                                className="text-[11px] leading-tight text-gray-600 truncate"
                                                onClick={e => { e.stopPropagation(); onSelectItem(item); }}
                                            >
                                                {item.title}
                                            </div>
                                        ))}
                                        {dayItems.length > 2 && (
                                            <div className="text-[10px] text-gray-400">
                                                +{dayItems.length - 2} more
                                            </div>
                                        )}
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                ))}
            </div>
        </div>
    );
};
