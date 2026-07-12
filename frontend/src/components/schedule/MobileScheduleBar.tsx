/**
 * MobileScheduleBar — the phone-only top of the Schedule page.
 *
 * Field-tech first: the DATE is the hero (large, e.g. "Mon, Jun 30") with
 * ‹ / Today / › nav at 42px tap targets, and a single gear ⚙ on the right.
 * The gear opens a BottomSheet ("View options") that houses every secondary
 * control — search, filters, technician selector, reset, and (dispatch only)
 * New job / AI Assistant / Settings.
 *
 * All filter/search/provider state lives in useScheduleData and is threaded in
 * via props/handlers — this component owns no schedule state, so the sheet
 * drives the exact same `filters` the page already uses (no duplication).
 *
 * Rendered ONLY on mobile (SchedulePage gates it behind useIsMobile); the
 * desktop render path is untouched.
 */

import React, { useState } from 'react';
import { Settings2, Sparkles, Plus, X, RotateCcw, Map, List, CalendarOff } from 'lucide-react';
import { format } from 'date-fns';
import type { ProviderInfo } from '../../hooks/useScheduleData';
import type { ScheduleFilters } from '../../services/scheduleApi';
import { todayInTZ } from '../../utils/companyTime';
import { BottomSheet } from '../ui/BottomSheet';
import { WeekStrip } from './WeekStrip';
import {
    ScheduleFilterBody,
    ScheduleProviderChips,
    getActiveFilterCount,
} from './CalendarControls';

interface MobileScheduleBarProps {
    currentDate: Date;
    timezone: string;
    filters: Partial<ScheduleFilters>;
    providers: ProviderInfo[];
    allTags: string[];
    onNavigateDate: (direction: 'prev' | 'next' | 'today') => void;
    onSelectDate: (date: Date) => void;
    onFiltersChange: (filters: Partial<ScheduleFilters>) => void;
    // SCHEDULE-MOBILE-MAP-001: list⇄map toggle for the mobile day view. One
    // button (left of the gear) whose icon + label swap by `mapOpen`.
    mapOpen: boolean;
    onToggleMap: () => void;
    // Dispatch-only (omitted for field techs without schedule.dispatch).
    onNewJob?: () => void;
    onToggleAIAssistant?: () => void;
    onOpenSettings?: () => void;
    // TECH-DAYOFF-001 (owner iteration): "Time off" lives inside this sheet on
    // mobile instead of a standalone chip above the calendar.
    onTimeOff?: () => void;
}

const controlBtn: React.CSSProperties = {
    background: 'var(--sched-surface-strong)',
    border: '1px solid rgba(104, 95, 80, 0.14)',
    color: 'var(--sched-ink-1)',
    boxShadow: '0 6px 16px rgba(48, 39, 28, 0.06)',
    borderRadius: '14px',
};

const eyebrow: React.CSSProperties = {
    fontSize: '11px',
    textTransform: 'uppercase',
    letterSpacing: '0.14em',
    color: 'var(--blanc-ink-3, var(--sched-ink-3))',
    fontWeight: 600,
};

/** Full-width action row inside the sheet (New job / AI Assistant / Settings). */
const SheetAction: React.FC<{ onClick: () => void; icon: React.ReactNode; label: string }> = ({ onClick, icon, label }) => (
    <button
        type="button"
        onClick={onClick}
        className="flex items-center gap-3 w-full min-h-[52px] px-4 text-[15px] font-semibold transition-opacity hover:opacity-80"
        style={{ ...controlBtn, borderRadius: '16px', justifyContent: 'flex-start' }}
    >
        {icon}
        <span>{label}</span>
    </button>
);

export const MobileScheduleBar: React.FC<MobileScheduleBarProps> = ({
    currentDate, timezone, filters, providers, allTags,
    onNavigateDate, onSelectDate, onFiltersChange, mapOpen, onToggleMap, onNewJob, onToggleAIAssistant, onOpenSettings, onTimeOff,
}) => {
    const [sheetOpen, setSheetOpen] = useState(false);
    const activeFilterCount = getActiveFilterCount(filters);
    const hasDispatchActions = !!(onNewJob || onToggleAIAssistant || onOpenSettings || onTimeOff);
    const isOnToday = format(currentDate, 'yyyy-MM-dd') === todayInTZ(timezone);

    const close = () => setSheetOpen(false);

    return (
        <>
            {/* ── Top bar: date is the hero (tap → today) + gear ── */}
            <div className="flex items-center justify-between gap-3">
                <button
                    type="button"
                    onClick={() => onNavigateDate('today')}
                    aria-label={isOnToday ? 'Today' : 'Return to today'}
                    className="min-w-0 text-left transition-opacity hover:opacity-70"
                    style={{ background: 'transparent', border: 0, padding: 0 }}
                >
                    <div style={eyebrow}>Schedule</div>
                    <div className="flex items-center gap-1.5">
                        <span
                            className="font-bold leading-tight truncate"
                            style={{
                                fontFamily: 'Manrope, sans-serif',
                                fontSize: '24px',
                                letterSpacing: '-0.02em',
                                color: 'var(--sched-ink-1)',
                            }}
                        >
                            {format(currentDate, 'EEE, MMM d')}
                        </span>
                        {!isOnToday && (
                            <RotateCcw className="size-4 shrink-0" style={{ color: 'var(--sched-ink-3)' }} />
                        )}
                    </div>
                </button>

                <div className="flex items-center gap-2 shrink-0">
                {/* List⇄map toggle — one button, icon+label swap by mapOpen (left of gear) */}
                <button
                    type="button"
                    onClick={onToggleMap}
                    aria-label={mapOpen ? 'Show list' : 'Show map'}
                    className="w-[44px] h-[44px] flex items-center justify-center shrink-0 transition-opacity hover:opacity-70"
                    style={controlBtn}
                >
                    {mapOpen ? <List className="size-5" /> : <Map className="size-5" />}
                </button>

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
                            style={{ background: 'var(--sched-ink-1)', color: '#fff' }}
                        >
                            {activeFilterCount}
                        </span>
                    )}
                </button>
                </div>
            </div>

            {/* ── Week strip: tap a day, swipe to page weeks ── */}
            <WeekStrip
                selectedDate={currentDate}
                timezone={timezone}
                filters={filters}
                onSelectDate={onSelectDate}
            />

            {/* ── View options sheet ── */}
            <BottomSheet open={sheetOpen} onClose={close} title="View options" size="standard">
                <div className="flex flex-col gap-5">
                    {/* Search */}
                    <label
                        className="flex items-center min-h-[46px] px-3 gap-2 w-full"
                        style={controlBtn}
                    >
                        <svg className="size-4 shrink-0" style={{ color: 'var(--sched-ink-3)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
                        </svg>
                        <input
                            type="text"
                            placeholder="Search..."
                            value={filters.search || ''}
                            onChange={(e) => onFiltersChange({ ...filters, search: e.target.value || undefined })}
                            className="w-full bg-transparent border-0 text-[14px] outline-none placeholder:text-gray-400"
                            style={{ color: 'var(--sched-ink-1)' }}
                        />
                        {filters.search && (
                            <button
                                type="button"
                                onClick={() => onFiltersChange({ ...filters, search: undefined })}
                                aria-label="Clear search"
                                className="shrink-0"
                                style={{ color: 'var(--sched-ink-3)' }}
                            >
                                <X className="size-4" />
                            </button>
                        )}
                    </label>

                    {/* Technician selector */}
                    {providers.length > 0 && (
                        <div>
                            <div style={eyebrow} className="mb-2">Provider</div>
                            <div className="flex items-center gap-2 flex-wrap">
                                <ScheduleProviderChips providers={providers} filters={filters} onFiltersChange={onFiltersChange} />
                            </div>
                        </div>
                    )}

                    {/* Filters — single column */}
                    <ScheduleFilterBody
                        filters={filters}
                        allTags={allTags}
                        onFiltersChange={onFiltersChange}
                        layout="stack"
                    />

                    {/* Reset — only when filters active */}
                    {activeFilterCount > 0 && (
                        <button
                            type="button"
                            onClick={() => onFiltersChange({})}
                            className="flex items-center justify-center gap-2 w-full min-h-[44px] text-[14px] font-medium transition-opacity hover:opacity-70"
                            style={{ color: 'var(--sched-ink-2)', background: 'transparent', border: '1px solid rgba(104, 95, 80, 0.14)', borderRadius: '14px' }}
                        >
                            <RotateCcw className="size-4" /> Reset filters
                        </button>
                    )}

                    {/* Dispatch-only actions */}
                    {hasDispatchActions && (
                        <div className="flex flex-col gap-2.5">
                            <div style={eyebrow}>Dispatch</div>
                            {onNewJob && (
                                <SheetAction onClick={() => { close(); onNewJob(); }} icon={<Plus className="size-5" />} label="New job" />
                            )}
                            {onToggleAIAssistant && (
                                <SheetAction onClick={() => { close(); onToggleAIAssistant(); }} icon={<Sparkles className="size-5" />} label="AI Assistant" />
                            )}
                            {onTimeOff && (
                                <SheetAction onClick={() => { close(); onTimeOff(); }} icon={<CalendarOff className="size-5" />} label="Time off" />
                            )}
                            {onOpenSettings && (
                                <SheetAction onClick={() => { close(); onOpenSettings(); }} icon={<Settings2 className="size-5" />} label="Settings" />
                            )}
                        </div>
                    )}
                </div>
            </BottomSheet>
        </>
    );
};
