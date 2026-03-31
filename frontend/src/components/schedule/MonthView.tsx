/**
 * MonthView — Calendar month grid with item counts and preview titles.
 */

import React, { useMemo } from 'react';
import {
    startOfMonth, endOfMonth, startOfWeek, endOfWeek,
    addDays, format, isSameMonth,
} from 'date-fns';
import { Badge } from '../ui/badge';
import type { ScheduleItem, DispatchSettings } from '../../services/scheduleApi';
import { todayInTZ, dateKeyInTZ } from '../../utils/companyTime';

interface MonthViewProps {
    currentDate: Date;
    items: ScheduleItem[];
    settings: DispatchSettings;
    onSelectDay: (date: Date) => void;
    onSelectItem: (item: ScheduleItem) => void;
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const MonthView: React.FC<MonthViewProps> = ({ currentDate, items, settings, onSelectDay, onSelectItem }) => {
    const tz = settings.timezone || 'America/New_York';
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

    // Group items by day (company TZ)
    const itemsByDay = useMemo(() => {
        const map = new Map<string, ScheduleItem[]>();
        for (const item of items) {
            if (!item.start_at) continue;
            const key = dateKeyInTZ(item.start_at, tz);
            if (!map.has(key)) map.set(key, []);
            map.get(key)!.push(item);
        }
        return map;
    }, [items, tz]);

    const todayStr = todayInTZ(tz);

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
            {/* Weekday headers */}
            <div className="grid grid-cols-7 sticky top-0 z-10" style={{
                borderBottom: '1px solid var(--sched-line)',
                background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.66), rgba(244, 237, 226, 0.42))',
            }}>
                {WEEKDAY_LABELS.map(label => (
                    <div key={label} className="text-center py-3 text-[11px] font-semibold uppercase" style={{
                        borderRight: '1px solid var(--sched-line)',
                        color: 'var(--sched-ink-3)',
                        letterSpacing: '0.14em',
                    }}>
                        {label}
                    </div>
                ))}
            </div>

            {/* Week rows */}
            <div className="flex-1">
                {weeks.map((week, wi) => (
                    <div key={wi} className="grid grid-cols-7" style={{ borderBottom: '1px solid var(--sched-line)' }}>
                        {week.map(day => {
                            const key = format(day, 'yyyy-MM-dd');
                            const dayItems = itemsByDay.get(key) || [];
                            const inMonth = isSameMonth(day, currentDate);
                            const isToday = key === todayStr;
                            const jobCount = dayItems.filter(i => i.entity_type === 'job').length;
                            const leadCount = dayItems.filter(i => i.entity_type === 'lead').length;
                            const taskCount = dayItems.filter(i => i.entity_type === 'task').length;

                            return (
                                <button
                                    key={key}
                                    type="button"
                                    onClick={() => onSelectDay(day)}
                                    className="min-h-24 p-1.5 text-left flex flex-col items-start transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-offset-1 outline-none"
                                    style={{
                                        borderRight: '1px solid var(--sched-line)',
                                        background: isToday
                                            ? 'var(--sched-today-soft)'
                                            : !inMonth
                                                ? 'rgba(239, 233, 223, 0.3)'
                                                : 'transparent',
                                    }}
                                    onMouseEnter={(e) => { if (!isToday) (e.currentTarget as HTMLElement).style.background = 'rgba(252, 249, 244, 0.6)'; }}
                                    onMouseLeave={(e) => { if (!isToday) (e.currentTarget as HTMLElement).style.background = !inMonth ? 'rgba(239, 233, 223, 0.3)' : 'transparent'; }}
                                >
                                    <div className="text-sm mb-1" style={{
                                        ...(isToday ? {
                                            background: 'var(--sched-job)',
                                            color: '#fff',
                                            borderRadius: '50%',
                                            width: '28px',
                                            height: '28px',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            fontWeight: 700,
                                            fontFamily: 'Manrope, sans-serif',
                                        } : {
                                            color: !inMonth ? 'var(--sched-ink-3)' : 'var(--sched-ink-1)',
                                            opacity: !inMonth ? 0.4 : 1,
                                        }),
                                    }}>
                                        {format(day, 'd')}
                                    </div>

                                    {/* Count badges */}
                                    {dayItems.length > 0 && (
                                        <div className="flex flex-wrap gap-0.5 mb-1">
                                            {jobCount > 0 && <Badge variant="outline" className="text-[10px] px-1 py-0" style={{ background: 'var(--sched-job-soft)', color: 'var(--sched-job)', borderColor: 'rgba(47, 99, 216, 0.2)' }}>{jobCount} job{jobCount > 1 ? 's' : ''}</Badge>}
                                            {leadCount > 0 && <Badge variant="outline" className="text-[10px] px-1 py-0" style={{ background: 'var(--sched-lead-soft)', color: 'var(--sched-lead)', borderColor: 'rgba(178, 106, 29, 0.2)' }}>{leadCount} lead{leadCount > 1 ? 's' : ''}</Badge>}
                                            {taskCount > 0 && <Badge variant="outline" className="text-[10px] px-1 py-0" style={{ background: 'var(--sched-task-soft)', color: 'var(--sched-task)', borderColor: 'rgba(27, 139, 99, 0.2)' }}>{taskCount} task{taskCount > 1 ? 's' : ''}</Badge>}
                                        </div>
                                    )}

                                    {/* First 2 item titles */}
                                    <div className="space-y-0.5">
                                        {dayItems.slice(0, 2).map(item => (
                                            <div
                                                key={`${item.entity_type}-${item.entity_id}`}
                                                className="text-[11px] leading-tight truncate"
                                                style={{ color: 'var(--sched-ink-2)' }}
                                                onClick={e => { e.stopPropagation(); onSelectItem(item); }}
                                            >
                                                {item.title}
                                            </div>
                                        ))}
                                        {dayItems.length > 2 && (
                                            <div className="text-[10px]" style={{ color: 'var(--sched-ink-3)' }}>
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
