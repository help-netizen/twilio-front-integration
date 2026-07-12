/**
 * SchedulePage — Dispatch/schedule calendar.
 * Sprint 7 Design Refresh: warm gradient background, CSS Grid layout,
 * toolbar split (ScheduleToolbar + CalendarControls), AI Assistant modal.
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useScheduleData } from '../hooks/useScheduleData';
import { useJobDetail } from '../hooks/useJobDetail';
import { useIsMobile } from '../hooks/useIsMobile';
import { ScheduleToolbar } from '../components/schedule/ScheduleToolbar';
import { CalendarControls } from '../components/schedule/CalendarControls';
import { MobileScheduleBar } from '../components/schedule/MobileScheduleBar';
import { AIAssistantModal } from '../components/schedule/AIAssistantModal';
import { WeekView } from '../components/schedule/WeekView';
import { DayView } from '../components/schedule/DayView';
import { ScheduleJobsMap } from '../components/schedule/ScheduleJobsMap';
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
import { TimeOffDialog } from '../components/schedule/TimeOffDialog';
import { CalendarOff } from 'lucide-react';
import { FloatingDetailPanel } from '../components/ui/FloatingDetailPanel';
import { JobDetailPanel } from '../components/jobs/JobDetailPanel';
import { Skeleton } from '../components/ui/skeleton';
import type { ScheduleItem } from '../services/scheduleApi';

export function SchedulePage() {
    const schedule = useScheduleData();
    const navigate = useNavigate();
    const isMobile = useIsMobile();
    const [settingsOpen, setSettingsOpen] = useState(false);
    // TECH-DAYOFF-001: day-off management panel (dispatch-only, like settings).
    const [timeOffOpen, setTimeOffOpen] = useState(false);
    // Dispatch-only controls hidden for providers without schedule.dispatch (PF007)
    const canDispatch = schedule.canDispatch;
    const [showAIAssistant, setShowAIAssistant] = useState(false);
    // SCHEDULE-MOBILE-MAP-001: mobile day list⇄map toggle. Map is mobile-only —
    // reset to list whenever we leave mobile width so desktop never renders it.
    const [mobileMapOpen, setMobileMapOpen] = useState(false);
    useEffect(() => { if (!isMobile) setMobileMapOpen(false); }, [isMobile]);

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
                    background: 'var(--blanc-surface-strong)',
                    border: '1px solid var(--sched-line)',
                    borderRadius: 'var(--sched-radius-md)',
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
                        background: 'var(--blanc-surface-strong)',
                        border: '1px solid var(--sched-line)',
                        borderRadius: 'var(--sched-radius-md)',
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
                // Mobile-only: the map replaces the day list (full-width) when toggled on.
                if (isMobile && mobileMapOpen) {
                    return <ScheduleJobsMap jobs={schedule.scheduledItems} companyTz={schedule.settings.timezone} selectedProviderIds={schedule.filters.providerIds} />;
                }
                return <DayView currentDate={schedule.currentDate} items={schedule.scheduledItems} settings={schedule.settings} onSelectItem={handleSelectItem} onCopy={handleCopyJob} onReschedule={canDispatch ? schedule.handleReschedule : undefined} onCreateFromSlot={canDispatch ? handleCreateFromSlot : undefined} routeByPair={schedule.routeByPair} timeOff={schedule.timeOff} providerFilterIds={schedule.filters.providerIds} />;
            case 'month':
                return <MonthView currentDate={schedule.currentDate} items={schedule.scheduledItems} settings={schedule.settings} onSelectDay={handleMonthDaySelect} onSelectItem={handleSelectItem} />;
            case 'timeline':
                return <TimelineView currentDate={schedule.currentDate} items={schedule.scheduledItems} settings={schedule.settings} allProviders={schedule.providers} routeByPair={schedule.routeByPair} timeOff={schedule.timeOff} providerFilterIds={schedule.filters.providerIds} onSelectItem={handleSelectItem} onCopy={handleCopyJob} onReschedule={canDispatch ? schedule.handleReschedule : undefined} onReassign={canDispatch ? schedule.handleReassign : undefined} onCreateFromSlot={canDispatch ? handleCreateFromSlot : undefined} />;
            case 'timeline-week':
                return <TimelineWeekView currentDate={schedule.currentDate} items={schedule.scheduledItems} settings={schedule.settings} allProviders={schedule.providers} routeByPair={schedule.routeByPair} timeOff={schedule.timeOff} providerFilterIds={schedule.filters.providerIds} onSelectItem={handleSelectItem} onCopy={handleCopyJob} onReassign={canDispatch ? schedule.handleReassign : undefined} onCreateFromSlot={canDispatch ? handleCreateFromSlot : undefined} />;
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
                // PALETTE-V2 (Т2): плоский нейтральный канвас — тёплый градиент и
                // декоративные glow-круги сняты (LAYOUT-CANON п.7: декор под нож).
                background: 'var(--sched-bg)',
                color: 'var(--sched-ink-1)',
                fontFamily: '"IBM Plex Sans", "Segoe UI", sans-serif',
            }}
        >
            {/* Main workspace — tighter gutter on mobile (the 24px all-widths felt cramped on a phone) */}
            <div className="schedule-workspace relative z-[1] max-w-[1780px] mx-auto" style={{ padding: isMobile ? '14px' : '24px' }}>
                {isMobile ? (
                    /* ── Mobile: date-first bar + a single gear → "View options" sheet ── */
                    <MobileScheduleBar
                        currentDate={schedule.currentDate}
                        timezone={schedule.settings.timezone}
                        filters={schedule.filters}
                        providers={schedule.providers}
                        allTags={schedule.allTags}
                        onNavigateDate={schedule.navigateDate}
                        onSelectDate={schedule.setCurrentDate}
                        onFiltersChange={schedule.setFilters}
                        mapOpen={mobileMapOpen}
                        onToggleMap={() => setMobileMapOpen(v => !v)}
                        onNewJob={canDispatch ? () => setNewJobOpen(true) : undefined}
                        onToggleAIAssistant={() => setShowAIAssistant(true)}
                        onOpenSettings={canDispatch ? () => setSettingsOpen(true) : undefined}
                        onTimeOff={canDispatch ? () => setTimeOffOpen(true) : undefined}
                    />
                ) : (
                    /* Toolbar: title + AI Assistant button */
                    <ScheduleToolbar
                        onToggleAIAssistant={() => setShowAIAssistant(true)}
                        onNewJob={canDispatch ? () => setNewJobOpen(true) : undefined}
                    />
                )}

                {/* Main content */}
                <div className="schedule-page-grid grid gap-3 mt-3">
                    {/* Unscheduled panel — desktop only (off the phone's field-tech view); above controls for ASAP scheduling priority */}
                    {!isMobile && !schedule.loading && (
                        <UnscheduledPanel
                            items={schedule.unscheduledItems}
                            onSelectItem={handleSelectItem}
                            onCopy={handleCopyJob}
                        />
                    )}

                    {/* Calendar Controls — desktop only; on mobile every control lives in the sheet above.
                        TECH-DAYOFF-001: the "Time off" chip sits beside the controls row (next to the
                        settings gear), dispatch-only like the other management controls. */}
                    {!isMobile && (
                        <div className="flex items-start gap-2">
                            <div className="min-w-0 flex-1">
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
                            </div>
                            {canDispatch && (
                                <button
                                    type="button"
                                    onClick={() => setTimeOffOpen(true)}
                                    className="blanc-control-chip"
                                    style={{ display: 'inline-flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}
                                >
                                    <CalendarOff className="size-4" /> Time off
                                </button>
                            )}
                        </div>
                    )}

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
                        onNotified={jobDetail.afterMutation}
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

            {/* Time off management panel (TECH-DAYOFF-001) */}
            <TimeOffDialog
                open={timeOffOpen}
                onOpenChange={setTimeOffOpen}
                providers={schedule.providers}
                timezone={schedule.settings.timezone}
                onChanged={schedule.reloadTimeOff}
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
