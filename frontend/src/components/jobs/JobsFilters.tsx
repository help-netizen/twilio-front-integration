import type { JobTag } from '../../services/jobsApi';
import { Badge } from '../ui/badge';
import { SlidersHorizontal, X, User, Globe, Briefcase } from 'lucide-react';
import { useState, useRef, useEffect, useMemo } from 'react';
import { JOB_SOURCES } from '../../types/lead';
import { authedFetch } from '../../services/apiClient';
import type { LocalJob } from '../../services/jobsApi';
import { DateRangePickerPopover } from '../ui/DateRangePickerPopover';
import { BLANC_STATUSES, BLANC_STATUS_COLORS, FilterColumn } from './jobsFilterHelpers';
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

    const toggle = (arr: string[], item: string, setter: (v: string[]) => void) => setter(arr.includes(item) ? arr.filter(s => s !== item) : [...arr, item]);
    const activeFilterCount = statusFilter.length + providerFilter.length + sourceFilter.length + jobTypeFilter.length + tagFilter.length;
    const clearAllFilters = () => { onStatusFilterChange([]); onProviderFilterChange([]); onSourceFilterChange([]); onJobTypeFilterChange([]); onTagFilterChange([]); };
    const toggleTag = (tagId: number) => onTagFilterChange(tagFilter.includes(tagId) ? tagFilter.filter(id => id !== tagId) : [...tagFilter, tagId]);

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
                        <>
                            {activeFilterCount > 0 && <div className="flex flex-wrap gap-1.5 p-3 pb-0 items-center">{statusFilter.map(s => <Badge key={`st-${s}`} variant="outline" className="gap-1 text-xs"><span className="size-2 rounded-full" style={{ backgroundColor: BLANC_STATUS_COLORS[s] || 'var(--blanc-ink-3)' }} />{s}<X className="size-3 cursor-pointer" onClick={() => toggle(statusFilter, s, onStatusFilterChange)} /></Badge>)}{providerFilter.map(s => <Badge key={`pr-${s}`} variant="outline" className="gap-1 text-xs"><User className="size-3" style={{ color: 'var(--blanc-ink-3)' }} />{s}<X className="size-3 cursor-pointer" onClick={() => toggle(providerFilter, s, onProviderFilterChange)} /></Badge>)}{sourceFilter.map(s => <Badge key={`src-${s}`} variant="outline" className="gap-1 text-xs"><Globe className="size-3" style={{ color: 'var(--blanc-ink-3)' }} />{s}<X className="size-3 cursor-pointer" onClick={() => toggle(sourceFilter, s, onSourceFilterChange)} /></Badge>)}{jobTypeFilter.map(t => <Badge key={`jt-${t}`} variant="outline" className="gap-1 text-xs"><Briefcase className="size-3" style={{ color: 'var(--blanc-ink-3)' }} />{t}<X className="size-3 cursor-pointer" onClick={() => toggle(jobTypeFilter, t, onJobTypeFilterChange)} /></Badge>)}{tagFilter.map(id => { const tag = allTags.find(t => t.id === id); return tag ? <Badge key={`tag-${id}`} variant="outline" className="gap-1 text-xs"><span className="size-2 rounded-full" style={{ backgroundColor: tag.color }} />{tag.name}<X className="size-3 cursor-pointer" onClick={() => toggleTag(id)} /></Badge> : null; })}<button onClick={clearAllFilters} className="text-xs text-muted-foreground hover:text-foreground ml-1">Clear all</button></div>}
                            <div className="grid grid-cols-1 sm:grid-cols-5 p-3 gap-3 sm:gap-0">
                                <FilterColumn title="STATUS" items={statuses} selected={statusFilter} onToggle={item => toggle(statusFilter, item, onStatusFilterChange)} colorMap={BLANC_STATUS_COLORS} />
                                <FilterColumn title="PROVIDERS" items={providerNames} selected={providerFilter} onToggle={item => toggle(providerFilter, item, onProviderFilterChange)} />
                                <FilterColumn title="SOURCE" items={JOB_SOURCES as unknown as string[]} selected={sourceFilter} onToggle={item => toggle(sourceFilter, item, onSourceFilterChange)} />
                                <FilterColumn title="JOB TYPE" items={dynamicJobTypes} selected={jobTypeFilter} onToggle={item => toggle(jobTypeFilter, item, onJobTypeFilterChange)} />
                                <div className="px-3"><div className="text-xs font-semibold text-muted-foreground mb-2">TAGS</div><div className="space-y-1 max-h-56 overflow-y-auto">{allTags.filter(t => t.is_active).map(tag => <label key={tag.id} className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-sm transition-colors ${tagFilter.includes(tag.id) ? 'bg-primary/10 font-medium' : 'hover:bg-muted/50'}`}><input type="checkbox" checked={tagFilter.includes(tag.id)} onChange={() => toggleTag(tag.id)} className="sr-only" /><span className={`size-3 rounded-full shrink-0 border ${tagFilter.includes(tag.id) ? 'ring-2 ring-primary ring-offset-1' : ''}`} style={{ backgroundColor: tag.color }} />{tag.name}</label>)}</div></div>
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
