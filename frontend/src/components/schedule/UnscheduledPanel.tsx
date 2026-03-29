/**
 * UnscheduledPanel — Collapsible panel listing items without start_at.
 */

import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { ScrollArea } from '../ui/scroll-area';
import { ScheduleItemCard } from './ScheduleItemCard';
import type { ScheduleItem } from '../../services/scheduleApi';

interface UnscheduledPanelProps {
    items: ScheduleItem[];
    onSelectItem: (item: ScheduleItem) => void;
}

export const UnscheduledPanel: React.FC<UnscheduledPanelProps> = ({ items, onSelectItem }) => {
    const [expanded, setExpanded] = useState(false);

    if (items.length === 0) return null;

    return (
        <div className="border-t bg-gray-50/50">
            {/* Toggle header */}
            <Button
                variant="ghost"
                className="w-full flex items-center justify-between px-4 py-2 h-auto rounded-none hover:bg-gray-100"
                onClick={() => setExpanded(v => !v)}
            >
                <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
                    {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                    Unscheduled
                    <Badge variant="secondary" className="text-xs">{items.length}</Badge>
                </div>
            </Button>

            {/* Cards */}
            {expanded && (
                <ScrollArea className="max-h-48">
                    <div className="px-4 pb-3 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                        {items.map(item => (
                            <ScheduleItemCard
                                key={`${item.entity_type}-${item.entity_id}`}
                                item={item}
                                onClick={onSelectItem}
                            />
                        ))}
                    </div>
                </ScrollArea>
            )}
        </div>
    );
};
