import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import { Label } from '../ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Calendar } from '../ui/calendar';
import { Badge } from '../ui/badge';
import { CalendarIcon, Search, X, Check } from 'lucide-react';
import { format } from 'date-fns';
import { useState, useRef, useEffect } from 'react';
import type { LeadsListParams } from '../../types/lead';
import { LEAD_STATUSES, JOB_SOURCES } from '../../types/lead';
import { authedFetch } from '../../services/apiClient';

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
    const [datePickerOpen, setDatePickerOpen] = useState(false);
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const [dynamicJobTypes, setDynamicJobTypes] = useState<string[]>([]);

    const startDate = filters.start_date ? new Date(filters.start_date) : undefined;

    // Fetch job types from API
    useEffect(() => {
        authedFetch('/api/settings/lead-form')
            .then(r => r.json())
            .then(data => {
                if (data.success && data.jobTypes?.length > 0) {
                    setDynamicJobTypes(data.jobTypes.map((jt: { name: string }) => jt.name));
                }
            })
            .catch(() => { });
    }, []);

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

    const handleDateSelect = (date: Date | undefined) => {
        if (date) {
            onFiltersChange({ start_date: format(date, 'yyyy-MM-dd') });
            setDatePickerOpen(false);
        }
    };

    const handleDatePreset = (days: number) => {
        const date = new Date();
        date.setDate(date.getDate() - days);
        onFiltersChange({ start_date: format(date, 'yyyy-MM-dd') });
        setDatePickerOpen(false);
    };

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
        <div className="flex flex-wrap gap-3 items-center">
            {/* Search + Filter Dropdown */}
            <div className="relative flex-1 min-w-[200px]" ref={containerRef}>
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground z-10" />
                <Input
                    placeholder="Search by name, phone, email, ID..."
                    value={searchQuery}
                    onChange={(e) => onSearchChange(e.target.value)}
                    onFocus={() => setDropdownOpen(true)}
                    className="pl-9"
                />

                {/* Filter Dropdown Panel */}
                {dropdownOpen && (
                    <div className="absolute top-full left-0 right-0 mt-1 bg-popover border rounded-lg shadow-lg z-50 p-0 overflow-hidden">
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
                                    className="text-xs text-muted-foreground hover:text-foreground ml-1"
                                >
                                    Clear all
                                </button>
                            </div>
                        )}

                        {/* Columns */}
                        <div className="grid grid-cols-3 divide-x p-3 gap-0">
                            {/* Status Column */}
                            <FilterColumn
                                title="STATUS"
                                items={LEAD_STATUSES as unknown as string[]}
                                selected={filters.status || []}
                                onToggle={toggleStatus}
                            />

                            {/* Source Column */}
                            <FilterColumn
                                title="SOURCE"
                                items={JOB_SOURCES as unknown as string[]}
                                selected={sourceFilter}
                                onToggle={toggleSource}
                            />

                            {/* Job Type Column */}
                            <FilterColumn
                                title="JOB TYPE"
                                items={dynamicJobTypes}
                                selected={jobTypeFilter}
                                onToggle={toggleJobType}
                            />
                        </div>
                    </div>
                )}
            </div>

            {/* Active filter count badge */}
            {activeFilterCount > 0 && (
                <Badge variant="secondary" className="gap-1">
                    {activeFilterCount} filter{activeFilterCount > 1 ? 's' : ''}
                    <X className="size-3 cursor-pointer" onClick={clearAllFilters} />
                </Badge>
            )}

            {/* Date Range Picker */}
            <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
                <PopoverTrigger asChild>
                    <Button variant="outline" className="gap-2">
                        <CalendarIcon className="size-4" />
                        {startDate
                            ? `${format(startDate, 'MMM dd, yyyy')} — ${format(new Date(), 'MMM dd, yyyy')}`
                            : 'Start Date'}
                    </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                    <div className="flex">
                        <div className="border-r p-3 space-y-1">
                            <div className="text-sm font-medium mb-2">Presets</div>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="w-full justify-start"
                                onClick={() => handleDatePreset(0)}
                            >
                                Today
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="w-full justify-start"
                                onClick={() => handleDatePreset(7)}
                            >
                                Last 7 days
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="w-full justify-start"
                                onClick={() => handleDatePreset(30)}
                            >
                                Last 30 days
                            </Button>
                        </div>
                        <Calendar
                            mode="single"
                            selected={startDate}
                            onSelect={handleDateSelect}
                            initialFocus
                        />
                    </div>
                </PopoverContent>
            </Popover>

            {/* Only Open Toggle */}
            <div className="flex items-center gap-2 px-3 py-2 border rounded-md">
                <Switch
                    id="only-open"
                    checked={filters.only_open}
                    onCheckedChange={(checked) => onFiltersChange({ only_open: checked })}
                />
                <Label htmlFor="only-open" className="cursor-pointer">
                    Only Open
                </Label>
            </div>
        </div>
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
            <div className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase mb-2">
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
                            className={`flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md text-sm transition-colors ${isSelected
                                ? 'bg-primary/10 text-primary font-medium'
                                : 'hover:bg-muted text-foreground'
                                }`}
                        >
                            <div className={`size-4 border rounded flex items-center justify-center shrink-0 ${isSelected ? 'bg-primary border-primary' : 'border-input'
                                }`}>
                                {isSelected && <Check className="size-3 text-primary-foreground" />}
                            </div>
                            {item}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
