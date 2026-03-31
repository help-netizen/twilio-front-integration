/**
 * ScheduleItemCard — Gradient card for schedule items.
 * Sprint 7 Design Refresh: warm palette, gradient backgrounds, accent borders.
 */

import React from 'react';
import type { ScheduleItem } from '../../services/scheduleApi';
import { formatTimeInTZ } from '../../utils/companyTime';
import { getProviderColor } from '../../utils/providerColors';

// Neutral style for unassigned items
const UNASSIGNED_STYLE = {
    gradient: 'linear-gradient(180deg, rgba(248, 246, 242, 0.98), rgba(240, 237, 232, 0.94))',
    border: 'rgba(117, 106, 89, 0.18)',
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
    timezone?: string;
}

export const ScheduleItemCard: React.FC<ScheduleItemCardProps> = ({ item, compact = false, onClick, timezone }) => {
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

    return (
        <button
            type="button"
            onClick={() => onClick?.(item)}
            className={`
                w-full h-full text-left overflow-hidden transition-shadow cursor-pointer
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
            <div className="p-3.5 pb-3 h-full flex flex-col" style={{ paddingLeft: '14px' }}>
                {/* Header: entity badge + status badge */}
                <div className="flex items-center justify-between gap-2 mb-1.5">
                    <span
                        className="inline-flex items-center justify-center min-h-[22px] px-2 rounded-full text-[10px] font-bold tracking-wider uppercase"
                        style={{
                            background: 'rgba(255, 255, 255, 0.54)',
                            border: '1px solid rgba(118, 106, 89, 0.14)',
                            color: 'var(--sched-ink-2)',
                        }}
                    >
                        {item.entity_type} #{String(item.entity_id).padStart(6, '0')}
                    </span>
                    {item.status && (
                        <span
                            className="inline-flex items-center justify-center min-h-[22px] px-2 rounded-full text-[10px] font-bold tracking-wide uppercase"
                            style={{
                                background: 'rgba(255, 255, 255, 0.72)',
                                border: '1px solid rgba(118, 106, 89, 0.14)',
                                color: statusColor,
                            }}
                        >
                            {item.status}
                        </span>
                    )}
                </div>

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

                {/* Subtitle (only in non-compact and if there's space) */}
                {!compact && item.subtitle && (
                    <p className="text-[13px] truncate mb-1" style={{ color: 'var(--sched-ink-2)', lineHeight: 1.4, margin: 0 }}>
                        {item.subtitle}
                    </p>
                )}

                {/* Footer meta */}
                <div className="flex items-center justify-between gap-3 mt-auto text-[11px] font-semibold" style={{ color: 'var(--sched-ink-3)' }}>
                    <span className="truncate">{techSummary}</span>
                    {item.address_summary && <span className="truncate">{item.address_summary}</span>}
                </div>
            </div>
        </button>
    );
};

