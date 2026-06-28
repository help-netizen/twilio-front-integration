/**
 * WeekStrip — the mobile Schedule date picker (SCHED-MOBILE-002).
 *
 * One row of 7 day cells (Sun→Sat): weekday label, a day-of-month circle, and a
 * job-count caption. The SELECTED day is a filled accent circle; TODAY (when not
 * selected) gets a thin accent ring — so both read at a glance even on different
 * days. Tap a day to select it (loads that day's agenda). Swipe left/right to
 * page weeks; swiping only changes the visible week — the selection stays put
 * until you tap.
 *
 * Mobile-only (rendered by MobileScheduleBar). Counts come from useWeekJobCounts,
 * which mirrors the agenda's provider/tag filtering so each number equals what
 * the day shows when tapped.
 */

import React, { useEffect, useRef, useState } from 'react';
import { addDays, format, isSameDay, startOfWeek } from 'date-fns';
import type { ScheduleFilters } from '../../services/scheduleApi';
import { useWeekJobCounts } from '../../hooks/useWeekJobCounts';
import { todayInTZ } from '../../utils/companyTime';

interface WeekStripProps {
    /** The currently-open day. */
    selectedDate: Date;
    /** Company timezone — counts + the "today" marker are computed in it. */
    timezone: string;
    /** Active schedule filters — counts reflect the same scope as the agenda. */
    filters: Partial<ScheduleFilters>;
    /** Select a day (loads its agenda). */
    onSelectDate: (d: Date) => void;
}

const WEEK_STARTS_ON = 0; // Sunday — matches the app's other week views.
const SWIPE_THRESHOLD_PX = 45;

export const WeekStrip: React.FC<WeekStripProps> = ({
    selectedDate, timezone, filters, onSelectDate,
}) => {
    const [weekStart, setWeekStart] = useState<Date>(
        () => startOfWeek(selectedDate, { weekStartsOn: WEEK_STARTS_ON }),
    );

    // Snap the visible week to contain the selected date when it changes from the
    // outside (tap-to-today on the headline, deep link). Swiping sets weekStart
    // directly without touching the selection, so this never fights a swipe.
    useEffect(() => {
        const ws = startOfWeek(selectedDate, { weekStartsOn: WEEK_STARTS_ON });
        setWeekStart((prev) => (isSameDay(prev, ws) ? prev : ws));
    }, [selectedDate]);

    const { counts } = useWeekJobCounts(weekStart, filters, timezone);

    const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    const todayKey = todayInTZ(timezone);
    const selectedKey = format(selectedDate, 'yyyy-MM-dd');

    // Horizontal-dominant swipe pages the week; vertical scroll is preserved
    // (we only decide on touchend, never preventDefault). A swipe must NOT also
    // select a day, so when one fires we swallow the synthesized click that the
    // browser dispatches to the cell the touch ended on.
    const touchRef = useRef<{ x: number; y: number } | null>(null);
    const swipedRef = useRef(false);
    const onTouchStart = (e: React.TouchEvent) => {
        const t = e.touches[0];
        touchRef.current = { x: t.clientX, y: t.clientY };
        swipedRef.current = false;
    };
    const onTouchEnd = (e: React.TouchEvent) => {
        const start = touchRef.current;
        touchRef.current = null;
        if (!start) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        if (Math.abs(dx) > SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy) * 1.4) {
            swipedRef.current = true; // consumed by the cell's onClick guard
            setWeekStart((ws) => addDays(ws, dx < 0 ? 7 : -7));
        }
    };

    const selectDay = (day: Date) => {
        if (swipedRef.current) { swipedRef.current = false; return; }
        onSelectDate(day);
    };

    return (
        <div
            className="flex items-stretch gap-1 mt-3 select-none"
            style={{ touchAction: 'pan-y' }}
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
        >
            {days.map((day) => {
                const key = format(day, 'yyyy-MM-dd');
                const isSelected = key === selectedKey;
                const isToday = key === todayKey;
                const count = counts.get(key) || 0;
                return (
                    <button
                        key={key}
                        type="button"
                        onClick={() => selectDay(day)}
                        aria-pressed={isSelected}
                        aria-label={`${format(day, 'EEEE, MMM d')}${count ? `, ${count} job${count === 1 ? '' : 's'}` : ', no jobs'}`}
                        className="flex-1 flex flex-col items-center gap-1.5 py-1.5 rounded-2xl transition-opacity hover:opacity-90"
                        style={{ background: 'transparent', border: 0 }}
                    >
                        <span
                            className="text-[11px] font-semibold uppercase leading-none"
                            style={{ letterSpacing: '0.04em', color: isToday ? 'var(--sched-job)' : 'var(--sched-ink-3)' }}
                        >
                            {format(day, 'EEE')}
                        </span>
                        <span
                            className="inline-flex items-center justify-center text-[15px] font-bold"
                            style={{
                                width: 38,
                                height: 38,
                                borderRadius: '999px',
                                background: isSelected ? 'var(--sched-job)' : 'transparent',
                                color: isSelected ? '#fff' : isToday ? 'var(--sched-job)' : 'var(--sched-ink-1)',
                                border: !isSelected && isToday ? '1.5px solid var(--sched-job)' : '1.5px solid transparent',
                                boxShadow: isSelected ? '0 6px 16px rgba(47, 99, 216, 0.30)' : 'none',
                                transition: 'background 120ms ease, color 120ms ease',
                            }}
                        >
                            {format(day, 'd')}
                        </span>
                        <span
                            className="text-[11px] font-semibold leading-none"
                            style={{
                                color: count > 0
                                    ? (isSelected ? 'var(--sched-job)' : 'var(--sched-ink-2)')
                                    : 'var(--sched-ink-3)',
                                opacity: count > 0 ? 1 : 0.45,
                            }}
                        >
                            {count > 0 ? count : '·'}
                        </span>
                    </button>
                );
            })}
        </div>
    );
};
