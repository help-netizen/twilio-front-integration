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
    fetchScheduleItems, fetchDispatchSettings, updateDispatchSettings,
    rescheduleItem, reassignItem, createFromSlot,
    loadPersistedFilters, persistFilters,
    type ScheduleItem, type DispatchSettings, type ScheduleFilters,
    type CreateFromSlotPayload,
} from '../services/scheduleApi';
import { authedFetch } from '../services/apiClient';
import { useRealtimeEvents } from './useRealtimeEvents';
import { toast } from 'sonner';

export interface ProviderInfo {
    id: string;
    name: string;
}

// ── Types ────────────────────────────────────────────────────────────────────

export type ViewMode = 'day' | 'week' | 'month' | 'timeline' | 'timeline-week' | 'list';

export interface SidebarLayer {
    type: 'schedule-item' | 'customer' | 'provider';
    data: ScheduleItem | Record<string, any>;
    title: string;
}

export interface ScheduleState {
    items: ScheduleItem[];
    settings: DispatchSettings | null;
    loading: boolean;
    error: string | null;
    currentDate: Date;
    viewMode: ViewMode;
    filters: Partial<ScheduleFilters>;
    sidebarStack: SidebarLayer[];
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
    const [viewMode, setViewMode] = useState<ViewMode>('timeline');
    const [filters, setFiltersRaw] = useState<Partial<ScheduleFilters>>(() => loadPersistedFilters());

    const setFilters = useCallback((f: Partial<ScheduleFilters>) => {
        setFiltersRaw(f);
        persistFilters(f);
    }, []);
    const [sidebarStack, setSidebarStack] = useState<SidebarLayer[]>([]);

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
            case 'timeline-week':
            case 'list': {
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

    // ── Fetch providers (once) ────────────────────────────────────────────────

    const [providers, setProviders] = useState<ProviderInfo[]>([]);

    useEffect(() => {
        authedFetch('/api/zenbooker/team-members')
            .then(r => r.json())
            .then(j => {
                const list = j.data || [];
                setProviders(list.map((p: any) => ({ id: String(p.id), name: p.name || '' })));
            })
            .catch(() => setProviders([]));
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
            const isWeekLike = viewMode === 'week' || viewMode === 'timeline-week' || viewMode === 'list';
            const fn = dir === 'next'
                ? isDayLike ? addDays : isWeekLike ? addWeeks : addMonths
                : isDayLike ? subDays : isWeekLike ? subWeeks : subMonths;
            return fn(prev, 1);
        });
    }, [viewMode]);

    // ── Sidebar stack ──────────────────────────────────────────────────────

    const pushLayer = useCallback((layer: SidebarLayer) => {
        setSidebarStack(prev => [...prev, layer]);
    }, []);

    const popLayer = useCallback(() => {
        setSidebarStack(prev => prev.length > 0 ? prev.slice(0, -1) : prev);
    }, []);

    const clearStack = useCallback(() => setSidebarStack([]), []);

    // Backward-compat: selectItem from calendar replaces entire stack with one layer
    const selectItem = useCallback((item: ScheduleItem | null) => {
        if (!item) { clearStack(); return; }
        setSidebarStack([{ type: 'schedule-item', data: item, title: item.title }]);
    }, [clearStack]);

    // Derived: top layer's item for backward compat
    const selectedItem = sidebarStack.length > 0 ? sidebarStack[sidebarStack.length - 1] : null;

    // ── Computed ─────────────────────────────────────────────────────────────

    const providerFilteredItems = useMemo(() => {
        let result = items;
        if (filters.providerIds?.length) {
            const wantUnassigned = filters.providerIds.includes('__unassigned__');
            result = result.filter(item => {
                const techs = item.assigned_techs;
                if (!techs?.length) return wantUnassigned;
                return techs.some(t => filters.providerIds!.includes(t.id || t.name));
            });
        }
        if (filters.tags?.length) {
            result = result.filter(item =>
                item.tags?.some(t => filters.tags!.includes(t)),
            );
        }
        return result;
    }, [items, filters.providerIds, filters.tags]);

    const scheduledItems = useMemo(() => providerFilteredItems.filter(i => i.start_at != null), [providerFilteredItems]);
    const unscheduledItems = useMemo(() => providerFilteredItems.filter(i => i.start_at == null), [providerFilteredItems]);

    const itemCounts = useMemo(() => {
        const counts = { total: scheduledItems.length, jobs: 0, leads: 0, tasks: 0 };
        for (const item of scheduledItems) {
            if (item.entity_type === 'job') counts.jobs++;
            else if (item.entity_type === 'lead') counts.leads++;
            else if (item.entity_type === 'task') counts.tasks++;
        }
        return counts;
    }, [scheduledItems]);

    const allTags = useMemo(() => {
        const tagSet = new Set<string>();
        for (const item of items) {
            if (item.tags) for (const t of item.tags) tagSet.add(t);
        }
        return Array.from(tagSet).sort();
    }, [items]);

    // ── Mutations ──────────────────────────────────────────────────────────

    const handleReschedule = useCallback(async (
        entityType: string, entityId: number, startAt: string, endAt: string, title?: string,
    ) => {
        // Optimistic: store previous items
        const prev = items;
        setItems(cur => cur.map(i =>
            i.entity_type === entityType && i.entity_id === entityId
                ? { ...i, start_at: startAt, end_at: endAt }
                : i,
        ));
        try {
            await rescheduleItem(entityType, entityId, startAt, endAt);
            toast.success(`${title || 'Item'} rescheduled`);
        } catch (err: any) {
            setItems(prev);
            toast.error(err.message || 'Failed to reschedule');
        }
    }, [items]);

    const handleReassign = useCallback(async (
        entityType: string, entityId: number, assigneeId: string | null, assigneeName?: string, title?: string,
    ) => {
        const prev = items;
        setItems(cur => cur.map(i => {
            if (i.entity_type !== entityType || i.entity_id !== entityId) return i;
            const newTechs = assigneeId && assigneeName
                ? [{ id: assigneeId, name: assigneeName }]
                : null;
            return { ...i, assigned_techs: newTechs };
        }));
        try {
            await reassignItem(entityType, entityId, assigneeId);
            const target = assigneeName || 'Unassigned';
            toast.success(`${title || 'Item'} reassigned to ${target}`);
        } catch (err: any) {
            setItems(prev);
            toast.error(err.message || 'Failed to reassign');
        }
    }, [items]);

    const handleCreateFromSlot = useCallback(async (payload: CreateFromSlotPayload) => {
        try {
            await createFromSlot(payload);
            toast.success(`Job "${payload.title}" created`);
            loadItems();
        } catch (err: any) {
            toast.error(err.message || 'Failed to create job');
        }
    }, [loadItems]);

    const handleUpdateSettings = useCallback(async (updates: Partial<DispatchSettings>) => {
        try {
            const updated = await updateDispatchSettings(updates);
            setSettings(updated);
            toast.success('Settings saved');
        } catch (err: any) {
            toast.error(err.message || 'Failed to save settings');
        }
    }, []);

    // ── Effective settings ───────────────────────────────────────────────────

    const effectiveSettings = settings ?? DEFAULT_SETTINGS;

    return {
        items,
        scheduledItems,
        unscheduledItems,
        itemCounts,
        allTags,
        settings: effectiveSettings,
        providers,
        loading,
        error,
        currentDate,
        viewMode,
        filters,
        selectedItem,
        sidebarStack,

        setViewMode,
        navigateDate,
        setCurrentDate,
        setFilters,
        selectItem,
        pushLayer,
        popLayer,
        clearStack,
        refresh: loadItems,
        dateRange,

        // Mutations
        handleReschedule,
        handleReassign,
        handleCreateFromSlot,
        handleUpdateSettings,
    };
}
