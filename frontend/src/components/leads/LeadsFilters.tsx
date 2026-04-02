import { Switch } from '../ui/switch';
import { Badge } from '../ui/badge';
import { X, Check } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import type { LeadsListParams } from '../../types/lead';
import { LEAD_STATUSES, JOB_SOURCES } from '../../types/lead';
import { useLeadFormSettings } from '../../hooks/useLeadFormSettings';
import { DateRangePickerPopover } from '../ui/DateRangePickerPopover';

interface LeadsFiltersProps {
    filters: LeadsListParams;
    searchQuery: string;
    sourceFilter: string[];
    jobTypeFilter: string[];
    onFiltersChange: (filters: Partial<LeadsListParams>) => void;
    onSearchChange: (query: string) => void;
    onSourceFilterChange: (sources: string[]) => void;
    onJobTypeFilterChange: (types: string[]) => void;
}

export function LeadsFilters({
    filters,
    searchQuery,
    sourceFilter,
    jobTypeFilter,
    onFiltersChange,
    onSearchChange,
    onSourceFilterChange,
    onJobTypeFilterChange,
}: LeadsFiltersProps) {
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const { jobTypes: dynamicJobTypes } = useLeadFormSettings();

    // Close dropdown on outside click
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setDropdownOpen(false);
            }
        };
        if (dropdownOpen) {
            document.addEventListener('mousedown', handler);
        }
        return () => document.removeEventListener('mousedown', handler);
    }, [dropdownOpen]);

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
            {/* Borderless inline search — Pulse style */}
            <div className="flex-1 min-w-0 relative" ref={containerRef}>
                <input
                    ref={inputRef}
                    type="text"
                    placeholder="type to find anything..."
                    value={searchQuery}
                    onChange={(e) => onSearchChange(e.target.value)}
                    onFocus={() => setDropdownOpen(true)}
                    className="pulse-search-input"
                    style={{ width: '100%' }}
                />

                {/* Filter Dropdown Panel */}
                {dropdownOpen && (
                    <div
                        className="fixed z-50 rounded-xl overflow-hidden"
                        style={{
                            background: 'var(--blanc-surface-strong)',
                            border: '1px solid var(--blanc-line)',
                            boxShadow: 'var(--blanc-shadow-main)',
                            width: Math.min(containerRef.current?.getBoundingClientRect().width || 500, 600),
                            left: containerRef.current?.getBoundingClientRect().left || 0,
                            top: (containerRef.current?.getBoundingClientRect().bottom || 0) + 8,
                        }}
                    >
                        {/* Active filter badges */}
                        {activeFilterCount > 0 && (
                            <div className="flex flex-wrap gap-1.5 p-3 pb-0 items-center">
                                {(filters.status || []).map(s => (
                                    <Badge key={`s-${s}`} variant="secondary" className="gap-1 text-xs">
                                        {s}
                                        <X className="size-3 cursor-pointer" onClick={() => toggleStatus(s)} />
                                    </Badge>
                                ))}
                                {sourceFilter.map(s => (
                                    <Badge key={`src-${s}`} variant="outline" className="gap-1 text-xs">
                                        {s}
                                        <X className="size-3 cursor-pointer" onClick={() => toggleSource(s)} />
                                    </Badge>
                                ))}
                                {jobTypeFilter.map(t => (
                                    <Badge key={`jt-${t}`} variant="default" className="gap-1 text-xs">
                                        {t}
                                        <X className="size-3 cursor-pointer" onClick={() => toggleJobType(t)} />
                                    </Badge>
                                ))}
                                <button
                                    onClick={clearAllFilters}
                                    className="text-xs ml-1 transition-opacity hover:opacity-70"
                                    style={{ color: 'var(--blanc-ink-3)' }}
                                >
                                    Clear all
                                </button>
                            </div>
                        )}

                        {/* Columns */}
                        <div className="grid grid-cols-3 p-3 gap-0" style={{ borderTop: activeFilterCount > 0 ? '1px solid var(--blanc-line)' : undefined, marginTop: activeFilterCount > 0 ? 8 : 0 }}>
                            <FilterColumn title="STATUS" items={LEAD_STATUSES as unknown as string[]} selected={filters.status || []} onToggle={toggleStatus} />
                            <FilterColumn title="SOURCE" items={JOB_SOURCES as unknown as string[]} selected={sourceFilter} onToggle={toggleSource} />
                            <FilterColumn title="JOB TYPE" items={dynamicJobTypes} selected={jobTypeFilter} onToggle={toggleJobType} />
                        </div>
                    </div>
                )}
            </div>

            {/* Active filter count badge — inline with other controls */}
            {activeFilterCount > 0 && (
                <Badge variant="secondary" className="gap-1 shrink-0">
                    {activeFilterCount} filter{activeFilterCount > 1 ? 's' : ''}
                    <X className="size-3 cursor-pointer" onClick={clearAllFilters} />
                </Badge>
            )}

            {/* Date Range Picker */}
            <DateRangePickerPopover
                dateFrom={filters.start_date}
                dateTo={filters.end_date}
                onDateFromChange={(d) => onFiltersChange({ start_date: d })}
                onDateToChange={(d) => onFiltersChange({ end_date: d })}
            />

            {/* Only Open Toggle */}
            <div
                className="flex items-center gap-2.5 px-4 shrink-0"
                style={{ minHeight: 42, borderRadius: 14, border: '1px solid rgba(104, 95, 80, 0.14)', background: 'var(--blanc-surface-strong)', boxShadow: 'rgba(48, 39, 28, 0.06) 0px 6px 16px' }}
            >
                <Switch
                    id="only-open"
                    checked={filters.only_open}
                    onCheckedChange={(checked) => onFiltersChange({ only_open: checked })}
                />
                <label htmlFor="only-open" className="cursor-pointer text-sm font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>
                    Only Open
                </label>
            </div>
        </>
    );
}

/* ────────────── Filter Column sub-component ────────────── */

function FilterColumn({
    title,
    items,
    selected,
    onToggle,
}: {
    title: string;
    items: string[];
    selected: string[];
    onToggle: (item: string) => void;
}) {
    return (
        <div className="px-3 space-y-1">
            <div
                className="text-[11px] font-semibold tracking-wider uppercase mb-2"
                style={{ color: 'var(--blanc-ink-3)', letterSpacing: '0.08em' }}
            >
                {title}
            </div>
            <div className="space-y-0.5 max-h-[240px] overflow-y-auto">
                {items.map((item) => {
                    const isSelected = selected.includes(item);
                    return (
                        <button
                            key={item}
                            type="button"
                            onClick={() => onToggle(item)}
                            className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-lg text-sm transition-colors"
                            style={{
                                background: isSelected ? 'rgba(37, 99, 235, 0.08)' : undefined,
                                color: isSelected ? 'var(--blanc-info)' : 'var(--blanc-ink-1)',
                                fontWeight: isSelected ? 500 : 400,
                            }}
                        >
                            <div
                                className="size-4 border rounded flex items-center justify-center shrink-0"
                                style={{
                                    borderColor: isSelected ? 'var(--blanc-info)' : 'var(--blanc-line)',
                                    background: isSelected ? 'var(--blanc-info)' : 'transparent',
                                }}
                            >
                                {isSelected && <Check className="size-3 text-white" />}
                            </div>
                            {item}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
