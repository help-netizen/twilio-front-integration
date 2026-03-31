/**
 * OverflowPopover — Floating list of schedule items that didn't fit in visible lanes.
 * Shown when user clicks "+N" overflow badge in Day/Week views.
 */

import React, { useEffect, useRef } from 'react';
import { ScheduleItemCard } from './ScheduleItemCard';
import type { ScheduleItem } from '../../services/scheduleApi';

interface OverflowPopoverProps {
    items: ScheduleItem[];
    anchorRect: DOMRect;
    onSelectItem: (item: ScheduleItem) => void;
    onClose: () => void;
    timezone?: string;
}

export const OverflowPopover: React.FC<OverflowPopoverProps> = ({
    items, anchorRect, onSelectItem, onClose, timezone,
}) => {
    const ref = useRef<HTMLDivElement>(null);

    // Close on outside click or Escape
    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onClose();
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('mousedown', handleClick);
        document.addEventListener('keydown', handleKey);
        return () => {
            document.removeEventListener('mousedown', handleClick);
            document.removeEventListener('keydown', handleKey);
        };
    }, [onClose]);

    // Position below the anchor badge, clamped to viewport
    const top = Math.min(anchorRect.bottom + 4, window.innerHeight - 200);
    const left = Math.min(anchorRect.left, window.innerWidth - 240);

    return (
        <div
            ref={ref}
            className="fixed z-50 w-56 max-h-48 overflow-auto rounded-lg border bg-white shadow-lg p-2 space-y-1"
            style={{ top, left }}
        >
            <div className="text-xs font-medium text-gray-500 px-1 mb-1">
                {items.length} more item{items.length > 1 ? 's' : ''}
            </div>
            {items.map(item => (
                <ScheduleItemCard
                    key={`${item.entity_type}-${item.entity_id}`}
                    item={item}
                    compact
                    onClick={onSelectItem}
                    timezone={timezone}
                />
            ))}
        </div>
    );
};
