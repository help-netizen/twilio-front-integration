/**
 * JOBS-HEADER-QUICKFILTERS-001 — the quick-filter segmented control (Jobs header, row 2).
 * Applies a preset over the shared filter state; the active chip is derived, so tweaking
 * a filter in the Filters panel simply de-highlights it. See jobsQuickFilters.ts.
 */
import {
    QUICK_FILTERS, buildPreset, detectActiveQuickFilter, todayIso,
    type QuickFilterState,
} from './jobsQuickFilterPresets';
import { BLANC_STATUSES } from './jobsFilterHelpers';
import { useFsmStates } from '../../hooks/useFsmActions';

interface JobsQuickFiltersProps {
    statusFilter: string[];
    startDate?: string;
    endDate?: string;
    sortBy: string;
    sortOrder: 'asc' | 'desc';
    paymentStatus?: 'unpaid';
    onApply: (preset: QuickFilterState) => void;
}

export function JobsQuickFilters({
    statusFilter, startDate, endDate, sortBy, sortOrder, paymentStatus, onApply,
}: JobsQuickFiltersProps) {
    // Same status source as the Filters panel (FSM states or BLANC fallback) so a preset's
    // "active statuses" match exactly what appears checked in Filters. React Query dedupes
    // this with JobsFilters' identical call.
    const { data: fsmData } = useFsmStates('job', true);
    const statuses = fsmData?.states && fsmData.states.length > 0 ? fsmData.states : BLANC_STATUSES;
    const today = todayIso();
    const active = detectActiveQuickFilter(
        { statusFilter, startDate, endDate, sortBy, sortOrder, paymentStatus },
        statuses, today,
    );

    return (
        <div className="blanc-quick-filters" role="tablist" aria-label="Quick filters">
            {QUICK_FILTERS.map(({ key, label }) => (
                <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={active === key}
                    className={`blanc-quick-chip${active === key ? ' active' : ''}`}
                    onClick={() => onApply(buildPreset(key, statuses, today))}
                >
                    {label}
                </button>
            ))}
        </div>
    );
}
