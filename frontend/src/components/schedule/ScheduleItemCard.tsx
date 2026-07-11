/**
 * ScheduleItemCard — Gradient card for schedule items.
 * Sprint 7 Design Refresh: warm palette, gradient backgrounds, accent borders.
 */

import React from 'react';
import { MoreVertical, Copy, Phone } from 'lucide-react';
import type { ScheduleItem } from '../../services/scheduleApi';
import { formatTimeInTZ } from '../../utils/companyTime';
import { getProviderColor } from '../../utils/providerColors';
import { geocodingLabel } from '../../utils/routeFormat';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';

// Neutral style for unassigned items
const UNASSIGNED_STYLE = {
    gradient: 'linear-gradient(180deg, rgba(248, 246, 242, 0.98), rgba(240, 237, 232, 0.94))',
    border: 'var(--blanc-line)',
    accent: 'var(--sched-ink-3)',
};

// ── Status color map ──────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
    submitted: '#2c63d2',
    contacted: '#2c63d2',
    scheduled: '#3654b7',
    qualified: '#9a5a14',
    in_progress: '#a65312',
    en_route: '#a65312',
    completed: '#21724f',
    new: '#616d7e',
    rescheduled: '#7c5360',
    canceled: '#d44d3c',
    cancelled: '#d44d3c',
};

interface ScheduleItemCardProps {
    item: ScheduleItem;
    compact?: boolean;
    onClick?: (item: ScheduleItem) => void;
    /** When provided (and the item is a job), shows a kebab menu with "Copy job". */
    onCopy?: (jobId: number) => void;
    timezone?: string;
    /**
     * SCHED-TILE-001: card composition.
     * - 'classic' (default) → today's exact rendering, untouched everywhere it's already used.
     * - 'agenda' → timeframe-led layout for the mobile agenda + desktop List view.
     */
    layout?: 'classic' | 'agenda';
    /** Only meaningful with layout='agenda': adds a phone row when customer_phone is present. */
    detailed?: boolean;
}

export const ScheduleItemCard: React.FC<ScheduleItemCardProps> = ({ item, compact = false, onClick, onCopy, timezone, layout = 'classic', detailed = false }) => {
    const primaryTech = item.assigned_techs?.[0];
    const provColor = primaryTech ? getProviderColor(primaryTech.id || primaryTech.name) : null;
    const style = provColor ? {
        gradient: `linear-gradient(180deg, ${provColor.bg}, ${provColor.bg})`,
        border: provColor.border,
        accent: provColor.accent,
    } : UNASSIGNED_STYLE;
    const statusKey = (item.status || '').toLowerCase().replace(/\s+/g, '_');
    const statusColor = STATUS_COLORS[statusKey] || '#616d7e';
    const isCanceled = statusKey === 'canceled' || statusKey === 'cancelled';

    const timeLabel = item.start_at
        ? `${formatTimeInTZ(new Date(item.start_at), timezone)}${item.end_at ? ' - ' + formatTimeInTZ(new Date(item.end_at), timezone) : ''}`
        : '';

    const techCount = item.assigned_techs?.length || 0;
    const techSummary = techCount > 0
        ? `${item.assigned_techs![0].name}${techCount > 1 ? ` +${techCount - 1}` : ''}`
        : 'Unassigned';

    // SCHED-ROUTE-001 FR-003: clickable Maps link (generated server-side from
    // lat/lng/address — no Google call on render). FR-002: subtle geocoding hint.
    const geoLabel = item.entity_type === 'job' ? geocodingLabel(item.geocoding_status) : null;
    const stop = (e: React.MouseEvent) => e.stopPropagation();
    const canCopy = !!onCopy && item.entity_type === 'job';

    // ── SCHED-TILE-001: timeframe-led "agenda" layout ─────────────────────────
    // Used by the mobile agenda (DayView mobile) + desktop List view. Same card
    // chrome as classic; only the inner composition differs. classic stays below.
    if (layout === 'agenda') {
        const hasTime = !!timeLabel;
        const nameCity = [item.customer_name, item.city].filter(Boolean).join(', ');
        // The status dot (Variant A) sits next to the technician name; omit when
        // there's no status. The kebab (Copy job) ends the top-right cluster.
        const statusDot = item.status ? (
            <span
                className="inline-block rounded-full flex-shrink-0"
                style={{ width: 8, height: 8, background: statusColor }}
                title={item.status}
            />
        ) : null;
        const kebab = canCopy ? (
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        aria-label="Job actions"
                        onClick={stop}
                        onKeyDown={stop as unknown as React.KeyboardEventHandler}
                        className="inline-flex items-center justify-center rounded-md transition-opacity opacity-70 hover:opacity-100 flex-shrink-0"
                        style={{ width: 26, height: 26, color: 'var(--sched-ink-3)' }}
                    >
                        <MoreVertical className="size-4" />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" onClick={stop}>
                    <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onCopy?.(item.entity_id); }}>
                        <Copy className="size-4 mr-2" />Copy job
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        ) : null;

        return (
            <div
                role="button"
                tabIndex={0}
                onClick={() => onClick?.(item)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(item); } }}
                className={`
                    relative w-full h-full text-left overflow-hidden transition-shadow cursor-pointer
                    hover:shadow-xl
                    focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 outline-none
                    ${isCanceled ? 'opacity-60' : ''}
                `}
                style={{
                    background: style.gradient,
                    border: `1px solid ${style.border}`,
                    borderLeft: `4px solid ${style.accent}`,
                    borderRadius: '18px',
                    boxShadow: 'var(--sched-shadow-card)',
                }}
            >
                <div className="p-3.5 pb-3 h-full flex flex-col gap-1" style={{ paddingLeft: '14px' }}>
                    {/* Top row: timeframe hero (left) + tech · status dot · kebab (right) */}
                    <div className="flex items-start justify-between gap-2" style={{ minWidth: 0 }}>
                        {hasTime ? (
                            <span
                                className="font-bold whitespace-nowrap"
                                style={{ fontSize: '17px', color: 'var(--sched-ink-1)' }}
                            >
                                {timeLabel}
                            </span>
                        ) : (
                            <h3
                                className="font-semibold truncate"
                                style={{ fontFamily: 'Manrope, sans-serif', letterSpacing: '-0.03em', fontSize: '16px', color: 'var(--sched-ink-1)', margin: 0, minWidth: 0 }}
                            >
                                {item.title}
                            </h3>
                        )}
                        <span className="flex items-center gap-1.5 flex-shrink-0 whitespace-nowrap">
                            <span className="text-[13px]" style={{ color: 'var(--sched-ink-2)' }}>{techSummary}</span>
                            {statusDot}
                            {kebab}
                        </span>
                    </div>

                    {/* Title — omitted when it became the hero (no time) */}
                    {hasTime && (
                        <h3
                            className="truncate"
                            style={{ fontFamily: 'Manrope, sans-serif', letterSpacing: '-0.03em', fontSize: '14px', fontWeight: 500, color: 'var(--sched-ink-1)', margin: 0 }}
                        >
                            {item.title}
                        </h3>
                    )}

                    {/* Customer · City — plain text, one line */}
                    {nameCity && (
                        <span className="truncate" style={{ fontSize: '14px', fontWeight: 400, color: 'var(--sched-ink-2)' }}>
                            {nameCity}
                        </span>
                    )}

                    {/* Phone — desktop List (detailed) only */}
                    {detailed && item.customer_phone && (
                        <span className="flex items-center gap-1.5 text-[13px]" style={{ color: 'var(--sched-ink-3)', minWidth: 0 }}>
                            <Phone className="size-3.5 flex-shrink-0" style={{ color: 'var(--sched-ink-3)' }} />
                            <a
                                href={`tel:${item.customer_phone}`}
                                onClick={stop}
                                onKeyDown={stop as unknown as React.KeyboardEventHandler}
                                className="truncate hover:underline"
                                style={{ color: 'var(--sched-ink-3)' }}
                            >
                                {item.customer_phone}
                            </a>
                        </span>
                    )}
                </div>
            </div>
        );
    }

    // SCHED-ROUTE-VIS-001 S-15: classic subtitle line = "Customer, City".
    // Empty city → just the subtitle (no trailing comma); both empty → not rendered (E-3/E-4).
    const subtitleCity = [item.subtitle, item.city].filter(Boolean).join(', ');

    return (
        <div
            role="button"
            tabIndex={0}
            onClick={() => onClick?.(item)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(item); } }}
            className={`
                relative w-full h-full text-left overflow-hidden transition-shadow cursor-pointer
                hover:shadow-xl
                focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 outline-none
                ${isCanceled ? 'opacity-60' : ''}
            `}
            style={{
                background: style.gradient,
                border: `1px solid ${style.border}`,
                borderLeft: `4px solid ${style.accent}`,
                borderRadius: '18px',
                boxShadow: 'var(--sched-shadow-card)',
            }}
        >
            {/* Kebab menu (top-right) — Copy job. Only for jobs, when wired. */}
            {canCopy && (
                <div className="absolute top-1.5 right-1.5 z-[1]">
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                aria-label="Job actions"
                                onClick={stop}
                                onKeyDown={stop as unknown as React.KeyboardEventHandler}
                                className="inline-flex items-center justify-center rounded-md transition-opacity opacity-70 hover:opacity-100"
                                style={{ width: 26, height: 26, color: 'var(--sched-ink-3)' }}
                            >
                                <MoreVertical className="size-4" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" onClick={stop}>
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onCopy?.(item.entity_id); }}>
                                <Copy className="size-4 mr-2" />Copy job
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            )}

            <div className="p-3.5 pb-3 h-full flex flex-col" style={{ paddingLeft: '14px' }}>
                {/* Header: entity number on top, status on its own line below */}
                <span
                    className="text-[11px] font-semibold tabular-nums truncate"
                    style={{ color: 'var(--sched-ink-3)', letterSpacing: '0.02em' }}
                >
                    {String(item.entity_id).padStart(6, '0')}
                </span>
                {item.status && (
                    <span
                        className="text-[10px] font-bold tracking-wide uppercase truncate mb-1"
                        style={{ color: statusColor }}
                    >
                        {item.status}
                    </span>
                )}

                {/* Title */}
                <h3
                    className={`font-semibold leading-tight mb-1 truncate ${compact ? 'text-[13px]' : 'text-[15px]'}`}
                    style={{
                        fontFamily: 'Manrope, sans-serif',
                        letterSpacing: '-0.03em',
                        color: 'var(--sched-ink-1)',
                        margin: 0,
                    }}
                >
                    {item.title}
                </h3>

                {/* Time (only in non-compact) */}
                {!compact && timeLabel && (
                    <p className="text-xs font-semibold mb-1" style={{ color: 'var(--sched-ink-2)', margin: 0 }}>
                        {timeLabel}
                    </p>
                )}

                {/* Subtitle — "Customer, City" (only in non-compact and if there's space) */}
                {!compact && subtitleCity && (
                    <p className="text-[13px] truncate mb-1" style={{ color: 'var(--sched-ink-2)', lineHeight: 1.4, margin: 0 }}>
                        {subtitleCity}
                    </p>
                )}

                {/* Footer meta */}
                <div className="flex items-center justify-between gap-3 mt-auto text-[11px] font-semibold" style={{ color: 'var(--sched-ink-3)' }}>
                    <span className="truncate">{techSummary}</span>
                    {item.address_summary && (
                        item.google_maps_url ? (
                            <a
                                href={item.google_maps_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={stop}
                                onKeyDown={stop as unknown as React.KeyboardEventHandler}
                                className="truncate hover:underline"
                                style={{ color: 'var(--sched-ink-2)' }}
                                title={item.normalized_address || item.address_summary}
                            >
                                {item.address_summary}
                            </a>
                        ) : (
                            <span className="truncate" title={item.address_summary}>{item.address_summary}</span>
                        )
                    )}
                </div>
                {geoLabel && (
                    <span className="text-[10px] truncate" style={{ color: 'var(--sched-ink-3)', opacity: 0.85 }}>
                        {geoLabel}
                    </span>
                )}
            </div>
        </div>
    );
};

