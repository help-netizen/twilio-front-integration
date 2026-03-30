/**
 * ScheduleItemCard — Small card rendered inside calendar time slots.
 * Timezone-aware: time labels use company TZ when provided.
 * Shows status badge, assignment info, and stretches to fill container.
 */

import React from 'react';
import { Briefcase, UserPlus, CheckSquare, Users } from 'lucide-react';
import type { ScheduleItem } from '../../services/scheduleApi';
import { formatTimeInTZ } from '../../utils/companyTime';

// ── Color config per entity type ─────────────────────────────────────────────

const ENTITY_STYLES: Record<string, { bg: string; border: string; text: string; icon: React.ElementType }> = {
    job:  { bg: 'bg-blue-50',  border: 'border-blue-400',  text: 'text-blue-700',  icon: Briefcase },
    lead: { bg: 'bg-amber-50', border: 'border-amber-400', text: 'text-amber-700', icon: UserPlus },
    task: { bg: 'bg-green-50', border: 'border-green-400', text: 'text-green-700', icon: CheckSquare },
};

// ── Status badge colors ─────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
    // Job statuses
    new:           { bg: 'bg-gray-100',    text: 'text-gray-600',   label: 'New' },
    submitted:     { bg: 'bg-blue-100',    text: 'text-blue-700',   label: 'Submitted' },
    scheduled:     { bg: 'bg-indigo-100',  text: 'text-indigo-700', label: 'Scheduled' },
    en_route:      { bg: 'bg-teal-100',    text: 'text-teal-700',   label: 'En Route' },
    in_progress:   { bg: 'bg-orange-100',  text: 'text-orange-700', label: 'In Progress' },
    completed:     { bg: 'bg-green-100',   text: 'text-green-700',  label: 'Completed' },
    canceled:      { bg: 'bg-red-100',     text: 'text-red-700',    label: 'Canceled' },
    cancelled:     { bg: 'bg-red-100',     text: 'text-red-700',    label: 'Canceled' },
    rescheduled:   { bg: 'bg-purple-100',  text: 'text-purple-700', label: 'Rescheduled' },
    // Lead statuses
    contacted:     { bg: 'bg-blue-100',    text: 'text-blue-700',   label: 'Contacted' },
    qualified:     { bg: 'bg-emerald-100', text: 'text-emerald-700', label: 'Qualified' },
    unqualified:   { bg: 'bg-gray-100',    text: 'text-gray-500',   label: 'Unqualified' },
    converted:     { bg: 'bg-green-100',   text: 'text-green-700',  label: 'Converted' },
};

interface ScheduleItemCardProps {
    item: ScheduleItem;
    compact?: boolean;
    onClick?: (item: ScheduleItem) => void;
    /** Company timezone for time label formatting */
    timezone?: string;
}

export const ScheduleItemCard: React.FC<ScheduleItemCardProps> = ({ item, compact = false, onClick, timezone }) => {
    const style = ENTITY_STYLES[item.entity_type] ?? ENTITY_STYLES.task;
    const Icon = style.icon;
    const isUnassigned = !item.assigned_techs?.length;
    const statusKey = (item.status || '').toLowerCase().replace(/\s+/g, '_');
    const statusStyle = STATUS_STYLES[statusKey];
    const isCanceled = statusKey === 'canceled' || statusKey === 'cancelled';

    const timeLabel = item.start_at
        ? formatTimeInTZ(new Date(item.start_at), timezone)
        : 'Unscheduled';

    const techCount = item.assigned_techs?.length || 0;

    return (
        <button
            type="button"
            onClick={() => onClick?.(item)}
            className={`
                w-full h-full text-left rounded-md border-l-[3px] px-2 py-1 transition-colors overflow-hidden
                hover:ring-1 hover:ring-offset-1 cursor-pointer
                focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 outline-none
                ${style.bg} ${style.border} ${style.text}
                ${isUnassigned ? 'border-dashed border-gray-400 bg-gray-50 text-gray-600' : ''}
                ${isCanceled ? 'opacity-60 line-through decoration-1' : ''}
                ${compact ? 'text-xs' : 'text-sm'}
            `}
        >
            {compact ? (
                <>
                    {/* Compact Row 1: icon + title (full width — no badge competing) */}
                    <div className="flex items-center gap-1 min-w-0">
                        <Icon className="size-3 flex-shrink-0" />
                        <span className="truncate font-medium flex-1">{item.title}</span>
                    </div>
                    {/* Compact Row 2: customer name + status badge */}
                    <div className="flex items-center gap-1 mt-0.5 min-w-0">
                        {item.customer_name ? (
                            <span className="truncate text-[10px] opacity-75 flex-1">{item.customer_name}</span>
                        ) : isUnassigned ? (
                            <span className="text-[10px] text-gray-400 italic flex-1">Unassigned</span>
                        ) : (
                            <span className="flex-1" />
                        )}
                        {statusStyle && (
                            <span className={`${statusStyle.bg} ${statusStyle.text} px-1 py-0 rounded text-[10px] leading-tight font-medium flex-shrink-0 no-underline`} style={{ textDecoration: 'none' }}>
                                {statusStyle.label}
                            </span>
                        )}
                    </div>
                </>
            ) : (
                <>
                    {/* Row 1: icon + title + status badge */}
                    <div className="flex items-center gap-1 min-w-0">
                        <Icon className="size-3.5 flex-shrink-0" />
                        <span className="truncate font-medium flex-1">{item.title}</span>
                        {statusStyle && (
                            <span className={`${statusStyle.bg} ${statusStyle.text} px-1 py-0 rounded text-[11px] leading-tight font-medium flex-shrink-0 no-underline`} style={{ textDecoration: 'none' }}>
                                {statusStyle.label}
                            </span>
                        )}
                    </div>
                    {/* Row 2: time + customer + assignment */}
                    <div className="flex items-center gap-1 mt-0.5 text-xs opacity-75">
                        <span>{timeLabel}</span>
                        {item.customer_name && (
                            <>
                                <span>&middot;</span>
                                <span className="truncate">{item.customer_name}</span>
                            </>
                        )}
                        {isUnassigned && (
                            <span className="ml-auto text-[11px] text-gray-400 italic flex-shrink-0">Unassigned</span>
                        )}
                        {techCount > 1 && (
                            <span className="ml-auto flex items-center gap-0.5 text-[11px] text-gray-500 flex-shrink-0">
                                <Users className="size-3" />+{techCount - 1}
                            </span>
                        )}
                    </div>
                </>
            )}
        </button>
    );
};

export { ENTITY_STYLES };
