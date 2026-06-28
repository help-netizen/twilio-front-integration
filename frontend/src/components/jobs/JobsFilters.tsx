import type { JobTag } from '../../services/jobsApi';
import { Badge } from '../ui/badge';
import { SlidersHorizontal, X } from 'lucide-react';
import { useState, useRef, useEffect, useMemo } from 'react';
import { authedFetch } from '../../services/apiClient';
import type { LocalJob } from '../../services/jobsApi';
import { DateRangePickerPopover } from '../ui/DateRangePickerPopover';
import { BLANC_STATUSES } from './jobsFilterHelpers';
import { JobsFilterBody } from './JobsFilterBody';
import { useFsmStates } from '../../hooks/useFsmActions';
import { isMobileViewport } from '../../hooks/useViewportSafePosition';

interface JobsFiltersProps {
    statusFilter: string[]; onStatusFilterChange: (v: string[]) => void;
    providerFilter: string[]; onProviderFilterChange: (v: string[]) => void;
    sourceFilter: string[]; onSourceFilterChange: (v: string[]) => void;
    jobTypeFilter: string[]; onJobTypeFilterChange: (v: string[]) => void;
    startDate?: string; onStartDateChange: (d: string | undefined) => void;
    endDate?: string; onEndDateChange: (d: string | undefined) => void;
    tagFilter: number[]; onTagFilterChange: (v: number[]) => void; allTags: JobTag[];
    jobs: LocalJob[];
}

export function JobsFilters({ statusFilter, onStatusFilterChange, providerFilter, onProviderFilterChange, sourceFilter, onSourceFilterChange, jobTypeFilter, onJobTypeFilterChange, startDate, onStartDateChange, endDate, onEndDateChange, tagFilter, onTagFilterChange, allTags, jobs }: JobsFiltersProps) {
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const [dynamicJobTypes, setDynamicJobTypes] = useState<string[]>([]);
    const { data: fsmData } = useFsmStates('job', true);
    const statuses = fsmData?.states && fsmData.states.length > 0 ? fsmData.states : BLANC_STATUSES;

    useEffect(() => { authedFetch('/api/settings/lead-form').then(r => r.json()).then(data => { if (data.success && data.jobTypes?.length > 0) setDynamicJobTypes(data.jobTypes.map((jt: { name: string }) => jt.name)); }).catch(() => { }); }, []);

    const providerNames = useMemo(() => { const names = new Set<string>(); jobs.forEach(j => { if (j.assigned_techs) j.assigned_techs.forEach((t: any) => { if (t.name) names.add(t.name); }); }); return [...names].sort(); }, [jobs]);

    useEffect(() => { const handler = (e: MouseEvent) => { if (containerRef.current && !containerRef.current.contains(e.target as Node)) setDropdownOpen(false); }; if (dropdownOpen) document.addEventListener('mousedown', handler); return () => document.removeEventListener('mousedown', handler); }, [dropdownOpen]);

    const activeFilterCount = statusFilter.length + providerFilter.length + sourceFilter.length + jobTypeFilter.length + tagFilter.length;

    return (
        <>
            {/* Date Range Picker */}
            <DateRangePickerPopover dateFrom={startDate} dateTo={endDate} onDateFromChange={d => onStartDateChange(d)} onDateToChange={d => onEndDateChange(d)} />

            {/* Filters button + dropdown */}
            <div className="relative" ref={containerRef}>
                <button
                    onClick={() => setDropdownOpen(!dropdownOpen)}
                    className="blanc-control-chip"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                >
                    <SlidersHorizontal className="size-3.5" />
                    Filters
                    {activeFilterCount > 0 && (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 min-w-[18px] h-[18px] justify-center ml-0.5">
                            {activeFilterCount}
                        </Badge>
                    )}
                </button>

                {dropdownOpen && (() => {
                    const isMobile = isMobileViewport();
                    const filterContent = (
                        <JobsFilterBody
                            statusFilter={statusFilter} onStatusFilterChange={onStatusFilterChange}
                            providerFilter={providerFilter} onProviderFilterChange={onProviderFilterChange}
                            sourceFilter={sourceFilter} onSourceFilterChange={onSourceFilterChange}
                            jobTypeFilter={jobTypeFilter} onJobTypeFilterChange={onJobTypeFilterChange}
                            tagFilter={tagFilter} onTagFilterChange={onTagFilterChange}
                            allTags={allTags}
                            statuses={statuses}
                            providerNames={providerNames}
                            dynamicJobTypes={dynamicJobTypes}
                        />
                    );

                    if (isMobile) {
                        return (
                            <>
                                <div className="blanc-mobile-sheet-backdrop" onClick={() => setDropdownOpen(false)} />
                                <div className="blanc-mobile-sheet">
                                    <div className="blanc-mobile-sheet-header">
                                        <span className="text-sm font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>Filters</span>
                                        <button onClick={() => setDropdownOpen(false)} className="p-1.5 rounded-lg" style={{ color: 'var(--blanc-ink-3)' }}><X className="size-4" /></button>
                                    </div>
                                    {filterContent}
                                </div>
                            </>
                        );
                    }

                    return (
                        <div
                            className="absolute z-50 rounded-xl overflow-hidden"
                            style={{
                                background: 'var(--blanc-surface-strong)',
                                border: '1px solid var(--blanc-line)',
                                boxShadow: 'var(--blanc-shadow-main)',
                                width: 'min(760px, calc(100vw - 80px))',
                                right: 0,
                                top: 'calc(100% + 8px)',
                            }}
                        >
                            {filterContent}
                        </div>
                    );
                })()}
            </div>
        </>
    );
}
