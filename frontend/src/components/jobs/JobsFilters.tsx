import type { JobTag } from '../../services/jobsApi';
import { Badge } from '../ui/badge';
import { SlidersHorizontal } from 'lucide-react';
import { useState, useEffect, useMemo } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { authedFetch } from '../../services/apiClient';
import type { LocalJob } from '../../services/jobsApi';
import { DateRangePickerPopover } from '../ui/DateRangePickerPopover';
import { BLANC_STATUSES } from './jobsFilterHelpers';
import { JobsFilterBody } from './JobsFilterBody';
import { useFsmStates } from '../../hooks/useFsmActions';
import { isMobileViewport } from '../../hooks/useViewportSafePosition';
import { BottomSheet } from '../ui/BottomSheet';

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
    const [dynamicJobTypes, setDynamicJobTypes] = useState<string[]>([]);
    const { data: fsmData } = useFsmStates('job', true);
    const statuses = fsmData?.states && fsmData.states.length > 0 ? fsmData.states : BLANC_STATUSES;

    useEffect(() => { authedFetch('/api/settings/lead-form').then(r => r.json()).then(data => { if (data.success && data.jobTypes?.length > 0) setDynamicJobTypes(data.jobTypes.map((jt: { name: string }) => jt.name)); }).catch(() => { }); }, []);

    const providerNames = useMemo(() => { const names = new Set<string>(); jobs.forEach(j => { if (j.assigned_techs) j.assigned_techs.forEach((t: any) => { if (t.name) names.add(t.name); }); }); return [...names].sort(); }, [jobs]);

    const activeFilterCount = statusFilter.length + providerFilter.length + sourceFilter.length + jobTypeFilter.length + tagFilter.length;

    return (
        <>
            {/* Date Range Picker */}
            <DateRangePickerPopover dateFrom={startDate} dateTo={endDate} onDateFromChange={d => onStartDateChange(d)} onDateToChange={d => onEndDateChange(d)} />

            {/* Filters: desktop = канонный Popover (тир z-150, dismiss из коробки —
                самодельный absolute z-50 + click-outside снесены, W3-аудит),
                mobile = канонный BottomSheet как и был. */}
            {(() => {
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
                return (
                    <>
                        <Popover open={dropdownOpen && !isMobile} onOpenChange={setDropdownOpen}>
                            <PopoverTrigger asChild>
                                <button
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
                            </PopoverTrigger>
                            <PopoverContent
                                align="end"
                                sideOffset={8}
                                className="p-0 rounded-xl overflow-hidden"
                                style={{ width: 'min(760px, calc(100vw - 80px))' }}
                            >
                                {filterContent}
                            </PopoverContent>
                        </Popover>
                        {dropdownOpen && isMobile && (
                            <BottomSheet open={dropdownOpen} onClose={() => setDropdownOpen(false)} title="Filters" size="standard">
                                {filterContent}
                            </BottomSheet>
                        )}
                    </>
                );
            })()}
        </>
    );
}
