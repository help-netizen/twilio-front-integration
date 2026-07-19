/**
 * PulsePage — Three-column layout: contacts | lead/contact detail | timeline + SMS
 * Responsive: mobile shows one panel at a time with back navigation.
 */
import React, { useState, useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { usePulsePage } from '../hooks/usePulsePage';
import { PulseContactItem } from '../components/pulse/PulseContactItem';
import { ActionRequiredPlaque } from '../components/pulse/ActionRequiredPlaque';
import { PulseTimeline } from '../components/pulse/PulseTimeline';
import { SmsForm } from '../components/pulse/SmsForm';
import { LeadDetailPanel } from '../components/leads/LeadDetailPanel';
import { PulseContactPanel } from '../components/contacts/PulseContactPanel';
import { PulseContactBar } from '../components/contacts/PulseContactBar';
import { openLeadsJobsCount, pickBarAddress, hasNotes } from '../components/contacts/contactBarHelpers';
import { Dialog, DialogContent, DialogBody, DialogTitle, DialogDescription } from '../components/ui/dialog';
import { TaskFormDialog } from '../components/tasks/TaskFormDialog';
import { createTask, type Task } from '../components/tasks/tasksApi';
import { CreateLeadJobWizard } from '../components/conversations/CreateLeadJobWizard';
import { OnboardingChecklistCard } from '../components/onboarding/OnboardingChecklistCard';
import { EditLeadDialog } from '../components/leads/EditLeadDialog';
import { ConvertToJobDialog } from '../components/leads/ConvertToJobDialog';
import { Skeleton } from '../components/ui/skeleton';
import { PhoneOff, Activity, ChevronLeft } from 'lucide-react';
import { callsApi } from '../services/api';
import { pulseApi } from '../services/pulseApi';
import { useAuth } from '../auth/AuthProvider';
import { useIsMobile } from '../hooks/useIsMobile';
import { useNavigate } from 'react-router-dom';
import { isAnonymousPhone } from '../utils/phoneUtils';
import { dateKeyInTZ, todayInTZ } from '../utils/companyTime';
import { PulsePlayerProvider } from '../components/pulse/pulsePlayer';
import { PulsePlayerBar } from '../components/pulse/PulsePlayerBar';
import './PulsePage.css';

const NO_DATE_KEY = '__no_date__';

const conversationNeedsAction = (conversation: any) =>
    conversation.has_open_task === true
    || (conversation.is_action_required === true && conversation.action_required_reason === 'manual');

/** Friendly group label from a "YYYY-MM-DD" date-key (mirrors JobsMobileList). */
function groupLabel(key: string, timezone: string): string {
    if (key === NO_DATE_KEY) return 'Earlier';
    const today = todayInTZ(timezone);
    // Parse keys at local noon to avoid any TZ-boundary drift when we only care
    // about the calendar date.
    const toDate = (k: string) => new Date(k + 'T12:00:00');
    const oneDay = 24 * 60 * 60 * 1000;
    const diffDays = Math.round((toDate(key).getTime() - toDate(today).getTime()) / oneDay);
    if (diffDays === 0) return 'Today';
    if (diffDays === -1) return 'Yesterday';
    return format(toDate(key), 'EEE, MMM d');
}

const PulsePageInner: React.FC = () => {
    const p = usePulsePage();
    const { company } = useAuth();
    const navigate = useNavigate();
    const isMobile = useIsMobile();
    const companyTz = company?.timezone || 'America/New_York';

    // Mobile panel state: 'list' shows sidebar, 'content' shows detail+timeline
    const [mobilePanel, setMobilePanel] = useState<'list' | 'content'>('list');
    // Sidebar filter chips
    const [activeFilter, setActiveFilter] = useState<'all' | 'unread' | 'action_required'>('all');
    // Page-level task editor — opened right after flagging a timeline for action
    // so the user can refine the freshly-created default task.
    const [taskEditor, setTaskEditor] = useState<{ parentId: number; task: Task } | null>(null);

    // PULSE-CONTACT-PIN-001: the condensed bar replaces the in-flow contact card;
    // the full card opens as an overlay panel so expansion never changes the scroll
    // container's height (reverse pagination compensates by scrollHeight).
    const [contactCardOpen, setContactCardOpen] = useState(false);
    const [contactCardSection, setContactCardSection] = useState<'notes' | 'leads-jobs' | null>(null);
    const [composerFocusSignal, setComposerFocusSignal] = useState(0);
    useEffect(() => { setContactCardOpen(false); setContactCardSection(null); }, [p.contact?.id, p.timelineId]);

    const isContactSelected = !!(p.contactId || p.timelineId);

    const displayedCalls = activeFilter === 'all'
        ? p.filteredCalls
        : activeFilter === 'unread'
            ? p.filteredCalls.filter((c: any) => c.tl_has_unread || c.sms_has_unread || c.has_unread)
            : p.filteredCalls.filter(conversationNeedsAction);

    // Grouped sidebar: an "Action Required" section pinned at the top (AR and not
    // currently snoozed), then the rest grouped by activity day (descending).
    // O(n) single pass; within a day we keep the backend order (most-recent-first).
    const sidebarGroups = useMemo(() => {
        const now = Date.now();
        const actionRequired: typeof displayedCalls = [];
        const byDay = new Map<string, typeof displayedCalls>();
        for (const call of displayedCalls) {
            const c = call as any;
            const isSnoozed = c.snoozed_until && new Date(c.snoozed_until).getTime() > now;
            if (conversationNeedsAction(c) && !isSnoozed) {
                actionRequired.push(call);
                continue;
            }
            const raw = c.last_interaction_at || call.started_at || call.created_at;
            const key = raw && !isNaN(new Date(raw).getTime())
                ? dateKeyInTZ(raw, companyTz)
                : NO_DATE_KEY;
            const bucket = byDay.get(key);
            if (bucket) bucket.push(call);
            else byDay.set(key, [call]);
        }
        // Day groups descending (most recent day first).
        const dayGroups = [...byDay.keys()]
            .sort((a, b) => {
                if (a === NO_DATE_KEY) return 1;
                if (b === NO_DATE_KEY) return -1;
                return a < b ? 1 : a > b ? -1 : 0;
            })
            .map(key => ({ key, label: groupLabel(key, companyTz), calls: byDay.get(key)! }));
        return { actionRequired, dayGroups };
    }, [displayedCalls, companyTz]);

    // Disable app-main scroll so the sidebar and right column scroll independently.
    // DESKTOP ONLY: the two-column layout needs each column to own its scroll. On
    // mobile we show one panel at a time and want the LIST to scroll the app's main
    // scroll area (like Schedule/Jobs) so `.app-main`'s bottom-nav padding applies
    // and there's no floating inner-scroll frame / bottom void (the PWA bug).
    useEffect(() => {
        if (isMobile) return;
        const appMain = document.querySelector('.app-main') as HTMLElement;
        if (appMain) {
            appMain.style.overflow = 'hidden';
            return () => { appMain.style.overflow = ''; };
        }
    }, [isMobile]);

    // Auto-switch to content panel on mobile when a contact is selected
    useEffect(() => {
        if (isContactSelected) {
            setMobilePanel('content');
        }
    }, [isContactSelected]);

    const handleMobileBack = () => {
        setMobilePanel('list');
        navigate('/pulse');
    };

    // Per-item render — shared by the "Action Required" section and the day groups
    // so the big callbacks block isn't duplicated. `idx` only feeds the key fallback.
    const renderItem = (call: typeof displayedCalls[number], idx: number) => {
        const tlId = (call as any).timeline_id;
        const cId = call.contact?.id || call.id;
        const isActive = tlId
            ? p.location.pathname === `/pulse/timeline/${tlId}`
            : (!!cId && p.location.pathname === `/pulse/contact/${cId}`);
        return (
            <PulseContactItem
                key={tlId ?? call.id ?? `c-${call.contact?.id ?? (call.from_number || idx)}`}
                call={call}
                isActive={isActive}
                prefetchedLead={p.getLeadForPhone(
                    (call as any).tl_phone || call.contact?.phone_e164 || call.from_number || call.to_number
                )}
                onMarkUnread={async (timelineId) => {
                    try { await callsApi.markTimelineUnread(timelineId); p.refetchContacts(); toast.success('Marked as unread'); }
                    catch { toast.error('Failed to mark as unread'); }
                }}
                onMarkHandled={async (timelineId) => {
                    try { await pulseApi.markHandled(timelineId); p.refetchContacts(); toast.success('Marked as done'); }
                    catch { toast.error('Failed to mark done'); }
                }}
                onSnooze={async (timelineId, until) => {
                    try { await pulseApi.snoozeThread(timelineId, until); p.refetchContacts(); toast.success('Thread snoozed'); }
                    catch { toast.error('Failed to snooze'); }
                }}
                onRead={() => p.refetchContacts()}
                onSetActionRequired={async (timelineId) => {
                    // AR-TASK-UNIFY-001: flagging a timeline = creating a task on it.
                    // Create a default "Follow up" task immediately, then open the
                    // editor so the user can refine it (cancel keeps the default).
                    try {
                        const task = await createTask({ parent_type: 'timeline', parent_id: timelineId, description: 'Follow up' });
                        p.refetchContacts();
                        setTaskEditor({ parentId: timelineId, task });
                    } catch { toast.error('Failed to add task'); }
                }}
            />
        );
    };

    return (
        <div className="blanc-page-wrapper">
            {/* Unified header: title + search + controls in one row */}
            <div className="blanc-unified-header">
                {/* Mobile back button — only shown on mobile when in content panel */}
                <button
                    className={`pulse-back-btn${mobilePanel === 'list' ? ' pulse-back-btn-hidden' : ''}`}
                    onClick={handleMobileBack}
                    aria-label="Back to contacts"
                >
                    <ChevronLeft className="size-5" />
                </button>

                <h1 className="blanc-header-title">Pulse</h1>

                <div className="blanc-search-wrapper">
                    <input
                        type="text"
                        placeholder="type to find anything..."
                        value={p.searchQuery}
                        onChange={(e) => p.setSearchQuery(e.target.value)}
                        className="blanc-search-input"
                    />
                </div>

                <div className="blanc-controls-group">
                    {(['all', 'unread', 'action_required'] as const).map(f => (
                        <button
                            key={f}
                            onClick={() => setActiveFilter(f)}
                            className="blanc-control-chip"
                            data-active={activeFilter === f || undefined}
                        >
                            {f === 'all' ? 'All' : f === 'unread' ? 'Unread' : 'Action Required'}
                        </button>
                    ))}
                </div>
            </div>

            {/* Onboarding checklist (ONBTEL-001 Part A) — in-flow between the header
                and the two-column layout; flex-shrink:0 inside the card pushes the
                columns down instead of overlaying them. Renders null unless the
                viewer is tenant_admin AND the server says visible. */}
            <OnboardingChecklistCard />

            {/* Two-column layout: invisible sidebar column + right column (LAYOUT-CANON rule 7) */}
            <div className="pulse-layout" data-mobile-panel={mobilePanel}>

                {/* Left sidebar — invisible layout+scroll container; the tiles carry the surface */}
                <div className="pulse-sidebar">
                    {p.contactsLoading ? (
                        <div className="space-y-2">
                            {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-14 w-full rounded-xl" />)}
                        </div>
                    ) : displayedCalls.length === 0 ? (
                        <div className="flex-1 flex flex-col items-center justify-center py-12">
                            <PhoneOff className="size-8 mx-auto mb-2 opacity-20" />
                            <p className="text-sm text-muted-foreground">No contacts found</p>
                        </div>
                    ) : (
                        <>
                            {/* Action Required — pinned at the very top */}
                            {sidebarGroups.actionRequired.length > 0 && (
                                <div className="pulse-sidebar-group">
                                    <div className="pulse-sidebar-group-header pulse-sidebar-group-header-ar">
                                        Action Required
                                    </div>
                                    {sidebarGroups.actionRequired.map((call, idx) => renderItem(call, idx))}
                                </div>
                            )}
                            {/* The rest — grouped by activity day, most recent first */}
                            {sidebarGroups.dayGroups.map(group => (
                                <div key={group.key} className="pulse-sidebar-group">
                                    <div className="pulse-sidebar-group-header">
                                        {group.label}
                                    </div>
                                    {group.calls.map((call, idx) => renderItem(call, idx))}
                                </div>
                            ))}
                        </>
                    )}
                    <div ref={p.loadMoreRef} className="h-8 flex items-center justify-center">
                        {p.isFetchingNextPage && (
                            <div className="text-xs text-muted-foreground">Loading more...</div>
                        )}
                    </div>
                </div>

                {/* Right column: scroll container (invisible); content units carry their surfaces */}
                <div className="pulse-right-column">
                    {!p.contactId && !p.timelineId ? (
                        <div className="pulse-empty-state">
                            <Activity className="size-12 mb-4" style={{ opacity: 0.15 }} />
                            <p className="text-muted-foreground">Select a contact to view their timeline</p>
                        </div>
                    ) : (() => {
                        const isAnonTimeline = isAnonymousPhone(p.phone) || isAnonymousPhone((p.selectedConv as any)?.tl_phone);
                        // Email-only contacts (created from inbound mail — no phone) can still be
                        // replied to by email when a mailbox is connected. The reply form (SmsForm)
                        // handles the email channel itself, so surface it whenever there's a phone
                        // OR an email reply is possible.
                        const canEmailReply = p.emailConnected && (p.contactEmails?.length ?? 0) > 0;
                        const showContactBar = !isAnonTimeline && !p.lead && !p.leadLoading && !!p.contact?.id && !!p.contactDetail;
                        const smsTarget = p.messageTargets.find(t => t.channel === 'sms');
                        const emailTarget = p.messageTargets.find(t => t.channel === 'email');
                        return (
                        <>
                            {/* PULSE-CONTACT-PIN-001: ONE sticky stack for the AR plaque and the
                                condensed contact bar — two independent sticky elements would both
                                pin to top:0 and overlap. */}
                            <div className="pulse-sticky-stack">
                            {/* One row per task; taskless manual flags keep thread-level controls. */}
                            <ActionRequiredPlaque
                                timelineId={(p.selectedConv as any)?.timeline_id || null}
                                tasks={(p.selectedConv as any)?.open_tasks || ((p.selectedConv as any)?.open_task ? [(p.selectedConv as any).open_task] : [])}
                                isManuallyRequired={!!(p.selectedConv as any)?.is_action_required
                                    && (p.selectedConv as any)?.action_required_reason === 'manual'
                                    && !(p.selectedConv as any)?.has_open_task}
                                reason={(p.selectedConv as any)?.action_required_reason}
                                snoozedUntil={(p.selectedConv as any)?.snoozed_until}
                                companyTz={companyTz}
                                phone={p.phone}
                                contactName={p.contact?.full_name || (p.selectedConv as any)?.contact?.full_name}
                                onChanged={p.refetchContacts}
                                onClearManual={() => {
                                    const tlId = (p.selectedConv as any)?.timeline_id;
                                    if (!tlId) return;
                                    pulseApi.markHandled(tlId)
                                        .then(() => { p.refetchContacts(); toast.success('Marked as done'); })
                                        .catch(() => toast.error('Failed'));
                                }}
                                onSnoozeManual={(until) => {
                                    const tlId = (p.selectedConv as any)?.timeline_id;
                                    if (!tlId) return;
                                    pulseApi.snoozeThread(tlId, until)
                                        .then(() => { p.refetchContacts(); toast.success('Snoozed'); })
                                        .catch(() => toast.error('Failed'));
                                }}
                            />

                            {showContactBar && (
                                <PulseContactBar
                                    name={p.contactDetail!.contact.full_name || 'Unknown'}
                                    address={pickBarAddress(p.contactJobs, p.contactDetail!.contact)}
                                    phone={p.phone || p.contactDetail!.contact.phone_e164 || null}
                                    hasEmail={(p.contactEmails?.length ?? 0) > 0}
                                    emailConnected={p.emailConnected}
                                    showNotes={hasNotes(p.contactDetail!.contact)}
                                    openCount={openLeadsJobsCount(p.contactDetail!.leads, p.contactJobs)}
                                    onText={() => { if (smsTarget) { p.setSelectedTarget(smsTarget); setComposerFocusSignal(s => s + 1); } }}
                                    onEmail={() => {
                                        if (!p.emailConnected) {
                                            // Owner decision: the button stays visible; the click leads to
                                            // connecting a mailbox rather than silently doing nothing.
                                            toast.info('Connect a mailbox to send email', {
                                                action: { label: 'Connect', onClick: () => navigate('/settings/integrations/google-email') },
                                            });
                                            return;
                                        }
                                        if (emailTarget) { p.setSelectedTarget(emailTarget); setComposerFocusSignal(s => s + 1); }
                                    }}
                                    onOpenNotes={() => { setContactCardSection('notes'); setContactCardOpen(true); }}
                                    onOpenLeadsJobs={() => { setContactCardSection('leads-jobs'); setContactCardOpen(true); }}
                                    onExpand={() => { setContactCardSection(null); setContactCardOpen(true); }}
                                />
                            )}
                            </div>

                            {/* Anonymous header card — replaces detail/wizard for the shared Anonymous timeline */}
                            {isAnonTimeline && (
                                <div className="pulse-card pulse-accent-top" style={{ '--card-accent': 'var(--blanc-ink-3)' } as React.CSSProperties}>
                                    <div className="px-5 py-4">
                                        <h2 className="text-2xl font-semibold" style={{ color: 'var(--blanc-ink-1)', fontFamily: 'var(--blanc-font-heading)' }}>Anonymous</h2>
                                        <p className="text-sm mt-1" style={{ color: 'var(--blanc-ink-3)' }}>
                                            Caller ID was blocked or unavailable. Callback and SMS are not available for these calls.
                                        </p>
                                    </div>
                                </div>
                            )}

                            {/* Detail card: Lead / Contact / Wizard */}
                            {!isAnonTimeline && (p.contactId || p.timelineId) && (p.phone || p.contact?.id) ? (
                                p.lead ? (
                                    <div className="pulse-card pulse-accent-top" style={{ '--card-accent': 'var(--blanc-info)', height: 560 } as React.CSSProperties}>
                                        <LeadDetailPanel
                                            lead={p.lead}
                                            onClose={() => { }}
                                            onEdit={(lead) => p.setEditingLead(lead)}
                                            onMarkLost={p.handleMarkLost}
                                            onActivate={p.handleActivate}
                                            onConvert={p.handleConvert}
                                            onUpdateComments={p.handleUpdateComments}
                                            onUpdateStatus={p.handleUpdateStatus}
                                            onUpdateSource={p.handleUpdateSource}
                                            onDelete={p.handleDelete}
                                        />
                                    </div>
                                ) : !p.leadLoading && p.contact?.id && p.contactDetail ? (
                                    // PULSE-CONTACT-PIN-001: the full contact card left the flow — the
                                    // sticky bar above represents the contact; the card opens as an
                                    // overlay panel (see the Dialog below the timeline).
                                    null
                                ) : !p.leadLoading && !p.contact?.id ? (
                                    <div className="pulse-card pulse-accent-top" style={{ '--card-accent': 'var(--blanc-warning)' } as React.CSSProperties}>
                                        <div className="px-5 pt-3 pb-0">
                                            <span className="text-[10px] font-semibold uppercase tracking-widest inline-block" style={{ color: 'var(--blanc-warning)', letterSpacing: '0.12em' }}>New Lead</span>
                                        </div>
                                        <CreateLeadJobWizard
                                            phone={p.phone}
                                            contactId={p.contact?.id}
                                            email={p.contact?.email}
                                            hasActiveCall={p.hasActiveCall}
                                            timelineId={p.timelineId || undefined}
                                            onLeadCreated={() => { p.refetchTimeline(); p.refetchContacts(); }}
                                        />
                                    </div>
                                ) : null
                            ) : null}

                            {/* Timeline — no wrapper card: items carry their own surfaces on the canvas */}
                            <PulseTimeline
                                items={p.items}
                                loading={p.timelineLoading}
                                timelineKey={p.timelineId || p.contactId}
                                hasOlder={p.hasOlder}
                                isFetchingOlder={p.isFetchingOlder}
                                onLoadOlder={p.fetchOlder}
                                scrollToBottomSignal={p.scrollToBottomSignal}
                            />

                            {/* Reply card — hidden for anonymous timeline (no callback target).
                                Shown when there's a phone OR an email reply is possible. */}
                            {(p.phone || canEmailReply) && !isAnonTimeline && (
                                <div className="pulse-card">
                                    <SmsForm
                                        onSend={p.handleSendMessage}
                                        onAiFormat={p.handleAiFormat}
                                        disabled={!p.phone && !canEmailReply}
                                        lead={p.lead}
                                        mainPhone={p.phone}
                                        secondaryPhone={p.secondaryPhone}
                                        secondaryPhoneName={p.secondaryPhoneName}
                                        emails={p.contactEmails}
                                        emailConnected={p.emailConnected}
                                        selectedTarget={p.selectedTarget}
                                        onTargetChange={p.setSelectedTarget}
                                        focusSignal={composerFocusSignal}
                                    />
                                </div>
                            )}

                            {/* PULSE-CONTACT-PIN-001: the full contact card as a canonical panel
                                (bottom sheet on mobile). Overlay, so opening it cannot disturb
                                the timeline's scroll compensation. */}
                            {showContactBar && (
                                <Dialog open={contactCardOpen} onOpenChange={(open) => { setContactCardOpen(open); if (!open) setContactCardSection(null); }}>
                                    <DialogContent variant="panel">
                                        <DialogTitle className="sr-only">Contact details</DialogTitle>
                                        <DialogDescription className="sr-only">Full contact card with notes, tasks, leads, jobs and addresses.</DialogDescription>
                                        <DialogBody className="p-0">
                                            <PulseContactPanel
                                                contact={p.contactDetail!.contact}
                                                leads={p.contactDetail!.leads}
                                                jobs={p.contactJobs}
                                                loading={false}
                                                focusSection={contactCardSection}
                                                timelineId={p.timelineId || (p.selectedConv as any)?.timeline_id || null}
                                                onAddressesChanged={p.refreshContactDetail}
                                                onContactChanged={p.refreshContactDetail}
                                                onTasksChanged={p.refetchContacts}
                                            />
                                        </DialogBody>
                                    </DialogContent>
                                </Dialog>
                            )}
                        </>
                        );
                    })()}
                </div>
            </div>

            {/* Dialogs */}
            {p.editingLead && (
                <EditLeadDialog
                    lead={p.editingLead}
                    open={!!p.editingLead}
                    onOpenChange={(open) => !open && p.setEditingLead(null)}
                    onSuccess={p.handleUpdateLead}
                />
            )}
            {p.convertingLead && (
                <ConvertToJobDialog
                    lead={p.convertingLead}
                    open={!!p.convertingLead}
                    onOpenChange={(open) => !open && p.setConvertingLead(null)}
                    onSuccess={p.handleConvertSuccess}
                />
            )}
            {taskEditor && (
                <TaskFormDialog
                    open={!!taskEditor}
                    onOpenChange={(o) => { if (!o) setTaskEditor(null); }}
                    parentType="timeline"
                    parentId={taskEditor.parentId}
                    tz={companyTz}
                    task={taskEditor.task}
                    onSaved={() => { setTaskEditor(null); p.refetchContacts(); }}
                    onDeleted={() => { setTaskEditor(null); p.refetchContacts(); }}
                />
            )}
        </div>
    );
};

/**
 * PULSE-PLAYER-001 (OB-13): the shared recording player is scoped to Pulse by
 * construction — provider + floating bar mount here, so navigating to any other
 * page unmounts the <audio> element and playback stops.
 */
export const PulsePage: React.FC = () => (
    <PulsePlayerProvider>
        <PulsePageInner />
        <PulsePlayerBar />
    </PulsePlayerProvider>
);
