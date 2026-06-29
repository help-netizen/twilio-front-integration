/**
 * LeadsMobileBar — the phone-only top of the Leads page (LEADS-MOBILE-001).
 *
 * Mirrors JobsMobileBar: a sticky "Leads" title + search input, and a single
 * gear ⚙ (with an active-filter-count badge) that opens a BottomSheet
 * ("View options"). The sheet houses every secondary control — the shared
 * LeadsFilterBody (status/source/job-type), the date range, an Only-open toggle,
 * a Sort selector, a Reset row (when filters are active), and New lead.
 *
 * Owns no Leads state — all filter/search/sort state lives in LeadsPage and is
 * threaded in via props, so the sheet drives the exact same list the page uses.
 * Rendered ONLY on mobile (LeadsPage gates it behind useIsMobile).
 */

import React, { useState } from 'react';
import { Settings2, Plus, X, RotateCcw, Search } from 'lucide-react';
import type { LeadsListParams } from '../../types/lead';
import { LEAD_STATUSES } from '../../types/lead';
import { useFsmStates } from '../../hooks/useFsmActions';
import { useLeadFormSettings } from '../../hooks/useLeadFormSettings';
import { BottomSheet } from '../ui/BottomSheet';
import { DateRangePickerPopover } from '../ui/DateRangePickerPopover';
import { Switch } from '../ui/switch';
import { LeadsFilterBody } from './LeadsFilterBody';

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
    { value: 'CreatedDate', label: 'Created date' },
    { value: 'FirstName', label: 'Name' },
    { value: 'Status', label: 'Status' },
];

interface LeadsMobileBarProps {
    searchQuery: string;
    setSearchQuery: (v: string) => void;

    filters: LeadsListParams;
    onFiltersChange: (filters: Partial<LeadsListParams>) => void;

    sourceFilter: string[]; onSourceFilterChange: (v: string[]) => void;
    jobTypeFilter: string[]; onJobTypeFilterChange: (v: string[]) => void;

    sortBy: string;
    sortOrder: 'asc' | 'desc';
    onSortChange: (field: string, order: 'asc' | 'desc') => void;

    onNewLead: () => void;
    canCreateLead: boolean;
}

export const LeadsMobileBar: React.FC<LeadsMobileBarProps> = ({
    searchQuery, setSearchQuery,
    filters, onFiltersChange,
    sourceFilter, onSourceFilterChange,
    jobTypeFilter, onJobTypeFilterChange,
    sortBy, sortOrder, onSortChange,
    onNewLead, canCreateLead,
}) => {
    const [sheetOpen, setSheetOpen] = useState(false);
    const { jobTypes: dynamicJobTypes } = useLeadFormSettings();
    const { data: fsmData } = useFsmStates('lead', true);
    const statuses = fsmData?.states && fsmData.states.length > 0 ? fsmData.states : LEAD_STATUSES as unknown as string[];

    const statusFilter = filters.status || [];
    const toggleStatus = (status: string) => {
        onFiltersChange({ status: statusFilter.includes(status) ? statusFilter.filter(s => s !== status) : [...statusFilter, status] });
    };
    const toggleSource = (source: string) => {
        onSourceFilterChange(sourceFilter.includes(source) ? sourceFilter.filter(s => s !== source) : [...sourceFilter, source]);
    };
    const toggleJobType = (type: string) => {
        onJobTypeFilterChange(jobTypeFilter.includes(type) ? jobTypeFilter.filter(t => t !== type) : [...jobTypeFilter, type]);
    };

    const activeFilterCount = statusFilter.length + sourceFilter.length + jobTypeFilter.length;
    const resetFilters = () => {
        onFiltersChange({ status: [] }); onSourceFilterChange([]); onJobTypeFilterChange([]);
    };
    const close = () => setSheetOpen(false);

    return (
        <>
            {/* ── Top bar: "Leads" + search + gear ── */}
            <div className="flex items-center gap-3">
                <div className="min-w-0">
                    <div style={eyebrow}>Leads</div>
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
            <BottomSheet open={sheetOpen} onClose={close} title="View options" size="standard">
                <div className="flex flex-col gap-5">
                    {/* Filters — shared body (single column on mobile) */}
                    <LeadsFilterBody
                        statusFilter={statusFilter} onToggleStatus={toggleStatus}
                        sourceFilter={sourceFilter} onToggleSource={toggleSource}
                        jobTypeFilter={jobTypeFilter} onToggleJobType={toggleJobType}
                        statuses={statuses}
                        dynamicJobTypes={dynamicJobTypes}
                        onClearAll={resetFilters}
                    />

                    {/* Date range */}
                    <div>
                        <div style={eyebrow} className="mb-2">Date range</div>
                        <DateRangePickerPopover
                            dateFrom={filters.start_date}
                            dateTo={filters.end_date}
                            onDateFromChange={d => onFiltersChange({ start_date: d })}
                            onDateToChange={d => onFiltersChange({ end_date: d })}
                        />
                    </div>

                    {/* Only open */}
                    <div className="flex items-center justify-between gap-3">
                        <div style={eyebrow}>Only open</div>
                        <Switch
                            checked={filters.only_open}
                            onCheckedChange={(checked) => onFiltersChange({ only_open: checked })}
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
                    {canCreateLead && (
                        <div className="flex flex-col gap-2.5">
                            <div style={eyebrow}>Actions</div>
                            <button
                                type="button"
                                onClick={() => { close(); onNewLead(); }}
                                className="flex items-center gap-3 w-full min-h-[52px] px-4 text-[15px] font-semibold transition-opacity hover:opacity-80"
                                style={{ ...controlBtn, borderRadius: '16px', justifyContent: 'flex-start' }}
                            >
                                <Plus className="size-5" />
                                <span>New lead</span>
                            </button>
                        </div>
                    )}
                </div>
            </BottomSheet>
        </>
    );
};
