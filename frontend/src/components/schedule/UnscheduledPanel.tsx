/**
 * UnscheduledPanel — Horizontal scrollable panel for unscheduled items.
 * Sprint 7 Design Refresh: frosted glass, horizontal scroll, 280px cards.
 */

import React from 'react';
import { ScheduleItemCard } from './ScheduleItemCard';
import type { ScheduleItem } from '../../services/scheduleApi';

interface UnscheduledPanelProps {
    items: ScheduleItem[];
    onSelectItem: (item: ScheduleItem) => void;
}

export const UnscheduledPanel: React.FC<UnscheduledPanelProps> = ({ items, onSelectItem }) => {
    if (items.length === 0) return null;

    return (
        <div
            className="overflow-hidden"
            style={{
                background: 'var(--sched-surface)',
                border: '1px solid rgba(255, 255, 255, 0.55)',
                borderRadius: 'var(--sched-radius-xl)',
                backdropFilter: 'blur(24px)',
                boxShadow: 'var(--sched-shadow-main)',
            }}
        >
            <div className="px-5 py-4 pb-5">
                {/* Header */}
                <div className="flex items-end justify-between gap-4 flex-wrap mb-4">
                    <p
                        className="text-[11px] font-semibold tracking-widest uppercase"
                        style={{ color: 'var(--sched-ink-3)', letterSpacing: '0.14em', margin: 0 }}
                    >
                        Unscheduled
                    </p>
                    <p
                        className="text-[11px] font-semibold tracking-widest uppercase"
                        style={{ color: 'var(--sched-ink-3)', letterSpacing: '0.14em', margin: 0 }}
                    >
                        {items.length} item{items.length !== 1 ? 's' : ''}
                    </p>
                </div>

                {/* Horizontal scrollable cards */}
                <div className="flex gap-3 overflow-x-auto pb-1" style={{ scrollbarWidth: 'thin' }}>
                    {items.map(item => (
                        <div
                            key={`${item.entity_type}-${item.entity_id}`}
                            className="flex-none"
                            style={{ width: '280px', minHeight: '148px' }}
                        >
                            <ScheduleItemCard item={item} onClick={onSelectItem} />
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};
