import type { JobTag } from '../../services/jobsApi';
import { Badge } from '../ui/badge';
import { X, User, Globe, Briefcase } from 'lucide-react';
import { JOB_SOURCES } from '../../types/lead';
import { BLANC_STATUS_COLORS, FilterColumn } from './jobsFilterHelpers';
import { useAuthz } from '../../hooks/useAuthz';

// ─── JobsFilterBody ────────────────────────────────────────────────────────────
// The active-filter chip row + the 5 FilterColumns (STATUS / PROVIDERS / SOURCE /
// JOB TYPE / TAGS). Extracted verbatim from JobsFilters' inline `filterContent`
// so it can be reused by BOTH the desktop popover/mobile sheet (JobsFilters) and
// the mobile "View options" sheet (JobsMobileBar). Markup/behavior must stay
// identical to the previous inline version — this is a pure move-out.

interface JobsFilterBodyProps {
    statusFilter: string[]; onStatusFilterChange: (v: string[]) => void;
    providerFilter: string[]; onProviderFilterChange: (v: string[]) => void;
    sourceFilter: string[]; onSourceFilterChange: (v: string[]) => void;
    jobTypeFilter: string[]; onJobTypeFilterChange: (v: string[]) => void;
    tagFilter: number[]; onTagFilterChange: (v: number[]) => void;
    allTags: JobTag[];
    /** Statuses to offer — FSM states when available, else BLANC_STATUSES. */
    statuses: string[];
    /** Provider names derived from the current jobs list. */
    providerNames: string[];
    /** Job-type names from lead-form settings. */
    dynamicJobTypes: string[];
}

export function JobsFilterBody({
    statusFilter, onStatusFilterChange,
    providerFilter, onProviderFilterChange,
    sourceFilter, onSourceFilterChange,
    jobTypeFilter, onJobTypeFilterChange,
    tagFilter, onTagFilterChange, allTags,
    statuses, providerNames, dynamicJobTypes,
}: JobsFilterBodyProps) {
    const { hasPermission } = useAuthz();
    const canViewSource = hasPermission('lead_source.view');
    const toggle = (arr: string[], item: string, setter: (v: string[]) => void) => setter(arr.includes(item) ? arr.filter(s => s !== item) : [...arr, item]);
    const activeFilterCount = statusFilter.length + providerFilter.length + sourceFilter.length + jobTypeFilter.length + tagFilter.length;
    const clearAllFilters = () => { onStatusFilterChange([]); onProviderFilterChange([]); onSourceFilterChange([]); onJobTypeFilterChange([]); onTagFilterChange([]); };
    const toggleTag = (tagId: number) => onTagFilterChange(tagFilter.includes(tagId) ? tagFilter.filter(id => id !== tagId) : [...tagFilter, tagId]);

    return (
        <>
            {activeFilterCount > 0 && <div className="flex flex-wrap gap-1.5 p-3 pb-0 items-center">{statusFilter.map(s => <Badge key={`st-${s}`} variant="outline" className="gap-1 text-xs"><span className="size-2 rounded-full" style={{ backgroundColor: BLANC_STATUS_COLORS[s] || 'var(--blanc-ink-3)' }} />{s}<X className="size-3 cursor-pointer" onClick={() => toggle(statusFilter, s, onStatusFilterChange)} /></Badge>)}{providerFilter.map(s => <Badge key={`pr-${s}`} variant="outline" className="gap-1 text-xs"><User className="size-3" style={{ color: 'var(--blanc-ink-3)' }} />{s}<X className="size-3 cursor-pointer" onClick={() => toggle(providerFilter, s, onProviderFilterChange)} /></Badge>)}{canViewSource && sourceFilter.map(s => <Badge key={`src-${s}`} variant="outline" className="gap-1 text-xs"><Globe className="size-3" style={{ color: 'var(--blanc-ink-3)' }} />{s}<X className="size-3 cursor-pointer" onClick={() => toggle(sourceFilter, s, onSourceFilterChange)} /></Badge>)}{jobTypeFilter.map(t => <Badge key={`jt-${t}`} variant="outline" className="gap-1 text-xs"><Briefcase className="size-3" style={{ color: 'var(--blanc-ink-3)' }} />{t}<X className="size-3 cursor-pointer" onClick={() => toggle(jobTypeFilter, t, onJobTypeFilterChange)} /></Badge>)}{tagFilter.map(id => { const tag = allTags.find(t => t.id === id); return tag ? <Badge key={`tag-${id}`} variant="outline" className="gap-1 text-xs"><span className="size-2 rounded-full" style={{ backgroundColor: tag.color }} />{tag.name}<X className="size-3 cursor-pointer" onClick={() => toggleTag(id)} /></Badge> : null; })}<button onClick={clearAllFilters} className="text-xs text-muted-foreground hover:text-foreground ml-1">Clear all</button></div>}
            <div className="grid grid-cols-1 sm:grid-cols-5 p-3 gap-3 sm:gap-0">
                <FilterColumn title="STATUS" items={statuses} selected={statusFilter} onToggle={item => toggle(statusFilter, item, onStatusFilterChange)} colorMap={BLANC_STATUS_COLORS} />
                <FilterColumn title="PROVIDERS" items={providerNames} selected={providerFilter} onToggle={item => toggle(providerFilter, item, onProviderFilterChange)} />
                {canViewSource && <FilterColumn title="SOURCE" items={JOB_SOURCES as unknown as string[]} selected={sourceFilter} onToggle={item => toggle(sourceFilter, item, onSourceFilterChange)} />}
                <FilterColumn title="JOB TYPE" items={dynamicJobTypes} selected={jobTypeFilter} onToggle={item => toggle(jobTypeFilter, item, onJobTypeFilterChange)} />
                <div className="px-3"><div className="text-xs font-semibold text-muted-foreground mb-2">TAGS</div><div className="space-y-1 max-h-56 overflow-y-auto">{allTags.filter(t => t.is_active).map(tag => <label key={tag.id} className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-sm transition-colors ${tagFilter.includes(tag.id) ? 'bg-primary/10 font-medium' : 'hover:bg-muted/50'}`}><input type="checkbox" checked={tagFilter.includes(tag.id)} onChange={() => toggleTag(tag.id)} className="sr-only" /><span className={`size-3 rounded-full shrink-0 border ${tagFilter.includes(tag.id) ? 'ring-2 ring-primary ring-offset-1' : ''}`} style={{ backgroundColor: tag.color }} />{tag.name}</label>)}</div></div>
            </div>
        </>
    );
}
