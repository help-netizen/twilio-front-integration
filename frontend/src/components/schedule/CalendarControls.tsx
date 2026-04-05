/**
 * CalendarControls — View mode selector, date navigation, and expandable filters.
 * Filters use a Leads-style expanded list panel (Status / Source / Tags columns).
 */

import React, { useState, useRef, useEffect } from 'react';
import { ChevronLeft, ChevronRight, ChevronDown, SlidersHorizontal, X } from 'lucide-react';
import { format, startOfWeek, endOfWeek } from 'date-fns';
import type { ViewMode, ProviderInfo } from '../../hooks/useScheduleData';
import type { ScheduleFilters } from '../../services/scheduleApi';
import { getProviderColor } from '../../utils/providerColors';
import { Badge } from '../ui/badge';

interface CalendarControlsProps {
    viewMode: ViewMode;
    currentDate: Date;
    filters: Partial<ScheduleFilters>;
    itemCounts?: { total: number; jobs: number; leads: number; tasks: number };
    loading?: boolean;
    providers?: ProviderInfo[];
    allTags?: string[];
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

const STATUS_OPTIONS: Array<{ value: string; label: string; color: string }> = [
    { value: 'new', label: 'New', color: '#8B5CF6' },
    { value: 'submitted', label: 'Submitted', color: '#3B82F6' },
    { value: 'scheduled', label: 'Scheduled', color: '#2563EB' },
    { value: 'en_route', label: 'En Route', color: '#14B8A6' },
    { value: 'in_progress', label: 'In Progress', color: '#F59E0B' },
    { value: 'completed', label: 'Completed', color: '#22C55E' },
    { value: 'contacted', label: 'Contacted', color: '#1B8B63' },
    { value: 'qualified', label: 'Qualified', color: '#22C55E' },
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

/* ── Filter column sub-component (same pattern as LeadsFilters) ── */

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
    if (items.length === 0) return null;
    return (
        <div className="px-3 space-y-1">
            <div
                className="text-[11px] font-semibold tracking-wider uppercase mb-2"
                style={{ color: 'var(--sched-ink-3)', letterSpacing: '0.08em' }}
            >
                {title}
            </div>
            <div className="space-y-0.5 max-h-[240px] overflow-y-auto">
                {items.map(item => {
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
                                color: isSelected ? 'var(--blanc-info, #2563eb)' : 'var(--sched-ink-1)',
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

export const CalendarControls: React.FC<CalendarControlsProps> = ({
    viewMode, currentDate, filters, itemCounts, loading, providers = [], allTags = [],
    onViewModeChange, onNavigateDate, onFiltersChange, onOpenSettings,
}) => {
    const [filterDropdownOpen, setFilterDropdownOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Close dropdown on outside click
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setFilterDropdownOpen(false);
            }
        };
        if (filterDropdownOpen) document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [filterDropdownOpen]);

    const activeFilterCount = [
        filters.statuses?.length ? 1 : 0,
        filters.source ? 1 : 0,
        filters.tags?.length ? 1 : 0,
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

    const handleSourceToggle = (source: string) => {
        const normalized = source.toLowerCase().replace(/\s+/g, '_');
        const current = filters.source;
        onFiltersChange({ ...filters, source: current === normalized ? undefined : normalized });
    };

    const handleTagToggle = (tag: string) => {
        const current = filters.tags || [];
        const next = current.includes(tag)
            ? current.filter(t => t !== tag)
            : [...current, tag];
        onFiltersChange({ ...filters, tags: next.length ? next : undefined });
    };

    const handleResetFilters = () => {
        onFiltersChange({});
        setFilterDropdownOpen(false);
    };

    // Build status color map
    const statusColorMap: Record<string, string> = {};
    for (const s of STATUS_OPTIONS) statusColorMap[s.label] = s.color;

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

                    {/* Right: Search + Filters + Settings */}
                    <div className="flex items-center gap-2">
                        {/* Inline search */}
                        <label
                            className="flex items-center min-h-[42px] px-3 gap-2"
                            style={{
                                ...controlBtn,
                                minWidth: 180,
                            }}
                        >
                            <svg className="size-4 shrink-0" style={{ color: 'var(--sched-ink-3)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
                            </svg>
                            <input
                                type="text"
                                placeholder="Search..."
                                value={filters.search || ''}
                                onChange={(e) => onFiltersChange({ ...filters, search: e.target.value || undefined })}
                                className="w-full bg-transparent border-0 text-[13px] outline-none placeholder:text-gray-400"
                                style={{ color: 'var(--sched-ink-1)' }}
                            />
                        </label>

                        {/* Filters button + dropdown */}
                        <div className="relative" ref={dropdownRef}>
                            <button
                                type="button"
                                onClick={() => setFilterDropdownOpen(!filterDropdownOpen)}
                                className="flex items-center gap-2 min-h-[42px] px-4 text-[14px] font-semibold transition-all"
                                style={{
                                    background: filterDropdownOpen ? 'var(--sched-ink-1)' : 'var(--sched-surface-strong)',
                                    border: '1px solid ' + (filterDropdownOpen ? 'var(--sched-ink-1)' : 'rgba(104, 95, 80, 0.14)'),
                                    color: filterDropdownOpen ? '#fff' : 'var(--sched-ink-1)',
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

                            {/* Filter Dropdown Panel */}
                            {filterDropdownOpen && (
                                <div
                                    className="absolute z-50 rounded-xl overflow-hidden"
                                    style={{
                                        background: 'var(--blanc-surface-strong, #fffdf9)',
                                        border: '1px solid var(--blanc-line, rgba(117, 106, 89, 0.18))',
                                        boxShadow: '0 12px 32px rgba(48, 39, 28, 0.12)',
                                        width: allTags.length > 0 ? 520 : 380,
                                        right: 0,
                                        top: 'calc(100% + 8px)',
                                    }}
                                >
                                    {/* Active filter badges */}
                                    {activeFilterCount > 0 && (
                                        <div className="flex flex-wrap gap-1.5 p-3 pb-0 items-center">
                                            {(filters.statuses || []).map(s => {
                                                const opt = STATUS_OPTIONS.find(o => o.value === s);
                                                return (
                                                    <Badge key={`s-${s}`} variant="secondary" className="gap-1 text-xs">
                                                        {opt?.label || s}
                                                        <X className="size-3 cursor-pointer" onClick={() => handleStatusToggle(s)} />
                                                    </Badge>
                                                );
                                            })}
                                            {filters.source && (
                                                <Badge variant="outline" className="gap-1 text-xs">
                                                    {filters.source}
                                                    <X className="size-3 cursor-pointer" onClick={() => onFiltersChange({ ...filters, source: undefined })} />
                                                </Badge>
                                            )}
                                            {(filters.tags || []).map(t => (
                                                <Badge key={`tag-${t}`} variant="default" className="gap-1 text-xs">
                                                    {t}
                                                    <X className="size-3 cursor-pointer" onClick={() => handleTagToggle(t)} />
                                                </Badge>
                                            ))}
                                            <button
                                                onClick={handleResetFilters}
                                                className="text-xs ml-1 transition-opacity hover:opacity-70"
                                                style={{ color: 'var(--sched-ink-3)' }}
                                            >
                                                Clear all
                                            </button>
                                        </div>
                                    )}

                                    {/* Columns */}
                                    <div
                                        className="grid p-3 gap-0"
                                        style={{
                                            gridTemplateColumns: allTags.length > 0 ? '1fr 1fr 1fr' : '1fr 1fr',
                                            borderTop: activeFilterCount > 0 ? '1px solid var(--blanc-line, rgba(117, 106, 89, 0.18))' : undefined,
                                            marginTop: activeFilterCount > 0 ? 8 : 0,
                                        }}
                                    >
                                        <FilterColumn
                                            title="STATUS"
                                            items={STATUS_OPTIONS.map(o => o.label)}
                                            selected={(filters.statuses || []).map(v => STATUS_OPTIONS.find(o => o.value === v)?.label || v)}
                                            onToggle={(label) => {
                                                const opt = STATUS_OPTIONS.find(o => o.label === label);
                                                if (opt) handleStatusToggle(opt.value);
                                            }}
                                            colorMap={statusColorMap}
                                        />
                                        <FilterColumn
                                            title="SOURCE"
                                            items={SOURCE_OPTIONS}
                                            selected={filters.source ? [SOURCE_OPTIONS.find(s => s.toLowerCase().replace(/\s+/g, '_') === filters.source) || ''] : []}
                                            onToggle={handleSourceToggle}
                                        />
                                        {allTags.length > 0 && (
                                            <FilterColumn
                                                title="TAGS"
                                                items={allTags}
                                                selected={filters.tags || []}
                                                onToggle={handleTagToggle}
                                            />
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>

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

                {/* Provider chips — always visible below controls */}
                {providers.length > 0 && (
                    <div className="flex items-center gap-2 flex-wrap mt-3 pt-3" style={{ borderTop: '1px solid rgba(117, 106, 89, 0.08)' }}>
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
        </div>
    );
};
