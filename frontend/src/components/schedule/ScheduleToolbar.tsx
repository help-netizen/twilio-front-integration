/**
 * ScheduleToolbar — View tabs, date navigation, and filters.
 */

import React from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { format, startOfWeek, endOfWeek } from 'date-fns';
import { Button } from '../ui/button';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { Input } from '../ui/input';
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../ui/select';
import type { ViewMode } from '../../hooks/useScheduleData';
import type { ScheduleFilters } from '../../services/scheduleApi';

interface ScheduleToolbarProps {
    viewMode: ViewMode;
    currentDate: Date;
    filters: Partial<ScheduleFilters>;
    onViewModeChange: (mode: ViewMode) => void;
    onNavigateDate: (dir: 'prev' | 'next' | 'today') => void;
    onFiltersChange: (filters: Partial<ScheduleFilters>) => void;
}

function getDateLabel(date: Date, viewMode: ViewMode): string {
    switch (viewMode) {
        case 'day':
        case 'timeline':
            return format(date, 'EEEE, MMM d, yyyy');
        case 'week':
        case 'timeline-week': {
            const start = startOfWeek(date);
            const end = endOfWeek(date);
            return format(start, 'MMM d') + ' – ' + format(end, 'MMM d, yyyy');
        }
        case 'month':
            return format(date, 'MMMM yyyy');
    }
}

export const ScheduleToolbar: React.FC<ScheduleToolbarProps> = ({
    viewMode,
    currentDate,
    filters,
    onViewModeChange,
    onNavigateDate,
    onFiltersChange,
}) => {
    return (
        <div className="flex flex-col gap-3 p-4 border-b bg-white">
            {/* Row 1: View tabs + Date nav */}
            <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-3">
                    <Tabs value={viewMode} onValueChange={v => onViewModeChange(v as ViewMode)}>
                        <TabsList>
                            <TabsTrigger value="day">Day</TabsTrigger>
                            <TabsTrigger value="week">Week</TabsTrigger>
                            <TabsTrigger value="month">Month</TabsTrigger>
                            <TabsTrigger value="timeline">Timeline</TabsTrigger>
                            <TabsTrigger value="timeline-week">TL Week</TabsTrigger>
                        </TabsList>
                    </Tabs>

                    <div className="flex items-center gap-1">
                        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => onNavigateDate('prev')}>
                            <ChevronLeft className="size-4" />
                        </Button>
                        <Button variant="outline" size="sm" className="h-8 px-3 text-sm" onClick={() => onNavigateDate('today')}>
                            Today
                        </Button>
                        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => onNavigateDate('next')}>
                            <ChevronRight className="size-4" />
                        </Button>
                    </div>

                    <h2 className="text-lg font-semibold text-gray-900 whitespace-nowrap">
                        {getDateLabel(currentDate, viewMode)}
                    </h2>
                </div>
            </div>

            {/* Row 2: Filters */}
            <div className="flex items-center gap-2 flex-wrap">
                <div className="relative w-52">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                    <Input
                        placeholder="Search..."
                        className="pl-8 h-8 text-sm"
                        value={filters.search ?? ''}
                        onChange={e => onFiltersChange({ ...filters, search: e.target.value || undefined })}
                    />
                </div>

                <Select
                    value={filters.entityTypes?.join(',') || 'all'}
                    onValueChange={v => onFiltersChange({
                        ...filters,
                        entityTypes: v === 'all' ? undefined : [v],
                    })}
                >
                    <SelectTrigger className="h-8 w-32 text-sm">
                        <SelectValue placeholder="All Types" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">All Types</SelectItem>
                        <SelectItem value="job">Jobs</SelectItem>
                        <SelectItem value="lead">Leads</SelectItem>
                        <SelectItem value="task">Tasks</SelectItem>
                    </SelectContent>
                </Select>

                <Select
                    value={filters.unassignedOnly ? 'unassigned' : 'all-assigned'}
                    onValueChange={v => onFiltersChange({
                        ...filters,
                        unassignedOnly: v === 'unassigned' ? true : undefined,
                    })}
                >
                    <SelectTrigger className="h-8 w-36 text-sm">
                        <SelectValue placeholder="All Assignments" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all-assigned">All</SelectItem>
                        <SelectItem value="unassigned">Unassigned Only</SelectItem>
                    </SelectContent>
                </Select>
            </div>
        </div>
    );
};
