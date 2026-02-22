import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import { Label } from '../ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Calendar } from '../ui/calendar';
import { Badge } from '../ui/badge';
import { CalendarIcon, Search, X, Check } from 'lucide-react';
import { format } from 'date-fns';
import { useState, useRef, useEffect, useMemo } from 'react';
import { JOB_SOURCES, JOB_TYPES } from '../../types/lead';
import type { LocalJob } from '../../services/jobsApi';

/* ─── Constants ─────────────────────────────── */

const BLANC_STATUSES = [
    'Submitted',
    'Waiting for parts',
    'Follow Up with Client',
    'Visit completed',
    'Job is Done',
    'Rescheduled',
    'Canceled',
];

/* ─── Props ──────────────────────────────────── */

interface JobsFiltersProps {
    searchQuery: string;
    onSearchChange: (q: string) => void;

    statusFilter: string[];
    onStatusFilterChange: (v: string[]) => void;

    providerFilter: string[];
    onProviderFilterChange: (v: string[]) => void;

    sourceFilter: string[];
    onSourceFilterChange: (v: string[]) => void;

    jobTypeFilter: string[];
    onJobTypeFilterChange: (v: string[]) => void;

    startDate?: string;
    endDate?: string;
    onStartDateChange: (d: string | undefined) => void;
    onEndDateChange: (d: string | undefined) => void;

    onlyOpen: boolean;
    onOnlyOpenChange: (v: boolean) => void;

    /** All loaded jobs — used to extract unique provider names */
    jobs: LocalJob[];
}

/* ─── Component ──────────────────────────────── */

export function JobsFilters({
    searchQuery, onSearchChange,
    statusFilter, onStatusFilterChange,
    providerFilter, onProviderFilterChange,
    sourceFilter, onSourceFilterChange,
    jobTypeFilter, onJobTypeFilterChange,
    startDate, endDate, onStartDateChange, onEndDateChange,
    onlyOpen, onOnlyOpenChange,
    jobs,
}: JobsFiltersProps) {
    const [datePickerOpen, setDatePickerOpen] = useState(false);
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    const startDateObj = startDate ? new Date(startDate + 'T00:00:00') : undefined;

    // Derive unique provider names from loaded jobs
    const providerNames = useMemo(() => {
        const names = new Set<string>();
        jobs.forEach(j => {
            if (j.assigned_techs) {
                j.assigned_techs.forEach((t: any) => { if (t.name) names.add(t.name); });
            }
        });
        return [...names].sort();
    }, [jobs]);

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

    const toggle = (arr: string[], item: string, setter: (v: string[]) => void) => {
        setter(arr.includes(item) ? arr.filter(s => s !== item) : [...arr, item]);
    };

    const activeFilterCount =
        statusFilter.length + providerFilter.length + sourceFilter.length + jobTypeFilter.length;

    const clearAllFilters = () => {
        onStatusFilterChange([]);
        onProviderFilterChange([]);
        onSourceFilterChange([]);
        onJobTypeFilterChange([]);
    };

    const handleDateSelect = (date: Date | undefined) => {
        if (date) {
            onStartDateChange(format(date, 'yyyy-MM-dd'));
            setDatePickerOpen(false);
        }
    };

    const handleDatePreset = (days: number) => {
        const d = new Date();
        d.setDate(d.getDate() - days);
        onStartDateChange(format(d, 'yyyy-MM-dd'));
        setDatePickerOpen(false);
    };

    return (
        <div className="flex flex-wrap gap-3 items-center">
            {/* Search + Filter Dropdown */}
            <div className="relative flex-1 min-w-[200px]" ref={containerRef}>
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground z-10" />
                <Input
                    placeholder="Search by name, phone, service, address..."
                    value={searchQuery}
                    onChange={e => onSearchChange(e.target.value)}
                    onFocus={() => setDropdownOpen(true)}
                    className="pl-9"
                />

                {/* Filter Dropdown Panel */}
                {dropdownOpen && (
                    <div className="absolute top-full left-0 right-0 mt-1 bg-popover border rounded-lg shadow-lg z-50 p-0 overflow-hidden">
                        {/* Active filter badges */}
                        {activeFilterCount > 0 && (
                            <div className="flex flex-wrap gap-1.5 p-3 pb-0 items-center">
                                {statusFilter.map(s => (
                                    <Badge key={`st-${s}`} variant="secondary" className="gap-1 text-xs">
                                        {s}
                                        <X className="size-3 cursor-pointer" onClick={() => toggle(statusFilter, s, onStatusFilterChange)} />
                                    </Badge>
                                ))}
                                {providerFilter.map(s => (
                                    <Badge key={`pr-${s}`} variant="outline" className="gap-1 text-xs">
                                        {s}
                                        <X className="size-3 cursor-pointer" onClick={() => toggle(providerFilter, s, onProviderFilterChange)} />
                                    </Badge>
                                ))}
                                {sourceFilter.map(s => (
                                    <Badge key={`src-${s}`} variant="outline" className="gap-1 text-xs">
                                        {s}
                                        <X className="size-3 cursor-pointer" onClick={() => toggle(sourceFilter, s, onSourceFilterChange)} />
                                    </Badge>
                                ))}
                                {jobTypeFilter.map(t => (
                                    <Badge key={`jt-${t}`} variant="default" className="gap-1 text-xs">
                                        {t}
                                        <X className="size-3 cursor-pointer" onClick={() => toggle(jobTypeFilter, t, onJobTypeFilterChange)} />
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
                        <div className="grid grid-cols-4 divide-x p-3 gap-0">
                            <FilterColumn
                                title="STATUS"
                                items={BLANC_STATUSES}
                                selected={statusFilter}
                                onToggle={item => toggle(statusFilter, item, onStatusFilterChange)}
                            />
                            <FilterColumn
                                title="ASSIGNED PROVIDERS"
                                items={providerNames}
                                selected={providerFilter}
                                onToggle={item => toggle(providerFilter, item, onProviderFilterChange)}
                            />
                            <FilterColumn
                                title="SOURCE"
                                items={JOB_SOURCES as unknown as string[]}
                                selected={sourceFilter}
                                onToggle={item => toggle(sourceFilter, item, onSourceFilterChange)}
                            />
                            <FilterColumn
                                title="JOB TYPE"
                                items={JOB_TYPES as unknown as string[]}
                                selected={jobTypeFilter}
                                onToggle={item => toggle(jobTypeFilter, item, onJobTypeFilterChange)}
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
                        {startDateObj ? format(startDateObj, 'MMM dd, yyyy') : 'Start Date'}
                    </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                    <div className="flex">
                        <div className="border-r p-3 space-y-1">
                            <div className="text-sm font-medium mb-2">Presets</div>
                            <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => handleDatePreset(0)}>Today</Button>
                            <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => handleDatePreset(7)}>Last 7 days</Button>
                            <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => handleDatePreset(30)}>Last 30 days</Button>
                            {startDate && (
                                <Button variant="ghost" size="sm" className="w-full justify-start text-muted-foreground" onClick={() => { onStartDateChange(undefined); setDatePickerOpen(false); }}>
                                    Clear
                                </Button>
                            )}
                        </div>
                        <Calendar
                            mode="single"
                            selected={startDateObj}
                            onSelect={handleDateSelect}
                            initialFocus
                        />
                    </div>
                </PopoverContent>
            </Popover>

            {/* Only Open Toggle */}
            <div className="flex items-center gap-2 px-3 py-2 border rounded-md">
                <Switch
                    id="only-open-jobs"
                    checked={onlyOpen}
                    onCheckedChange={onOnlyOpenChange}
                />
                <Label htmlFor="only-open-jobs" className="cursor-pointer">
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
                {items.length === 0 && (
                    <div className="text-xs text-muted-foreground italic py-1">None available</div>
                )}
                {items.map(item => {
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
