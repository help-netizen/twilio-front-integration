/**
 * ScheduleItemCard — Small card rendered inside calendar time slots.
 */

import React from 'react';
import { Briefcase, UserPlus, CheckSquare } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import type { ScheduleItem } from '../../services/scheduleApi';

// ── Color config per entity type ─────────────────────────────────────────────

const ENTITY_STYLES: Record<string, { bg: string; border: string; text: string; icon: React.ElementType }> = {
    job:  { bg: 'bg-blue-50',  border: 'border-blue-400',  text: 'text-blue-700',  icon: Briefcase },
    lead: { bg: 'bg-amber-50', border: 'border-amber-400', text: 'text-amber-700', icon: UserPlus },
    task: { bg: 'bg-green-50', border: 'border-green-400', text: 'text-green-700', icon: CheckSquare },
};

interface ScheduleItemCardProps {
    item: ScheduleItem;
    compact?: boolean;
    onClick?: (item: ScheduleItem) => void;
}

export const ScheduleItemCard: React.FC<ScheduleItemCardProps> = ({ item, compact = false, onClick }) => {
    const style = ENTITY_STYLES[item.entity_type] ?? ENTITY_STYLES.task;
    const Icon = style.icon;
    const isUnassigned = !item.assigned_techs?.length;

    const timeLabel = item.start_at
        ? format(parseISO(item.start_at), 'h:mm a')
        : 'Unscheduled';

    return (
        <button
            type="button"
            onClick={() => onClick?.(item)}
            className={`
                w-full text-left rounded-md border-l-[3px] px-2 py-1 transition-colors
                hover:ring-1 hover:ring-offset-1 cursor-pointer
                ${style.bg} ${style.border} ${style.text}
                ${isUnassigned ? 'border-dashed border-gray-400 bg-gray-50 text-gray-600' : ''}
                ${compact ? 'text-xs' : 'text-sm'}
            `}
        >
            <div className="flex items-center gap-1 min-w-0">
                <Icon className={compact ? 'size-3 flex-shrink-0' : 'size-3.5 flex-shrink-0'} />
                <span className="truncate font-medium">{item.title}</span>
            </div>
            {!compact && (
                <div className="flex items-center gap-1 mt-0.5 text-xs opacity-75">
                    <span>{timeLabel}</span>
                    {item.customer_name && (
                        <>
                            <span>&middot;</span>
                            <span className="truncate">{item.customer_name}</span>
                        </>
                    )}
                </div>
            )}
        </button>
    );
};

export { ENTITY_STYLES };
