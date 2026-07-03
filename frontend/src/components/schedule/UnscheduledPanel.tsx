/**
 * UnscheduledPanel — Horizontal scrollable row of unscheduled items.
 * LAYOUT-CANON п.7: контейнер невидим — eyebrow-заголовок и карточки лежат прямо
 * на канвасе; белую поверхность несут сами карточки (ScheduleItemCard).
 */

import React from 'react';
import { ScheduleItemCard } from './ScheduleItemCard';
import type { ScheduleItem } from '../../services/scheduleApi';

interface UnscheduledPanelProps {
    items: ScheduleItem[];
    onSelectItem: (item: ScheduleItem) => void;
    onCopy?: (jobId: number) => void;
}

export const UnscheduledPanel: React.FC<UnscheduledPanelProps> = ({ items, onSelectItem, onCopy }) => {
    if (items.length === 0) return null;

    return (
        <div className="flex flex-col gap-2">
            {/* Eyebrow header — прямо на канвасе, без плашки */}
            <div className="flex items-end justify-between gap-4 flex-wrap">
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
                        <ScheduleItemCard item={item} onClick={onSelectItem} onCopy={onCopy} />
                    </div>
                ))}
            </div>
        </div>
    );
};
