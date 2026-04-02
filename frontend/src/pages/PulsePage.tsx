/**
 * PulsePage — Three-column layout: contacts | lead/contact detail | timeline + SMS
 * Responsive: mobile shows one panel at a time with back navigation.
 */
import React, { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { usePulsePage } from '../hooks/usePulsePage';
import { PulseContactItem, SNOOZE_OPTIONS, getSnoozeUntil, REASON_LABELS } from '../components/pulse/PulseContactItem';
import { AssignOwnerDropdown } from '../components/pulse/AssignOwnerDropdown';
import { PulseTimeline } from '../components/pulse/PulseTimeline';
import { SmsForm } from '../components/pulse/SmsForm';
import { LeadDetailPanel } from '../components/leads/LeadDetailPanel';
import { PulseContactPanel } from '../components/contacts/PulseContactPanel';
import { CreateLeadJobWizard } from '../components/conversations/CreateLeadJobWizard';
import { EditLeadDialog } from '../components/leads/EditLeadDialog';
import { ConvertToJobDialog } from '../components/leads/ConvertToJobDialog';
import { Skeleton } from '../components/ui/skeleton';
import { PhoneOff, Activity, Clock, CheckCircle2, AlertTriangle, ChevronLeft } from 'lucide-react';
import { callsApi } from '../services/api';
import { pulseApi } from '../services/pulseApi';
import { useAuth } from '../auth/AuthProvider';
import { useNavigate } from 'react-router-dom';
import './PulsePage.css';

export const PulsePage: React.FC = () => {
    const p = usePulsePage();
    const { company } = useAuth();
    const navigate = useNavigate();
    const companyTz = company?.timezone || 'America/New_York';

    // Mobile panel state: 'list' shows sidebar, 'content' shows detail+timeline
    const [mobilePanel, setMobilePanel] = useState<'list' | 'content'>('list');
    // Sidebar filter chips
    const [activeFilter, setActiveFilter] = useState<'all' | 'unread' | 'action_required'>('all');

    const isContactSelected = !!(p.contactId || p.timelineId);

    const displayedCalls = activeFilter === 'all'
        ? p.filteredCalls
        : activeFilter === 'unread'
            ? p.filteredCalls.filter((c: any) => c.tl_has_unread || c.sms_has_unread || c.has_unread)
            : p.filteredCalls.filter((c: any) => c.is_action_required);

    // Disable app-main scroll so sidebar and right column scroll independently
    useEffect(() => {
        const appMain = document.querySelector('.app-main') as HTMLElement;
        if (appMain) {
            appMain.style.overflow = 'hidden';
            return () => { appMain.style.overflow = ''; };
        }
    }, []);

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

    return (
        <div className="blanc-page-wrapper">
            {/* Unified header: title + search + filters in one row */}
            <div className="pulse-unified-header">
                {/* Mobile back button — only shown on mobile when in content panel */}
                <button
                    className={`pulse-back-btn${mobilePanel === 'list' ? ' pulse-back-btn-hidden' : ''}`}
                    onClick={handleMobileBack}
                    aria-label="Back to contacts"
                >
                    <ChevronLeft className="size-5" />
                </button>

                {/* Title */}
                <h1 className="pulse-header-title">Pulse</h1>

                {/* Inline search — same size as title, thin weight, feels like a continuation */}
                <div className="pulse-search-wrapper">
                    <input
                        type="text"
                        placeholder="type to find anything..."
                        value={p.searchQuery}
                        onChange={(e) => p.setSearchQuery(e.target.value)}
                        className="pulse-search-input"
                    />
                </div>

                {/* Filter chips — right side */}
                <div className="pulse-filters-group">
                    {(['all', 'unread', 'action_required'] as const).map(f => (
                        <button
                            key={f}
                            onClick={() => setActiveFilter(f)}
                            className="pulse-filter-chip"
                            data-active={activeFilter === f || undefined}
                        >
                            {f === 'all' ? 'All' : f === 'unread' ? 'Unread' : 'Action Required'}
                        </button>
                    ))}
                </div>
            </div>

            {/* Two-column layout: sidebar card + right column of floating cards */}
            <div className="pulse-layout" data-mobile-panel={mobilePanel}>

                {/* Left sidebar — sticky floating card */}
                <div className="pulse-sidebar-card">
                    <div className="pulse-sidebar-scroll">
                        {p.contactsLoading ? (
                            <div className="p-3 space-y-2">
                                {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-14 w-full rounded-xl" />)}
                            </div>
                        ) : displayedCalls.length === 0 ? (
                            <div className="flex-1 flex flex-col items-center justify-center py-12">
                                <PhoneOff className="size-8 mx-auto mb-2 opacity-20" />
                                <p className="text-sm text-muted-foreground">No contacts found</p>
                            </div>
                        ) : (
                            displayedCalls.map((call, idx) => {
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
                                        onMarkUnread={async (timelineId) => {
                                            try { await callsApi.markTimelineUnread(timelineId); p.refetchContacts(); toast.success('Marked as unread'); }
                                            catch { toast.error('Failed to mark as unread'); }
                                        }}
                                        onMarkHandled={async (timelineId) => {
                                            try { await pulseApi.markHandled(timelineId); p.refetchContacts(); toast.success('Marked as handled'); }
                                            catch { toast.error('Failed to mark handled'); }
                                        }}
                                        onSnooze={async (timelineId, until) => {
                                            try { await pulseApi.snoozeThread(timelineId, until); p.refetchContacts(); toast.success('Thread snoozed'); }
                                            catch { toast.error('Failed to snooze'); }
                                        }}
                                        onRead={() => p.refetchContacts()}
                                        onSetActionRequired={async (timelineId) => {
                                            try { await pulseApi.setActionRequired(timelineId); p.refetchContacts(); toast.success('Marked as Action Required'); }
                                            catch { toast.error('Failed to set Action Required'); }
                                        }}
                                    />
                                );
                            })
                        )}
                        <div ref={p.loadMoreRef} className="h-8 flex items-center justify-center">
                            {p.isFetchingNextPage && (
                                <div className="text-xs text-muted-foreground">Loading more...</div>
                            )}
                        </div>
                    </div>
                </div>

                {/* Right column: separate floating cards */}
                <div className="pulse-right-column">
                    {!p.contactId && !p.timelineId ? (
                        <div className="pulse-card pulse-empty-state">
                            <Activity className="size-12 mb-4" style={{ opacity: 0.15 }} />
                            <p className="text-muted-foreground">Select a contact to view their timeline</p>
                        </div>
                    ) : (
                        <>
                            {/* Action Required bar — its own floating card */}
                            {(() => {
                                const conv = p.selectedConv as any;
                                if (!conv?.is_action_required) return null;
                                const isSnoozed = conv.snoozed_until && new Date(conv.snoozed_until) > new Date();
                                const tlId = conv.timeline_id;
                                return (
                                    <div
                                        className="pulse-card"
                                        style={{ backgroundColor: isSnoozed ? 'var(--blanc-surface-muted)' : '#fff7ed' }}
                                    >
                                        <div className="flex items-center gap-2.5 px-5 py-3">
                                            <span
                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold"
                                                style={{
                                                    backgroundColor: isSnoozed ? 'rgba(118,106,89,0.12)' : '#fed7aa',
                                                    color: isSnoozed ? 'var(--blanc-ink-2)' : '#9a3412',
                                                }}
                                            >
                                                {isSnoozed ? <Clock className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
                                                {isSnoozed ? 'Snoozed' : 'Action Required'}
                                            </span>
                                            {conv.action_required_reason && (
                                                <span className="text-sm" style={{ color: 'var(--blanc-ink-2)' }}>{REASON_LABELS[conv.action_required_reason] || conv.action_required_reason}</span>
                                            )}
                                            {conv.open_task?.due_at && !isSnoozed && (
                                                <span className="text-sm font-medium" style={{ color: 'var(--blanc-danger)' }}>
                                                    Due {new Date(conv.open_task.due_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                                                </span>
                                            )}
                                            {isSnoozed && (
                                                <span className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>
                                                    until {new Date(conv.snoozed_until).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                                                </span>
                                            )}
                                        </div>
                                        {!isSnoozed && (
                                            <div className="flex items-center gap-2 px-5 pb-3">
                                                <button
                                                    onClick={() => { if (tlId) pulseApi.markHandled(tlId).then(() => { p.refetchContacts(); toast.success('Marked as handled'); }).catch(() => toast.error('Failed')); }}
                                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors"
                                                    style={{ color: 'var(--blanc-success)', backgroundColor: 'rgba(27,139,99,0.1)' }}
                                                >
                                                    <CheckCircle2 className="size-3.5" /> Handled
                                                </button>
                                                <div className="relative group">
                                                    <button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors hover:bg-muted" style={{ color: 'var(--blanc-ink-2)' }}>
                                                        <Clock className="size-3.5" /> Snooze
                                                    </button>
                                                    <div className="absolute left-0 top-full mt-1 z-50 bg-card rounded-xl shadow-lg border border-border py-1 min-w-[170px] hidden group-hover:block">
                                                        {SNOOZE_OPTIONS.map(opt => (
                                                            <div
                                                                key={opt.label}
                                                                role="button"
                                                                tabIndex={0}
                                                                onClick={() => { if (tlId) pulseApi.snoozeThread(tlId, getSnoozeUntil(opt, companyTz)).then(() => { p.refetchContacts(); toast.success('Snoozed'); }).catch(() => toast.error('Failed')); }}
                                                                className="px-3 py-2 text-sm text-foreground hover:bg-muted cursor-pointer"
                                                            >
                                                                {opt.label}
                                                            </div>
                                                        ))}
                                                        <div className="border-t border-border mt-1 pt-1 px-3 py-1">
                                                            <label className="text-[10px] text-muted-foreground block mb-1">Specific date</label>
                                                            <input
                                                                type="date"
                                                                className="text-xs border border-border rounded-lg px-2 py-1 w-full bg-card"
                                                                min={new Date().toISOString().split('T')[0]}
                                                                onChange={(e) => {
                                                                    if (!e.target.value || !tlId) return;
                                                                    const d = new Date(e.target.value + 'T09:00:00');
                                                                    pulseApi.snoozeThread(tlId, d.toISOString()).then(() => { p.refetchContacts(); toast.success('Snoozed'); }).catch(() => toast.error('Failed'));
                                                                }}
                                                            />
                                                        </div>
                                                    </div>
                                                </div>
                                                <AssignOwnerDropdown timelineId={tlId} onAssigned={() => p.refetchContacts()} />
                                            </div>
                                        )}
                                    </div>
                                );
                            })()}

                            {/* Detail card: Lead / Contact / Wizard */}
                            {(p.contactId || p.timelineId) && p.phone ? (
                                p.lead ? (
                                    <div className="pulse-card pulse-accent-top" style={{ '--card-accent': 'var(--blanc-info)' } as React.CSSProperties}>
                                        <LeadDetailPanel
                                            lead={p.lead}
                                            embedded
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
                                    <div className="pulse-card pulse-accent-top" style={{ '--card-accent': 'var(--blanc-success)' } as React.CSSProperties}>
                                        <PulseContactPanel
                                            contact={p.contactDetail.contact}
                                            leads={p.contactDetail.leads}
                                            loading={false}
                                            onAddressesChanged={p.refreshContactDetail}
                                            onContactChanged={p.refreshContactDetail}
                                        />
                                    </div>
                                ) : !p.leadLoading && !p.contact?.id ? (
                                    <div className="pulse-card pulse-accent-top" style={{ '--card-accent': 'var(--blanc-warning)' } as React.CSSProperties}>
                                        <div className="px-5 pt-3 pb-0">
                                            <span className="text-[10px] font-semibold uppercase tracking-widest inline-block" style={{ color: 'var(--blanc-warning)', letterSpacing: '0.12em' }}>New Lead</span>
                                        </div>
                                        <CreateLeadJobWizard
                                            phone={p.phone}
                                            hasActiveCall={p.hasActiveCall}
                                            timelineId={p.timelineId || undefined}
                                            onLeadCreated={() => { p.refetchTimeline(); p.refetchContacts(); }}
                                        />
                                    </div>
                                ) : null
                            ) : null}

                            {/* Timeline card */}
                            <div className="pulse-card">
                                <PulseTimeline
                                    calls={p.callDataItems}
                                    messages={p.messages}
                                    loading={p.timelineLoading}
                                    timelineKey={p.timelineId || p.contactId}
                                    financialEvents={p.financialEvents}
                                />
                            </div>

                            {/* SMS form card */}
                            {p.phone && (
                                <div className="pulse-card">
                                    <SmsForm
                                        onSend={p.handleSendMessage}
                                        onAiFormat={p.handleAiFormat}
                                        disabled={!p.phone}
                                        lead={p.lead}
                                        mainPhone={p.phone}
                                        secondaryPhone={p.secondaryPhone}
                                        secondaryPhoneName={p.secondaryPhoneName}
                                        selectedPhone={p.selectedToPhone || p.phone}
                                        onPhoneChange={p.setSelectedToPhone}
                                    />
                                </div>
                            )}
                        </>
                    )}
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
        </div>
    );
};
