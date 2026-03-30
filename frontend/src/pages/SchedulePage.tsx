/**
 * SchedulePage — Dispatch/schedule calendar MVP.
 */

import { useScheduleData } from '../hooks/useScheduleData';
import { ScheduleToolbar } from '../components/schedule/ScheduleToolbar';
import { WeekView } from '../components/schedule/WeekView';
import { DayView } from '../components/schedule/DayView';
import { MonthView } from '../components/schedule/MonthView';
import { TimelineView } from '../components/schedule/TimelineView';
import { TimelineWeekView } from '../components/schedule/TimelineWeekView';
import { ScheduleSidebar } from '../components/schedule/ScheduleSidebar';
import { UnscheduledPanel } from '../components/schedule/UnscheduledPanel';
import { Skeleton } from '../components/ui/skeleton';

export function SchedulePage() {
    const schedule = useScheduleData();

    const handleMonthDaySelect = (date: Date) => {
        schedule.setCurrentDate(date);
        schedule.setViewMode('day');
    };

    return (
        <div className="flex h-full bg-white">
            {/* Main content area */}
            <div className="flex flex-col flex-1 min-w-0 overflow-hidden min-h-0">
                {/* Toolbar */}
                <ScheduleToolbar
                    viewMode={schedule.viewMode}
                    currentDate={schedule.currentDate}
                    filters={schedule.filters}
                    onViewModeChange={schedule.setViewMode}
                    onNavigateDate={schedule.navigateDate}
                    onFiltersChange={schedule.setFilters}
                />

                {/* Calendar view */}
                <div className="flex-1 overflow-auto min-h-0">
                    {schedule.loading ? (
                        <div className="p-6 space-y-4">
                            <Skeleton className="h-8 w-full" />
                            <Skeleton className="h-64 w-full" />
                            <Skeleton className="h-8 w-3/4" />
                        </div>
                    ) : schedule.error ? (
                        <div className="flex items-center justify-center h-full">
                            <div className="text-center">
                                <p className="text-sm text-red-600 mb-2">{schedule.error}</p>
                                <button
                                    onClick={schedule.refresh}
                                    className="text-sm text-blue-600 hover:underline"
                                >
                                    Retry
                                </button>
                            </div>
                        </div>
                    ) : (
                        <>
                            {schedule.viewMode === 'week' && (
                                <WeekView
                                    currentDate={schedule.currentDate}
                                    items={schedule.scheduledItems}
                                    settings={schedule.settings}
                                    onSelectItem={schedule.selectItem}
                                />
                            )}
                            {schedule.viewMode === 'day' && (
                                <DayView
                                    currentDate={schedule.currentDate}
                                    items={schedule.scheduledItems}
                                    settings={schedule.settings}
                                    onSelectItem={schedule.selectItem}
                                />
                            )}
                            {schedule.viewMode === 'month' && (
                                <MonthView
                                    currentDate={schedule.currentDate}
                                    items={schedule.scheduledItems}
                                    settings={schedule.settings}
                                    onSelectDay={handleMonthDaySelect}
                                    onSelectItem={schedule.selectItem}
                                />
                            )}
                            {schedule.viewMode === 'timeline' && (
                                <TimelineView
                                    currentDate={schedule.currentDate}
                                    items={schedule.scheduledItems}
                                    settings={schedule.settings}
                                    onSelectItem={schedule.selectItem}
                                />
                            )}
                            {schedule.viewMode === 'timeline-week' && (
                                <TimelineWeekView
                                    currentDate={schedule.currentDate}
                                    items={schedule.scheduledItems}
                                    settings={schedule.settings}
                                    onSelectItem={schedule.selectItem}
                                />
                            )}
                        </>
                    )}
                </div>

                {/* Unscheduled panel */}
                {!schedule.loading && (
                    <UnscheduledPanel
                        items={schedule.unscheduledItems}
                        onSelectItem={schedule.selectItem}
                    />
                )}
            </div>

            {/* Sidebar when item selected */}
            {schedule.selectedItem && (
                <ScheduleSidebar
                    item={schedule.selectedItem}
                    onClose={schedule.clearSelection}
                    timezone={schedule.settings.timezone}
                />
            )}
        </div>
    );
}
