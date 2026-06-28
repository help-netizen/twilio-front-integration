/**
 * useWeekJobCounts — per-day job counts for the mobile week strip.
 *
 * Fetches the visible 7-day range with the same filters the day-agenda uses,
 * applies the same client-side provider/tag filter, and buckets the SCHEDULED
 * items by their company-timezone day. The count under each strip day therefore
 * equals what the agenda shows when that day is tapped.
 *
 * Best-effort decoration: any error yields an empty map (the strip still
 * renders, just without counts). Mobile-only; not used on desktop.
 */

import { useEffect, useState } from 'react';
import { addDays, format } from 'date-fns';
import {
    fetchScheduleItems,
    type ScheduleFilters,
} from '../services/scheduleApi';
import { filterItemsByProviderTags } from '../services/scheduleFilters';
import { dateKeyInTZ } from '../utils/companyTime';

export interface WeekJobCounts {
    /** Map of 'yyyy-MM-dd' (company-TZ day) → number of scheduled items. */
    counts: Map<string, number>;
    loading: boolean;
}

export function useWeekJobCounts(
    weekStart: Date,
    filters: Partial<ScheduleFilters>,
    timezone: string,
): WeekJobCounts {
    const [counts, setCounts] = useState<Map<string, number>>(() => new Map());
    const [loading, setLoading] = useState(false);

    const startDate = format(weekStart, 'yyyy-MM-dd');
    const endDate = format(addDays(weekStart, 6), 'yyyy-MM-dd');
    // Re-fetch whenever the visible week, the filters, or the tz change.
    const filtersKey = JSON.stringify(filters);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        fetchScheduleItems({ ...filters, startDate, endDate } as ScheduleFilters)
            .then((items) => {
                if (cancelled) return;
                const scoped = filterItemsByProviderTags(items, filters).filter(
                    (i) => i.start_at != null,
                );
                const map = new Map<string, number>();
                for (const it of scoped) {
                    const key = dateKeyInTZ(it.start_at as string, timezone);
                    map.set(key, (map.get(key) || 0) + 1);
                }
                setCounts(map);
            })
            .catch(() => {
                if (!cancelled) setCounts(new Map());
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
        // filters is captured via filtersKey (stable JSON) to avoid identity churn.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [startDate, endDate, filtersKey, timezone]);

    return { counts, loading };
}
