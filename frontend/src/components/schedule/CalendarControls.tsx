/**
 * CalendarControls — View mode selector, date navigation, and expandable filters.
 * Extracted from ScheduleToolbar as part of Sprint 7 design refresh.
 */

import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronDown, SlidersHorizontal, X } from 'lucide-react';
import { format, startOfWeek, endOfWeek } from 'date-fns';
import type { ViewMode, ProviderInfo } from '../../hooks/useScheduleData';
import type { ScheduleFilters } from '../../services/scheduleApi';
import { getProviderColor } from '../../utils/providerColors';
import {
    Popover, PopoverContent, PopoverTrigger,
} from '../ui/popover';
import { Checkbox } from '../ui/checkbox';
import { Badge } from '../ui/badge';

interface CalendarControlsProps {
    viewMode: ViewMode;
    currentDate: Date;
    filters: Partial<ScheduleFilters>;
    itemCounts?: { total: number; jobs: number; leads: number; tasks: number };
    loading?: boolean;
    providers?: ProviderInfo[];
    onViewModeChange: (mode: ViewMode) => void;
    onNavigateDate: (direction: 'prev' | 'next' | 'today') => void;
    onFiltersChange: (filters: Partial<ScheduleFilters>) => void;
    onOpenSettings?: () => void;
}

const VIEW_OPTIONS: Array<{ value: ViewMode; label: string }> = [
    { value: 'day', label: 'Day' },
    { value: 'week', label: 'Week' },
    { value: 'month', label: 'Month' },
    { value: 'timeline', label: 'Timeline' },
    { value: 'timeline-week', label: 'Team Week' },
];

const STATUS_OPTIONS = [
    { value: 'new', label: 'New', group: 'Job' },
    { value: 'submitted', label: 'Submitted', group: 'Job' },
    { value: 'scheduled', label: 'Scheduled', group: 'Job' },
    { value: 'en_route', label: 'En Route', group: 'Job' },
    { value: 'in_progress', label: 'In Progress', group: 'Job' },
    { value: 'completed', label: 'Completed', group: 'Job' },
    { value: 'contacted', label: 'Contacted', group: 'Lead' },
    { value: 'qualified', label: 'Qualified', group: 'Lead' },
    { value: 'open', label: 'Open', group: 'Task' },
];

const SOURCE_OPTIONS = ['Zenbooker', 'Manual', 'Lead Form', 'Phone', 'Website', 'Referral'];

function getDateLabel(date: Date, mode: ViewMode): string {
    switch (mode) {
        case 'day':
        case 'timeline':
            return format(date, 'EEEE, MMM d, yyyy');
        case 'week':
        case 'timeline-week': {
            const start = startOfWeek(date);
            const end = endOfWeek(date);
            return format(start, 'MMM d') + ' \u2013 ' + format(end, 'MMM d, yyyy');
        }
        case 'month':
            return format(date, 'MMMM yyyy');
    }
}

const frostedCard: React.CSSProperties = {
    background: 'linear-gradient(135deg, rgba(255, 253, 249, 0.94), rgba(249, 244, 238, 0.9))',
    border: '1px solid rgba(104, 95, 80, 0.16)',
    borderRadius: '24px',
    backdropFilter: 'blur(20px)',
    boxShadow: '0 12px 32px rgba(48, 39, 28, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.7)',
};

const controlBtn: React.CSSProperties = {
    background: 'var(--sched-surface-strong)',
    border: '1px solid rgba(104, 95, 80, 0.14)',
    color: 'var(--sched-ink-1)',
    boxShadow: '0 6px 16px rgba(48, 39, 28, 0.06)',
    borderRadius: '14px',
};

const eyebrow: React.CSSProperties = {
    color: 'var(--sched-ink-3)',
    letterSpacing: '0.14em',
    fontSize: '10px',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
};

export const CalendarControls: React.FC<CalendarControlsProps> = ({
    viewMode, currentDate, filters, itemCounts, loading, providers = [],
    onViewModeChange, onNavigateDate, onFiltersChange, onOpenSettings,
}) => {
    const [showFilters, setShowFilters] = useState(
        () => !!(filters.statuses?.length || filters.jobType || filters.source),
    );

    const activeFilterCount = [
        filters.entityTypes?.length ? 1 : 0,
        filters.statuses?.length ? 1 : 0,
        filters.unassignedOnly ? 1 : 0,
        filters.jobType ? 1 : 0,
        filters.source ? 1 : 0,
        filters.search ? 1 : 0,
        filters.providerIds?.length ? 1 : 0,
    ].reduce((a, b) => a + b, 0);

    const handleProviderToggle = (providerId: string) => {
        const current = filters.providerIds || [];
        const next = current.includes(providerId)
            ? current.filter(id => id !== providerId)
            : [...current, providerId];
        onFiltersChange({ ...filters, providerIds: next.length ? next : undefined });
    };

    const handleStatusToggle = (status: string) => {
        const current = filters.statuses || [];
        const next = current.includes(status)
            ? current.filter(s => s !== status)
            : [...current, status];
        onFiltersChange({ ...filters, statuses: next.length ? next : undefined });
    };

    const handleResetFilters = () => {
        onFiltersChange({});
        setShowFilters(false);
    };

    return (
        <div style={frostedCard} className="overflow-hidden">
            <div className="px-5 py-4">
                {/* Main controls row */}
                <div className="flex items-center justify-between gap-3">
                    {/* Left: View Selector */}
                    <div className="relative">
                        <select
                            value={viewMode}
                            onChange={(e) => onViewModeChange(e.target.value as ViewMode)}
                            className="appearance-none min-h-[42px] pl-4 pr-9 text-[14px] font-semibold cursor-pointer outline-none"
                            style={controlBtn}
                        >
                            {VIEW_OPTIONS.map((opt) => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                        </select>
                        <ChevronDown
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 size-4 pointer-events-none"
                            style={{ color: 'var(--sched-ink-2)' }}
                        />
                    </div>

                    {/* Center: Date navigation + label */}
                    <div className="flex items-center gap-2.5">
                        <button
                            type="button"
                            onClick={() => onNavigateDate('prev')}
                            className="w-[42px] h-[42px] flex items-center justify-center transition-opacity hover:opacity-70"
                            style={controlBtn}
                        >
                            <ChevronLeft className="size-4" />
                        </button>
                        <button
                            type="button"
                            onClick={() => onNavigateDate('today')}
                            className="min-h-[42px] px-3.5 text-[14px] font-semibold transition-opacity hover:opacity-70"
                            style={controlBtn}
                        >
                            Today
                        </button>
                        <button
                            type="button"
                            onClick={() => onNavigateDate('next')}
                            className="w-[42px] h-[42px] flex items-center justify-center transition-opacity hover:opacity-70"
                            style={controlBtn}
                        >
                            <ChevronRight className="size-4" />
                        </button>
                        <span className="text-[15px] font-semibold ml-1" style={{ color: 'var(--sched-ink-1)' }}>
                            {getDateLabel(currentDate, viewMode)}
                        </span>
                        {!loading && itemCounts && itemCounts.total > 0 && (
                            <span
                                className="min-h-[28px] px-2.5 inline-flex items-center text-[12px] font-semibold"
                                style={{
                                    background: 'rgba(255, 255, 255, 0.6)',
                                    color: 'var(--sched-ink-2)',
                                    borderRadius: '999px',
                                }}
                            >
                                {itemCounts.total} item{itemCounts.total > 1 ? 's' : ''}
                            </span>
                        )}
                    </div>

                    {/* Right: Filters + Settings */}
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => setShowFilters(!showFilters)}
                            className="flex items-center gap-2 min-h-[42px] px-4 text-[14px] font-semibold transition-all"
                            style={{
                                background: showFilters ? 'var(--sched-ink-1)' : 'var(--sched-surface-strong)',
                                border: '1px solid ' + (showFilters ? 'var(--sched-ink-1)' : 'rgba(104, 95, 80, 0.14)'),
                                color: showFilters ? '#fff' : 'var(--sched-ink-1)',
                                boxShadow: '0 6px 16px rgba(48, 39, 28, 0.06)',
                                borderRadius: '14px',
                            }}
                        >
                            <SlidersHorizontal className="size-4" />
                            Filters
                            {activeFilterCount > 0 && (
                                <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-[10px] bg-blue-100 text-blue-700">
                                    {activeFilterCount}
                                </Badge>
                            )}
                        </button>

                        {activeFilterCount > 0 && (
                            <button
                                type="button"
                                onClick={handleResetFilters}
                                className="flex items-center gap-1 min-h-[42px] px-3 text-[13px] font-medium transition-opacity hover:opacity-70"
                                style={{ color: 'var(--sched-ink-3)', background: 'transparent', border: 'none' }}
                            >
                                <X className="size-3" /> Reset
                            </button>
                        )}

                        {onOpenSettings && (
                            <button
                                type="button"
                                onClick={onOpenSettings}
                                className="w-[42px] h-[42px] flex items-center justify-center transition-opacity hover:opacity-70"
                                style={controlBtn}
                                title="Dispatch Settings"
                            >
                                <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.573-1.066z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                </svg>
                            </button>
                        )}
                    </div>
                </div>

                {/* Expandable filters */}
                {showFilters && (
                    <div className="grid gap-2 mt-3 pt-3" style={{ borderTop: '1px solid rgba(117, 106, 89, 0.12)', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr auto' }}>
                        {/* Search */}
                        <label
                            className="schedule-filter-field flex flex-col gap-1.5 min-h-[60px] px-3 py-2"
                            style={{
                                background: 'rgba(255, 255, 255, 0.64)',
                                border: '1px solid var(--sched-line)',
                                borderRadius: '14px',
                            }}
                        >
                            <span style={eyebrow}>Search</span>
                            <input
                                type="text"
                                placeholder="Customer, address, phone, tag"
                                value={filters.search || ''}
                                onChange={(e) => onFiltersChange({ ...filters, search: e.target.value || undefined })}
                                className="w-full bg-transparent border-0 text-[14px] outline-none placeholder:text-gray-400"
                                style={{ color: 'var(--sched-ink-1)' }}
                            />
                        </label>

                        {/* Entity type */}
                        <div
                            className="schedule-filter-field flex flex-col gap-1.5 min-h-[60px] px-3 py-2"
                            style={{
                                background: 'rgba(255, 255, 255, 0.64)',
                                border: '1px solid var(--sched-line)',
                                borderRadius: '14px',
                            }}
                        >
                            <span style={eyebrow}>Entity type</span>
                            <select
                                value={filters.entityTypes?.join(',') || 'all'}
                                onChange={e => onFiltersChange({
                                    ...filters,
                                    entityTypes: e.target.value === 'all' ? undefined : [e.target.value as any],
                                })}
                                className="bg-transparent border-0 text-[14px] font-semibold outline-none cursor-pointer appearance-none"
                                style={{ color: 'var(--sched-ink-1)' }}
                            >
                                <option value="all">All types</option>
                                <option value="job">Jobs</option>
                                <option value="lead">Leads</option>
                                <option value="task">Tasks</option>
                            </select>
                        </div>

                        {/* Assignment */}
                        <div
                            className="schedule-filter-field flex flex-col gap-1.5 min-h-[60px] px-3 py-2"
                            style={{
                                background: 'rgba(255, 255, 255, 0.64)',
                                border: '1px solid var(--sched-line)',
                                borderRadius: '14px',
                            }}
                        >
                            <span style={eyebrow}>Assignment</span>
                            <select
                                value={filters.unassignedOnly ? 'unassigned' : 'all'}
                                onChange={e => onFiltersChange({
                                    ...filters,
                                    unassignedOnly: e.target.value === 'unassigned' ? true : undefined,
                                })}
                                className="bg-transparent border-0 text-[14px] font-semibold outline-none cursor-pointer appearance-none"
                                style={{ color: 'var(--sched-ink-1)' }}
                            >
                                <option value="all">All crews</option>
                                <option value="unassigned">Unassigned only</option>
                            </select>
                        </div>

                        {/* Status multi-select */}
                        <Popover>
                            <PopoverTrigger asChild>
                                <button
                                    type="button"
                                    className="schedule-filter-field flex flex-col gap-1.5 min-h-[60px] px-3 py-2 text-left"
                                    style={{
                                        background: 'rgba(255, 255, 255, 0.64)',
                                        border: '1px solid var(--sched-line)',
                                        borderRadius: '14px',
                                    }}
                                >
                                    <span style={eyebrow}>Status</span>
                                    <span className="text-[14px] font-semibold" style={{ color: 'var(--sched-ink-1)' }}>
                                        {filters.statuses?.length ? `${filters.statuses.length} selected` : 'All'}
                                    </span>
                                </button>
                            </PopoverTrigger>
                            <PopoverContent className="w-56 p-2" align="start">
                                <div className="space-y-1 max-h-60 overflow-y-auto">
                                    {STATUS_OPTIONS.map(opt => (
                                        <label
                                            key={opt.value}
                                            className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer text-sm"
                                        >
                                            <Checkbox
                                                checked={filters.statuses?.includes(opt.value) ?? false}
                                                onCheckedChange={() => handleStatusToggle(opt.value)}
                                            />
                                            <span>{opt.label}</span>
                                            <span className="ml-auto text-[10px] text-gray-400">{opt.group}</span>
                                        </label>
                                    ))}
                                </div>
                            </PopoverContent>
                        </Popover>

                        {/* Source */}
                        <div
                            className="schedule-filter-field flex flex-col gap-1.5 min-h-[60px] px-3 py-2"
                            style={{
                                background: 'rgba(255, 255, 255, 0.64)',
                                border: '1px solid var(--sched-line)',
                                borderRadius: '14px',
                            }}
                        >
                            <span style={eyebrow}>Source</span>
                            <select
                                value={filters.source || 'all'}
                                onChange={e => onFiltersChange({
                                    ...filters,
                                    source: e.target.value === 'all' ? undefined : e.target.value,
                                })}
                                className="bg-transparent border-0 text-[14px] font-semibold outline-none cursor-pointer appearance-none"
                                style={{ color: 'var(--sched-ink-1)' }}
                            >
                                <option value="all">All sources</option>
                                {SOURCE_OPTIONS.map(s => (
                                    <option key={s} value={s.toLowerCase().replace(/\s+/g, '_')}>{s}</option>
                                ))}
                            </select>
                        </div>

                        {/* Provider filter chips */}
                        {providers.length > 0 && (
                            <div className="flex items-center gap-2 self-center flex-wrap col-span-full mt-1 pt-2" style={{ borderTop: '1px solid rgba(117, 106, 89, 0.08)' }}>
                                <span className="text-[11px] font-semibold uppercase tracking-wider flex-shrink-0" style={{ color: 'var(--sched-ink-3)', letterSpacing: '0.14em' }}>
                                    Providers
                                </span>
                                {providers.map(provider => {
                                    const c = getProviderColor(provider.id);
                                    const isActive = filters.providerIds?.includes(provider.id);
                                    return (
                                        <button
                                            key={provider.id}
                                            type="button"
                                            onClick={() => handleProviderToggle(provider.id)}
                                            className="inline-flex items-center min-h-[28px] px-2.5 rounded-full text-[11px] font-semibold transition-all"
                                            style={{
                                                background: isActive ? c.accent : c.bg,
                                                border: `1px solid ${c.border}`,
                                                color: isActive ? '#fff' : c.text,
                                                boxShadow: isActive ? `0 2px 8px ${c.border}` : 'none',
                                            }}
                                        >
                                            {provider.name}
                                        </button>
                                    );
                                })}
                                {/* Unassigned chip */}
                                {(() => {
                                    const isActive = filters.providerIds?.includes('__unassigned__');
                                    return (
                                        <button
                                            type="button"
                                            onClick={() => handleProviderToggle('__unassigned__')}
                                            className="inline-flex items-center min-h-[28px] px-2.5 rounded-full text-[11px] font-semibold transition-all"
                                            style={{
                                                background: isActive ? '#6b7280' : 'rgba(243, 244, 246, 0.7)',
                                                border: '1px solid rgba(107, 114, 128, 0.25)',
                                                color: isActive ? '#fff' : '#6b7280',
                                                boxShadow: isActive ? '0 2px 8px rgba(107, 114, 128, 0.25)' : 'none',
                                            }}
                                        >
                                            Unassigned
                                        </button>
                                    );
                                })()}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};
