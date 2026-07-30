/**
 * JOBS-HEADER-QUICKFILTERS-001 — the four Jobs quick-filter presets.
 *
 * Each chip applies a preset over the SAME filter state the Filters panel binds to,
 * so a preset is just a starting point the user can then tweak (status/date/sort in
 * Filters, Due via the Payment toggle). The active chip is DERIVED from the current
 * state, so editing a filter away from a preset simply de-highlights the chip.
 *
 *   All Jobs — newest→oldest, every job.
 *   Upcoming — today onward, active statuses (all except Canceled / Job is Done), oldest-first.
 *   Past     — today and earlier, active statuses, newest-first.
 *   Not Paid — outstanding Due, every status, newest→oldest.
 */

export type QuickFilterKey = 'all' | 'upcoming' | 'past' | 'unpaid';

export const QUICK_FILTERS: { key: QuickFilterKey; label: string }[] = [
    { key: 'all', label: 'All Jobs' },
    { key: 'upcoming', label: 'Upcoming' },
    { key: 'past', label: 'Past' },
    { key: 'unpaid', label: 'Not Paid' },
];

/** The mutable slice of jobs-list state a preset controls. */
export interface QuickFilterState {
    statusFilter: string[];
    startDate?: string;
    endDate?: string;
    sortBy: string;
    sortOrder: 'asc' | 'desc';
    paymentStatus?: 'unpaid';
}

/** Local YYYY-MM-DD for "today" (server compares start_date by date). */
export function todayIso(now: Date = new Date()): string {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/** Active = every offered status except the two terminal ones. */
export function activeStatusesOf(allStatuses: string[]): string[] {
    return allStatuses.filter(s => s !== 'Canceled' && s !== 'Job is Done');
}

export function buildPreset(key: QuickFilterKey, allStatuses: string[], today: string): QuickFilterState {
    const active = activeStatusesOf(allStatuses);
    switch (key) {
        case 'upcoming':
            return { statusFilter: active, startDate: today, endDate: undefined, sortBy: 'start_date', sortOrder: 'asc', paymentStatus: undefined };
        case 'past':
            return { statusFilter: active, startDate: undefined, endDate: today, sortBy: 'start_date', sortOrder: 'desc', paymentStatus: undefined };
        case 'unpaid':
            return { statusFilter: [], startDate: undefined, endDate: undefined, sortBy: 'start_date', sortOrder: 'desc', paymentStatus: 'unpaid' };
        case 'all':
        default:
            return { statusFilter: [], startDate: undefined, endDate: undefined, sortBy: 'start_date', sortOrder: 'desc', paymentStatus: undefined };
    }
}

function sameStatusSet(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const set = new Set(a);
    return b.every(s => set.has(s));
}

function matchesPreset(state: QuickFilterState, preset: QuickFilterState): boolean {
    return sameStatusSet(state.statusFilter, preset.statusFilter)
        && (state.startDate || undefined) === preset.startDate
        && (state.endDate || undefined) === preset.endDate
        && state.sortBy === preset.sortBy
        && state.sortOrder === preset.sortOrder
        && (state.paymentStatus || undefined) === preset.paymentStatus;
}

/**
 * Which chip (if any) exactly matches the current state. Checked in priority order so
 * the more specific presets win before the catch-all 'all'.
 */
export function detectActiveQuickFilter(state: QuickFilterState, allStatuses: string[], today: string): QuickFilterKey | null {
    for (const key of ['unpaid', 'upcoming', 'past', 'all'] as QuickFilterKey[]) {
        if (matchesPreset(state, buildPreset(key, allStatuses, today))) return key;
    }
    return null;
}
