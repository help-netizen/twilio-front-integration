/**
 * SchedulePage — Dispatch/schedule calendar.
 * Sprint 7 Design Refresh: warm gradient background, CSS Grid layout,
 * toolbar split (ScheduleToolbar + CalendarControls), AI Assistant modal.
 */

import { useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useScheduleData } from '../hooks/useScheduleData';
import { useJobDetail } from '../hooks/useJobDetail';
import { ScheduleToolbar } from '../components/schedule/ScheduleToolbar';
import { CalendarControls } from '../components/schedule/CalendarControls';
import { AIAssistantModal } from '../components/schedule/AIAssistantModal';
import { WeekView } from '../components/schedule/WeekView';
import { DayView } from '../components/schedule/DayView';
import { MonthView } from '../components/schedule/MonthView';
import { TimelineView } from '../components/schedule/TimelineView';
import { TimelineWeekView } from '../components/schedule/TimelineWeekView';
import { ListView } from '../components/schedule/ListView';
import { formatTimeInTZ } from '../utils/companyTime';
import { NewJobDialog } from '../components/jobs/NewJobDialog';
import { buildCopyJobData, type CopyJobData } from '../components/jobs/copyJobData';
import { getJob } from '../services/jobsApi';
import { SidebarStack } from '../components/schedule/SidebarStack';
import { UnscheduledPanel } from '../components/schedule/UnscheduledPanel';
import { DispatchSettingsDialog } from '../components/schedule/DispatchSettingsDialog';
import { FloatingDetailPanel } from '../components/ui/FloatingDetailPanel';
import { JobDetailPanel } from '../components/jobs/JobDetailPanel';
import { Skeleton } from '../components/ui/skeleton';
import type { ScheduleItem } from '../services/scheduleApi';

export function SchedulePage() {
    const schedule = useScheduleData();
    const navigate = useNavigate();
    const [settingsOpen, setSettingsOpen] = useState(false);
    // Dispatch-only controls hidden for providers without schedule.dispatch (PF007)
    const canDispatch = schedule.canDispatch;
    const [showAIAssistant, setShowAIAssistant] = useState(false);

    // ─── Job detail floating panel (same as Jobs page) ───────────────
    const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
    const jobDetail = useJobDetail({
        jobId: selectedJobId,
        onJobMutated: schedule.refresh,
    });

    /** When a schedule item is clicked, jobs open in FloatingDetailPanel; others go to SidebarStack */
    const handleSelectItem = useCallback((item: ScheduleItem) => {
        if (item.entity_type === 'job') {
            setSelectedJobId(item.entity_id);
        } else {
            schedule.selectItem(item);
        }
    }, [schedule.selectItem]);

    const handleCloseJobDetail = useCallback(() => {
        setSelectedJobId(null);
    }, []);

    const handleMonthDaySelect = (date: Date) => {
        schedule.setCurrentDate(date);
        schedule.setViewMode('day');
    };

    // SCHED-ROUTE-001 FR-001: a slot click opens the New Job modal (title +
    // address) rather than creating a bare job immediately, so the address can
    // feed geocoding/routing.
    const [newJobSlot, setNewJobSlot] = useState<{ startAt: string; endAt: string; providerId?: string; providerName?: string } | null>(null);
    // Full New Job form opened from the Schedule header button (create from scratch).
    const [newJobOpen, setNewJobOpen] = useState(false);

    // "Copy job" — pre-fill the New Job form from an existing job's data.
    const [copyFrom, setCopyFrom] = useState<CopyJobData | null>(null);
    const handleCopyJob = useCallback((jobId: number) => {
        getJob(jobId)
            .then(j => setCopyFrom(buildCopyJobData(j)))
            .catch(err => console.error('[Copy job] failed to load job', jobId, err));
    }, []);

    const handleCreateFromSlot = useCallback((_title: string, startAt: string, endAt: string, providerId?: string, providerName?: string) => {
        setNewJobSlot({ startAt, endAt, providerId, providerName });
    }, []);

    // Calendar slot → the SAME full New Job form, with the slot + technician pre-set.
    const presetSlot = useMemo(() => newJobSlot ? {
        start: newJobSlot.startAt,
        end: newJobSlot.endAt,
        techId: newJobSlot.providerId,
        formatted: `${formatTimeInTZ(new Date(newJobSlot.startAt), schedule.settings.timezone)} – ${formatTimeInTZ(new Date(newJobSlot.endAt), schedule.settings.timezone)}${newJobSlot.providerName ? ` · ${newJobSlot.providerName}` : ''}`,
    } : null, [newJobSlot, schedule.settings.timezone]);

    const renderCalendarView = () => {
        if (schedule.loading) {
            return (
                <div className="p-6 space-y-4" style={{
                    background: 'var(--sched-surface)',
                    border: '1px solid rgba(255, 255, 255, 0.55)',
                    borderRadius: 'var(--sched-radius-xl)',
                }}>
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-64 w-full" />
                    <Skeleton className="h-8 w-3/4" />
                </div>
            );
        }

        if (schedule.error) {
            return (
                <div
                    className="flex items-center justify-center min-h-[300px]"
                    style={{
                        background: 'var(--sched-surface)',
                        border: '1px solid rgba(255, 255, 255, 0.55)',
                        borderRadius: 'var(--sched-radius-xl)',
                    }}
                >
                    <div className="text-center">
                        <p className="text-sm mb-2" style={{ color: 'var(--sched-danger)' }}>{schedule.error}</p>
                        <button onClick={schedule.refresh} className="text-sm hover:underline" style={{ color: 'var(--sched-job)' }}>
                            Retry
                        </button>
                    </div>
                </div>
            );
        }

        switch (schedule.viewMode) {
            case 'week':
                return <WeekView currentDate={schedule.currentDate} items={schedule.scheduledItems} settings={schedule.settings} onSelectItem={handleSelectItem} onCopy={handleCopyJob} onReschedule={canDispatch ? schedule.handleReschedule : undefined} onCreateFromSlot={canDispatch ? handleCreateFromSlot : undefined} />;
            case 'day':
                return <DayView currentDate={schedule.currentDate} items={schedule.scheduledItems} settings={schedule.settings} onSelectItem={handleSelectItem} onCopy={handleCopyJob} onReschedule={canDispatch ? schedule.handleReschedule : undefined} onCreateFromSlot={canDispatch ? handleCreateFromSlot : undefined} />;
            case 'month':
                return <MonthView currentDate={schedule.currentDate} items={schedule.scheduledItems} settings={schedule.settings} onSelectDay={handleMonthDaySelect} onSelectItem={handleSelectItem} />;
            case 'timeline':
                return <TimelineView currentDate={schedule.currentDate} items={schedule.scheduledItems} settings={schedule.settings} allProviders={schedule.providers} routeByPair={schedule.routeByPair} onSelectItem={handleSelectItem} onCopy={handleCopyJob} onReschedule={canDispatch ? schedule.handleReschedule : undefined} onReassign={canDispatch ? schedule.handleReassign : undefined} onCreateFromSlot={canDispatch ? handleCreateFromSlot : undefined} />;
            case 'timeline-week':
                return <TimelineWeekView currentDate={schedule.currentDate} items={schedule.scheduledItems} settings={schedule.settings} allProviders={schedule.providers} routeByPair={schedule.routeByPair} onSelectItem={handleSelectItem} onCopy={handleCopyJob} onReassign={canDispatch ? schedule.handleReassign : undefined} onCreateFromSlot={canDispatch ? handleCreateFromSlot : undefined} />;
            case 'list':
                return <ListView currentDate={schedule.currentDate} items={schedule.scheduledItems} settings={schedule.settings} allProviders={schedule.providers} routeByPair={schedule.routeByPair} onSelectItem={handleSelectItem} onCopy={handleCopyJob} onReassign={canDispatch ? schedule.handleReassign : undefined} onCreateFromSlot={canDispatch ? handleCreateFromSlot : undefined} />;
            default:
                return null;
        }
    };

    return (
        <div
            className="schedule-page-root min-h-screen relative"
            style={{
                background: 'radial-gradient(circle at top left, rgba(255, 255, 255, 0.9), transparent 28%), linear-gradient(180deg, #f7f3ec 0%, var(--sched-bg) 44%, var(--sched-bg-deep) 100%)',
                color: 'var(--sched-ink-1)',
                fontFamily: '"IBM Plex Sans", "Segoe UI", sans-serif',
            }}
        >
            {/* Background glow effects */}
            <div
                className="fixed rounded-full pointer-events-none"
                style={{
                    width: '420px', height: '420px',
                    top: '-140px', right: '-40px',
                    background: 'rgba(47, 99, 216, 0.14)',
                    filter: 'blur(30px)', opacity: 0.5,
                }}
            />
            <div
                className="fixed rounded-full pointer-events-none"
                style={{
                    width: '360px', height: '360px',
                    bottom: '80px', left: '-60px',
                    background: 'rgba(178, 106, 29, 0.12)',
                    filter: 'blur(30px)', opacity: 0.5,
                }}
            />

            {/* Main workspace */}
            <div className="schedule-workspace relative z-[1] max-w-[1780px] mx-auto" style={{ padding: '24px' }}>
                {/* Toolbar: title + AI Assistant button */}
                <ScheduleToolbar
                    onToggleAIAssistant={() => setShowAIAssistant(true)}
                    onNewJob={canDispatch ? () => setNewJobOpen(true) : undefined}
                />

                {/* Main content */}
                <div className="schedule-page-grid grid gap-3 mt-3">
                    {/* Unscheduled panel — above controls for ASAP scheduling priority */}
                    {!schedule.loading && (
                        <UnscheduledPanel
                            items={schedule.unscheduledItems}
                            onSelectItem={handleSelectItem}
                            onCopy={handleCopyJob}
                        />
                    )}

                    {/* Calendar Controls — view mode, date nav, filters */}
                    <CalendarControls
                        viewMode={schedule.viewMode}
                        currentDate={schedule.currentDate}
                        filters={schedule.filters}
                        itemCounts={schedule.itemCounts}
                        loading={schedule.loading}
                        providers={schedule.providers}
                        allTags={schedule.allTags}
                        onViewModeChange={schedule.setViewMode}
                        onNavigateDate={schedule.navigateDate}
                        onFiltersChange={schedule.setFilters}
                        onOpenSettings={canDispatch ? () => setSettingsOpen(true) : undefined}
                    />

                    {/* Calendar view */}
                    {renderCalendarView()}
                </div>

                {/* Sidebar stack — fixed position, outside grid */}
                <SidebarStack
                    stack={schedule.sidebarStack}
                    onPopLayer={schedule.popLayer}
                    onClearStack={schedule.clearStack}
                    onPushLayer={schedule.pushLayer}
                    timezone={schedule.settings.timezone}
                />
            </div>

            {/* Job detail panel — same FloatingDetailPanel as Jobs page */}
            <FloatingDetailPanel open={!!jobDetail.job} onClose={handleCloseJobDetail} wide>
                {jobDetail.job && (
                    <JobDetailPanel
                        job={jobDetail.job}
                        contactInfo={jobDetail.contactInfo}
                        detailLoading={jobDetail.detailLoading}
                        noteJobId={jobDetail.noteJobId}
                        noteText={jobDetail.noteText}
                        setNoteText={jobDetail.setNoteText}
                        setNoteJobId={jobDetail.setNoteJobId}
                        onClose={handleCloseJobDetail}
                        onBlancStatusChange={jobDetail.handleBlancStatusChange}
                        onAddNote={jobDetail.handleAddNote}
                        onMarkEnroute={jobDetail.handleMarkEnroute}
                        onMarkInProgress={jobDetail.handleMarkInProgress}
                        onMarkComplete={jobDetail.handleMarkComplete}
                        onCancel={jobDetail.handleCancel}
                        navigate={navigate}
                        allTags={jobDetail.allTags}
                        onTagsChange={jobDetail.handleTagsChange}
                        onJobUpdated={jobDetail.handleJobUpdated}
                    />
                )}
            </FloatingDetailPanel>

            {/* AI Assistant Modal */}
            <AIAssistantModal
                isOpen={showAIAssistant}
                onClose={() => setShowAIAssistant(false)}
                onSubmit={(input) => {
                    console.log('[AI Schedule Assistant] Submitted:', input);
                }}
            />

            {/* Settings dialog */}
            <DispatchSettingsDialog
                open={settingsOpen}
                onClose={() => setSettingsOpen(false)}
                settings={schedule.settings}
                onSave={schedule.handleUpdateSettings}
            />

            {/* Calendar slot → the full New Job form with the slot + technician pre-set */}
            <NewJobDialog open={!!newJobSlot} presetSlot={presetSlot} onClose={() => setNewJobSlot(null)} />

            {/* Full New Job form (header button) — create a job from scratch */}
            <NewJobDialog open={newJobOpen} onClose={() => setNewJobOpen(false)} />

            {/* Copy job — New Job form pre-filled from an existing job */}
            <NewJobDialog open={!!copyFrom} copyFrom={copyFrom} onClose={() => setCopyFrom(null)} />
        </div>
    );
}
