import { Switch } from '../ui/switch';
import { Badge } from '../ui/badge';
import { SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import type { LeadsListParams } from '../../types/lead';
import { LEAD_STATUSES } from '../../types/lead';
import { useFsmStates } from '../../hooks/useFsmActions';
import { useLeadFormSettings } from '../../hooks/useLeadFormSettings';
import { DateRangePickerPopover } from '../ui/DateRangePickerPopover';
import { isMobileViewport } from '../../hooks/useViewportSafePosition';
import { BottomSheet } from '../ui/BottomSheet';
import { LeadsFilterBody } from './LeadsFilterBody';

interface LeadsFiltersProps {
    filters: LeadsListParams;
    sourceFilter: string[];
    jobTypeFilter: string[];
    onFiltersChange: (filters: Partial<LeadsListParams>) => void;
    onSourceFilterChange: (sources: string[]) => void;
    onJobTypeFilterChange: (types: string[]) => void;
}

export function LeadsFilters({
    filters,
    sourceFilter,
    jobTypeFilter,
    onFiltersChange,
    onSourceFilterChange,
    onJobTypeFilterChange,
}: LeadsFiltersProps) {
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const { jobTypes: dynamicJobTypes } = useLeadFormSettings();
    const { data: fsmData } = useFsmStates('lead', true);
    const statuses = fsmData?.states && fsmData.states.length > 0 ? fsmData.states : LEAD_STATUSES as unknown as string[];

    const toggleStatus = (status: string) => {
        const current = filters.status || [];
        const updated = current.includes(status)
            ? current.filter(s => s !== status)
            : [...current, status];
        onFiltersChange({ status: updated });
    };

    const toggleSource = (source: string) => {
        const updated = sourceFilter.includes(source)
            ? sourceFilter.filter(s => s !== source)
            : [...sourceFilter, source];
        onSourceFilterChange(updated);
    };

    const toggleJobType = (type: string) => {
        const updated = jobTypeFilter.includes(type)
            ? jobTypeFilter.filter(t => t !== type)
            : [...jobTypeFilter, type];
        onJobTypeFilterChange(updated);
    };

    const activeFilterCount =
        (filters.status?.length || 0) + sourceFilter.length + jobTypeFilter.length;

    const clearAllFilters = () => {
        onFiltersChange({ status: [] });
        onSourceFilterChange([]);
        onJobTypeFilterChange([]);
    };

    return (
        <>
            {/* Date Range Picker */}
            <DateRangePickerPopover
                dateFrom={filters.start_date}
                dateTo={filters.end_date}
                onDateFromChange={(d) => onFiltersChange({ start_date: d })}
                onDateToChange={(d) => onFiltersChange({ end_date: d })}
            />

            {/* Only Open Toggle — единый тулбар-чип (.blanc-control-chip), не самодельный pill */}
            <div className="blanc-control-chip flex items-center gap-2.5 shrink-0" style={{ cursor: 'default' }}>
                <Switch
                    id="only-open"
                    checked={filters.only_open}
                    onCheckedChange={(checked) => onFiltersChange({ only_open: checked })}
                />
                <label htmlFor="only-open" className="cursor-pointer text-sm font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>
                    Only Open
                </label>
            </div>

            {/* Filters: desktop = канонный Popover (тир z-150, dismiss из коробки —
                самодельный absolute z-50 + click-outside снесены, W3-аудит),
                mobile = канонный BottomSheet как и был. */}
            {(() => {
                const isMobile = isMobileViewport();
                const filterContent = (
                    <LeadsFilterBody
                        statusFilter={filters.status || []} onToggleStatus={toggleStatus}
                        sourceFilter={sourceFilter} onToggleSource={toggleSource}
                        jobTypeFilter={jobTypeFilter} onToggleJobType={toggleJobType}
                        statuses={statuses}
                        dynamicJobTypes={dynamicJobTypes}
                        onClearAll={clearAllFilters}
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
                                style={{ width: 500 }}
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
