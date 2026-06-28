/**
 * JobsMobileBar — the phone-only top of the Jobs page (JOBS-MOBILE-001).
 *
 * Mirrors MobileScheduleBar: a sticky "Jobs" title + search input, and a single
 * gear ⚙ (with an active-filter-count badge) that opens a BottomSheet
 * ("View options"). The sheet houses every secondary control — the shared
 * JobsFilterBody (status/providers/source/job-type/tags), the date range, a Sort
 * selector, a Reset row (when filters are active), Export CSV, and New Job.
 *
 * Owns no Jobs state — all filter/search/sort state lives in useJobsData and is
 * threaded in via props, so the sheet drives the exact same list the page uses.
 * Rendered ONLY on mobile (JobsPage gates it behind useIsMobile).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Settings2, Plus, X, RotateCcw, Download, Loader2, Search } from 'lucide-react';
import type { JobTag, LocalJob } from '../../services/jobsApi';
import { authedFetch } from '../../services/apiClient';
import { BottomSheet } from '../ui/BottomSheet';
import { DateRangePickerPopover } from '../ui/DateRangePickerPopover';
import { BLANC_STATUSES } from './jobsFilterHelpers';
import { JobsFilterBody } from './JobsFilterBody';
import { useFsmStates } from '../../hooks/useFsmActions';

const controlBtn: React.CSSProperties = {
    background: 'var(--blanc-surface-strong, #fffdf9)',
    border: '1px solid rgba(104, 95, 80, 0.14)',
    color: 'var(--blanc-ink-1)',
    boxShadow: '0 6px 16px rgba(48, 39, 28, 0.06)',
    borderRadius: '14px',
};

const eyebrow: React.CSSProperties = {
    fontSize: '11px',
    textTransform: 'uppercase',
    letterSpacing: '0.14em',
    color: 'var(--blanc-ink-3)',
    fontWeight: 600,
};

// Sort fields offered in the sheet (a focused subset of the desktop sort keys).
const SORT_FIELDS: Array<{ value: string; label: string }> = [
    { value: 'start_date', label: 'Schedule date' },
    { value: 'created_at', label: 'Created' },
    { value: 'blanc_status', label: 'Status' },
    { value: 'customer_name', label: 'Customer' },
    { value: 'invoice_total', label: 'Invoice total' },
];

interface JobsMobileBarProps {
    searchQuery: string;
    setSearchQuery: (v: string) => void;

    statusFilter: string[]; onStatusFilterChange: (v: string[]) => void;
    providerFilter: string[]; onProviderFilterChange: (v: string[]) => void;
    sourceFilter: string[]; onSourceFilterChange: (v: string[]) => void;
    jobTypeFilter: string[]; onJobTypeFilterChange: (v: string[]) => void;
    tagFilter: number[]; onTagFilterChange: (v: number[]) => void;
    allTags: JobTag[];

    startDate?: string; onStartDateChange: (d: string | undefined) => void;
    endDate?: string; onEndDateChange: (d: string | undefined) => void;

    sortBy: string;
    sortOrder: 'asc' | 'desc';
    onSortChange: (field: string, order: 'asc' | 'desc') => void;

    /** Drives the PROVIDERS filter column (names derived from the loaded jobs). */
    jobs: LocalJob[];

    onExportCSV: () => void;
    exporting: boolean;
    canExport: boolean;

    onNewJob: () => void;
    canCreateJob: boolean;
}

export const JobsMobileBar: React.FC<JobsMobileBarProps> = ({
    searchQuery, setSearchQuery,
    statusFilter, onStatusFilterChange,
    providerFilter, onProviderFilterChange,
    sourceFilter, onSourceFilterChange,
    jobTypeFilter, onJobTypeFilterChange,
    tagFilter, onTagFilterChange, allTags,
    startDate, onStartDateChange, endDate, onEndDateChange,
    sortBy, sortOrder, onSortChange,
    jobs, onExportCSV, exporting, canExport, onNewJob, canCreateJob,
}) => {
    const [sheetOpen, setSheetOpen] = useState(false);
    const [dynamicJobTypes, setDynamicJobTypes] = useState<string[]>([]);
    const { data: fsmData } = useFsmStates('job', true);
    const statuses = fsmData?.states && fsmData.states.length > 0 ? fsmData.states : BLANC_STATUSES;

    // Same derivations JobsFilters performs, so JobsFilterBody behaves identically.
    useEffect(() => { authedFetch('/api/settings/lead-form').then(r => r.json()).then(data => { if (data.success && data.jobTypes?.length > 0) setDynamicJobTypes(data.jobTypes.map((jt: { name: string }) => jt.name)); }).catch(() => { }); }, []);

    const providerNames = useMemo(() => {
        const names = new Set<string>();
        jobs.forEach(j => { if (j.assigned_techs) j.assigned_techs.forEach((t) => { if (t.name) names.add(t.name); }); });
        return [...names].sort();
    }, [jobs]);

    const activeFilterCount = statusFilter.length + providerFilter.length + sourceFilter.length + jobTypeFilter.length + tagFilter.length;
    const resetFilters = () => {
        onStatusFilterChange([]); onProviderFilterChange([]); onSourceFilterChange([]); onJobTypeFilterChange([]); onTagFilterChange([]);
    };
    const close = () => setSheetOpen(false);

    return (
        <>
            {/* ── Top bar: "Jobs" + search + gear ── */}
            <div className="flex items-center gap-3">
                <div className="min-w-0">
                    <div style={eyebrow}>Jobs</div>
                </div>

                <label className="flex items-center min-h-[44px] px-3 gap-2 flex-1 min-w-0" style={controlBtn}>
                    <Search className="size-4 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                    <input
                        type="text"
                        placeholder="Search..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full bg-transparent border-0 text-[14px] outline-none placeholder:text-gray-400"
                        style={{ color: 'var(--blanc-ink-1)' }}
                    />
                    {searchQuery && (
                        <button type="button" onClick={() => setSearchQuery('')} aria-label="Clear search" className="shrink-0" style={{ color: 'var(--blanc-ink-3)' }}>
                            <X className="size-4" />
                        </button>
                    )}
                </label>

                <button
                    type="button"
                    onClick={() => setSheetOpen(true)}
                    aria-label="View options"
                    className="relative w-[44px] h-[44px] flex items-center justify-center shrink-0 transition-opacity hover:opacity-70"
                    style={controlBtn}
                >
                    <Settings2 className="size-5" />
                    {activeFilterCount > 0 && (
                        <span
                            className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 inline-flex items-center justify-center rounded-full text-[10px] font-bold"
                            style={{ background: 'var(--blanc-ink-1)', color: '#fff' }}
                        >
                            {activeFilterCount}
                        </span>
                    )}
                </button>
            </div>

            {/* ── View options sheet ── */}
            <BottomSheet open={sheetOpen} onClose={close} title="View options">
                <div className="flex flex-col gap-5">
                    {/* Filters — shared body (single column on mobile) */}
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

                    {/* Date range */}
                    <div>
                        <div style={eyebrow} className="mb-2">Date range</div>
                        <DateRangePickerPopover
                            dateFrom={startDate}
                            dateTo={endDate}
                            onDateFromChange={d => onStartDateChange(d)}
                            onDateToChange={d => onEndDateChange(d)}
                        />
                    </div>

                    {/* Sort */}
                    <div>
                        <div style={eyebrow} className="mb-2">Sort</div>
                        <div className="flex items-center gap-2">
                            <select
                                value={sortBy}
                                onChange={(e) => onSortChange(e.target.value, sortOrder)}
                                className="flex-1 min-h-[44px] px-3 text-[14px] outline-none"
                                style={{ ...controlBtn }}
                            >
                                {SORT_FIELDS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                            </select>
                            <select
                                value={sortOrder}
                                onChange={(e) => onSortChange(sortBy, e.target.value as 'asc' | 'desc')}
                                className="min-h-[44px] px-3 text-[14px] outline-none"
                                style={{ ...controlBtn }}
                            >
                                <option value="desc">Newest first</option>
                                <option value="asc">Oldest first</option>
                            </select>
                        </div>
                    </div>

                    {/* Reset — only when filters active */}
                    {activeFilterCount > 0 && (
                        <button
                            type="button"
                            onClick={resetFilters}
                            className="flex items-center justify-center gap-2 w-full min-h-[44px] text-[14px] font-medium transition-opacity hover:opacity-70"
                            style={{ color: 'var(--blanc-ink-2)', background: 'transparent', border: '1px solid rgba(104, 95, 80, 0.14)', borderRadius: '14px' }}
                        >
                            <RotateCcw className="size-4" /> Reset filters
                        </button>
                    )}

                    {/* Actions */}
                    <div className="flex flex-col gap-2.5">
                        <div style={eyebrow}>Actions</div>
                        {canCreateJob && (
                            <button
                                type="button"
                                onClick={() => { close(); onNewJob(); }}
                                className="flex items-center gap-3 w-full min-h-[52px] px-4 text-[15px] font-semibold transition-opacity hover:opacity-80"
                                style={{ ...controlBtn, borderRadius: '16px', justifyContent: 'flex-start' }}
                            >
                                <Plus className="size-5" />
                                <span>New job</span>
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={onExportCSV}
                            disabled={!canExport || exporting}
                            className="flex items-center gap-3 w-full min-h-[52px] px-4 text-[15px] font-semibold transition-opacity hover:opacity-80 disabled:opacity-50"
                            style={{ ...controlBtn, borderRadius: '16px', justifyContent: 'flex-start' }}
                        >
                            {exporting ? <Loader2 className="size-5 animate-spin" /> : <Download className="size-5" />}
                            <span>Export CSV</span>
                        </button>
                    </div>
                </div>
            </BottomSheet>
        </>
    );
};
