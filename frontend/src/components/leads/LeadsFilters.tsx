import { Switch } from '../ui/switch';
import { Badge } from '../ui/badge';
import { X, SlidersHorizontal } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import type { LeadsListParams } from '../../types/lead';
import { LEAD_STATUSES, JOB_SOURCES } from '../../types/lead';
import { useLeadFormSettings } from '../../hooks/useLeadFormSettings';
import { DateRangePickerPopover } from '../ui/DateRangePickerPopover';
import { isMobileViewport } from '../../hooks/useViewportSafePosition';

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
    const containerRef = useRef<HTMLDivElement>(null);
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

                {/* Filter Dropdown Panel */}
                {dropdownOpen && (() => {
                    const isMobile = isMobileViewport();
                    const filterContent = (
                        <>
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
                            <div className="grid grid-cols-1 sm:grid-cols-3 p-3 gap-3 sm:gap-0" style={{ borderTop: activeFilterCount > 0 ? '1px solid var(--blanc-line)' : undefined, marginTop: activeFilterCount > 0 ? 8 : 0 }}>
                                <FilterColumn title="STATUS" items={LEAD_STATUSES as unknown as string[]} selected={filters.status || []} onToggle={toggleStatus} colorMap={LEAD_STATUS_COLORS} />
                                <FilterColumn title="SOURCE" items={JOB_SOURCES as unknown as string[]} selected={sourceFilter} onToggle={toggleSource} />
                                <FilterColumn title="JOB TYPE" items={dynamicJobTypes} selected={jobTypeFilter} onToggle={toggleJobType} />
                            </div>
                        </>
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
                                width: 500,
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

/* ────────────── Lead status colors ────────────── */

const LEAD_STATUS_COLORS: Record<string, string> = {
    'Submitted':     '#3B82F6',
    'New':           '#8B5CF6',
    'Contacted':     '#1B8B63',
    'Qualified':     '#22C55E',
    'Proposal Sent': '#F59E0B',
    'Negotiation':   '#F97316',
    'Lost':          '#EF4444',
    'Converted':     '#6B7280',
};

/* ────────────── Filter Column sub-component ────────────── */

function FilterColumn({
    title,
    items,
    selected,
    onToggle,
    colorMap,
}: {
    title: string;
    items: string[];
    selected: string[];
    onToggle: (item: string) => void;
    colorMap?: Record<string, string>;
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
                    const dotColor = colorMap?.[item];
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
                            {dotColor && (
                                <span
                                    className="shrink-0 rounded-full"
                                    style={{ width: 10, height: 10, background: dotColor, opacity: isSelected ? 1 : 0.55, flexShrink: 0 }}
                                />
                            )}
                            {item}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
