/**
 * useScheduleData — Schedule page state & data-fetching hook.
 * Timezone-aware navigation, SSE realtime refresh.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
    startOfWeek, endOfWeek, startOfMonth, endOfMonth,
    addDays, addWeeks, addMonths, subDays, subWeeks, subMonths,
    format,
} from 'date-fns';
import {
    fetchScheduleItems, fetchDispatchSettings,
    type ScheduleItem, type DispatchSettings, type ScheduleFilters,
} from '../services/scheduleApi';
import { useRealtimeEvents } from './useRealtimeEvents';

// ── Types ────────────────────────────────────────────────────────────────────

export type ViewMode = 'day' | 'week' | 'month' | 'timeline' | 'timeline-week';

export interface ScheduleState {
    items: ScheduleItem[];
    settings: DispatchSettings | null;
    loading: boolean;
    error: string | null;
    currentDate: Date;
    viewMode: ViewMode;
    filters: Partial<ScheduleFilters>;
    selectedItem: ScheduleItem | null;
}

const DEFAULT_SETTINGS: DispatchSettings = {
    timezone: 'America/New_York',
    work_start_time: '08:00',
    work_end_time: '18:00',
    work_days: [1, 2, 3, 4, 5],
    slot_duration: 60,
};

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useScheduleData() {
    const [items, setItems] = useState<ScheduleItem[]>([]);
    const [settings, setSettings] = useState<DispatchSettings | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [currentDate, setCurrentDate] = useState<Date>(new Date());
    const [viewMode, setViewMode] = useState<ViewMode>('week');
    const [filters, setFilters] = useState<Partial<ScheduleFilters>>({});
    const [selectedItem, setSelectedItem] = useState<ScheduleItem | null>(null);

    // ── Date range derived from viewMode + currentDate ───────────────────────

    const dateRange = useMemo(() => {
        switch (viewMode) {
            case 'day':
            case 'timeline':
                return {
                    startDate: format(currentDate, 'yyyy-MM-dd'),
                    endDate: format(currentDate, 'yyyy-MM-dd'),
                };
            case 'week':
            case 'timeline-week': {
                const start = startOfWeek(currentDate, { weekStartsOn: 0 });
                const end = endOfWeek(currentDate, { weekStartsOn: 0 });
                return {
                    startDate: format(start, 'yyyy-MM-dd'),
                    endDate: format(end, 'yyyy-MM-dd'),
                };
            }
            case 'month': {
                const start = startOfMonth(currentDate);
                const end = endOfMonth(currentDate);
                return {
                    startDate: format(start, 'yyyy-MM-dd'),
                    endDate: format(end, 'yyyy-MM-dd'),
                };
            }
        }
    }, [viewMode, currentDate]);

    // ── Fetch items ──────────────────────────────────────────────────────────

    const loadItems = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await fetchScheduleItems({
                ...dateRange,
                ...filters,
            } as ScheduleFilters);
            setItems(data);
        } catch (err: any) {
            setError(err.message || 'Failed to load schedule');
            setItems([]);
        } finally {
            setLoading(false);
        }
    }, [dateRange, filters]);

    useEffect(() => { loadItems(); }, [loadItems]);

    // ── Fetch settings (once) ────────────────────────────────────────────────

    useEffect(() => {
        fetchDispatchSettings()
            .then(setSettings)
            .catch(() => setSettings(DEFAULT_SETTINGS));
    }, []);

    // ── SSE Realtime refresh (debounced) ─────────────────────────────────────

    const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const debouncedRefresh = useCallback(() => {
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = setTimeout(() => {
            loadItems();
        }, 500);
    }, [loadItems]);

    useRealtimeEvents({
        onJobUpdated: debouncedRefresh,
        onGenericEvent: (event: any) => {
            // Refresh on lead/task updates
            const type = event?.type || '';
            if (type.includes('lead') || type.includes('task')) {
                debouncedRefresh();
            }
        },
    });

    // Cleanup timer on unmount
    useEffect(() => {
        return () => {
            if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        };
    }, []);

    // ── Navigation ───────────────────────────────────────────────────────────

    const navigateDate = useCallback((dir: 'prev' | 'next' | 'today') => {
        if (dir === 'today') { setCurrentDate(new Date()); return; }
        setCurrentDate(prev => {
            const isDayLike = viewMode === 'day' || viewMode === 'timeline';
            const isWeekLike = viewMode === 'week' || viewMode === 'timeline-week';
            const fn = dir === 'next'
                ? isDayLike ? addDays : isWeekLike ? addWeeks : addMonths
                : isDayLike ? subDays : isWeekLike ? subWeeks : subMonths;
            return fn(prev, 1);
        });
    }, [viewMode]);

    // ── Selection ────────────────────────────────────────────────────────────

    const selectItem = useCallback((item: ScheduleItem | null) => {
        setSelectedItem(item);
    }, []);

    const clearSelection = useCallback(() => setSelectedItem(null), []);

    // ── Computed ─────────────────────────────────────────────────────────────

    const scheduledItems = useMemo(() => items.filter(i => i.start_at != null), [items]);
    const unscheduledItems = useMemo(() => items.filter(i => i.start_at == null), [items]);

    // ── Effective settings ───────────────────────────────────────────────────

    const effectiveSettings = settings ?? DEFAULT_SETTINGS;

    return {
        items,
        scheduledItems,
        unscheduledItems,
        settings: effectiveSettings,
        loading,
        error,
        currentDate,
        viewMode,
        filters,
        selectedItem,

        setViewMode,
        navigateDate,
        setCurrentDate,
        setFilters,
        selectItem,
        clearSelection,
        refresh: loadItems,
        dateRange,
    };
}
