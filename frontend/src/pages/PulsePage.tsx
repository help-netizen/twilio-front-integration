/**
 * PulsePage — Three-column layout: contacts | lead/contact detail | timeline + SMS
 */
import React from 'react';
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
import { Input } from '../components/ui/input';
import { Skeleton } from '../components/ui/skeleton';
import { Search, PhoneOff, Activity, Clock, CheckCircle2, AlertTriangle } from 'lucide-react';
import { callsApi } from '../services/api';
import { pulseApi } from '../services/pulseApi';
import './PulsePage.css';

export const PulsePage: React.FC = () => {
    const p = usePulsePage();

    return (
        <div className="pulse-page">
            {/* Left sidebar: contact list */}
            <div className="pulse-sidebar">
                <div className="p-3 border-b">
                    <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                        <Input placeholder="Search phone..." value={p.searchQuery} onChange={(e) => p.setSearchQuery(e.target.value)} className="pl-8 h-8 text-sm" />
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto">
                    {p.contactsLoading ? (
                        <div className="p-3 space-y-2">{[...Array(8)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
                    ) : p.filteredCalls.length === 0 ? (
                        <div className="flex-1 flex flex-col items-center justify-center py-12">
                            <PhoneOff className="size-8 mx-auto mb-2 opacity-20" /><p className="text-sm text-muted-foreground">No contacts found</p>
                        </div>
                    ) : (
                        p.filteredCalls.map((call, idx) => {
                            const tlId = (call as any).timeline_id;
                            const cId = call.contact?.id || call.id;
                            const isActive = tlId ? p.location.pathname === `/pulse/timeline/${tlId}` : (!!cId && p.location.pathname === `/pulse/contact/${cId}`);
                            return (
                                <PulseContactItem
                                    key={tlId ?? call.id ?? `c-${call.contact?.id ?? (call.from_number || idx)}`}
                                    call={call} isActive={isActive}
                                    onMarkUnread={async (timelineId) => { try { await callsApi.markTimelineUnread(timelineId); p.refetchContacts(); toast.success('Marked as unread'); } catch { toast.error('Failed to mark as unread'); } }}
                                    onMarkHandled={async (timelineId) => { try { await pulseApi.markHandled(timelineId); p.refetchContacts(); toast.success('Marked as handled'); } catch { toast.error('Failed to mark handled'); } }}
                                    onSnooze={async (timelineId, until) => { try { await pulseApi.snoozeThread(timelineId, until); p.refetchContacts(); toast.success('Thread snoozed'); } catch { toast.error('Failed to snooze'); } }}
                                    onRead={() => p.refetchContacts()}
                                    onSetActionRequired={async (timelineId) => { try { await pulseApi.setActionRequired(timelineId); p.refetchContacts(); toast.success('Marked as Action Required'); } catch { toast.error('Failed to set Action Required'); } }}
                                />
                            );
                        })
                    )}
                    <div ref={p.loadMoreRef} className="h-8 flex items-center justify-center">
                        {p.isFetchingNextPage && (<div className="text-xs text-muted-foreground">Loading more...</div>)}
                    </div>
                </div>
            </div>

            {/* Middle column: AR Header + Lead/Contact Detail */}
            <div className="w-[400px] shrink-0 border-r bg-background flex flex-col overflow-hidden">
                {/* Action Required Header Bar */}
                {(() => {
                    const conv = p.selectedConv as any;
                    if (!conv?.is_action_required) return null;
                    const isSnoozed = conv.snoozed_until && new Date(conv.snoozed_until) > new Date();
                    const tlId = conv.timeline_id;
                    return (
                        <div className="border-b" style={{ backgroundColor: isSnoozed ? '#f3f4f6' : '#fff7ed' }}>
                            <div className="flex items-center gap-2 px-4 py-2">
                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold" style={{ backgroundColor: isSnoozed ? '#e5e7eb' : '#fed7aa', color: isSnoozed ? '#4b5563' : '#9a3412' }}>
                                    {isSnoozed ? <Clock className="size-3" /> : <AlertTriangle className="size-3" />}
                                    {isSnoozed ? 'Snoozed' : 'Action Required'}
                                </span>
                                {conv.action_required_reason && (<span className="text-xs text-gray-500">{REASON_LABELS[conv.action_required_reason] || conv.action_required_reason}</span>)}
                                {conv.open_task?.due_at && !isSnoozed && (<span className="text-xs text-red-500">Due {new Date(conv.open_task.due_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>)}
                                {isSnoozed && (<span className="text-xs text-gray-500">until {new Date(conv.snoozed_until).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>)}
                            </div>
                            {!isSnoozed && (
                                <div className="flex items-center gap-2 px-4 pb-2">
                                    <button onClick={() => { if (tlId) pulseApi.markHandled(tlId).then(() => { p.refetchContacts(); toast.success('Marked as handled'); }).catch(() => toast.error('Failed')); }}
                                        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-green-700 bg-green-50 hover:bg-green-100 rounded transition-colors">
                                        <CheckCircle2 className="size-3" /> Handled
                                    </button>
                                    <div className="relative group">
                                        <button className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded transition-colors"><Clock className="size-3" /> Snooze</button>
                                        <div className="absolute left-0 top-full mt-1 z-50 bg-white rounded-md shadow-lg border border-gray-200 py-1 min-w-[170px] hidden group-hover:block">
                                            {SNOOZE_OPTIONS.map(opt => (<div key={opt.label} role="button" tabIndex={0} onClick={() => { if (tlId) pulseApi.snoozeThread(tlId, getSnoozeUntil(opt)).then(() => { p.refetchContacts(); toast.success('Snoozed'); }).catch(() => toast.error('Failed')); }} className="px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 cursor-pointer">{opt.label}</div>))}
                                            <div className="border-t mt-1 pt-1 px-3 py-1">
                                                <label className="text-[10px] text-gray-400 block mb-1">Specific date</label>
                                                <input type="date" className="text-xs border rounded px-2 py-1 w-full" min={new Date().toISOString().split('T')[0]}
                                                    onChange={(e) => { if (!e.target.value || !tlId) return; const d = new Date(e.target.value + 'T09:00:00'); pulseApi.snoozeThread(tlId, d.toISOString()).then(() => { p.refetchContacts(); toast.success('Snoozed'); }).catch(() => toast.error('Failed')); }} />
                                            </div>
                                        </div>
                                    </div>
                                    <AssignOwnerDropdown timelineId={tlId} onAssigned={() => p.refetchContacts()} />
                                </div>
                            )}
                        </div>
                    );
                })()}
                {(p.contactId || p.timelineId) && p.phone ? (
                    p.lead ? (
                        <div className="flex-1 overflow-y-auto">
                            <LeadDetailPanel lead={p.lead} onClose={() => { }} onEdit={(lead) => p.setEditingLead(lead)} onMarkLost={p.handleMarkLost} onActivate={p.handleActivate} onConvert={p.handleConvert} onUpdateComments={p.handleUpdateComments} onUpdateStatus={p.handleUpdateStatus} onUpdateSource={p.handleUpdateSource} onDelete={p.handleDelete} />
                        </div>
                    ) : !p.leadLoading && p.contact?.id && p.contactDetail ? (
                        <div className="flex-1 overflow-y-auto">
                            <PulseContactPanel contact={p.contactDetail.contact} leads={p.contactDetail.leads} loading={false} onAddressesChanged={p.refreshContactDetail} onContactChanged={p.refreshContactDetail} />
                        </div>
                    ) : !p.leadLoading && !p.contact?.id ? (
                        <div className="flex-1 overflow-y-auto"><CreateLeadJobWizard phone={p.phone} hasActiveCall={p.hasActiveCall} /></div>
                    ) : null
                ) : null}
            </div>

            {/* Right column: timeline + SMS */}
            <div className="pulse-timeline-column">
                {!p.contactId && !p.timelineId ? (
                    <div className="pulse-empty-state"><Activity className="size-12 mb-4" style={{ opacity: 0.15 }} /><p className="text-muted-foreground">Select a contact to view their timeline</p></div>
                ) : (
                    <>
                        <div className="pulse-timeline-scroll"><PulseTimeline calls={p.callDataItems} messages={p.messages} loading={p.timelineLoading} timelineKey={p.timelineId || p.contactId} /></div>
                        {p.phone && (<SmsForm onSend={p.handleSendMessage} onAiFormat={p.handleAiFormat} disabled={!p.phone} lead={p.lead} mainPhone={p.phone} secondaryPhone={p.secondaryPhone} secondaryPhoneName={p.secondaryPhoneName} selectedPhone={p.selectedToPhone || p.phone} onPhoneChange={p.setSelectedToPhone} />)}
                    </>
                )}
            </div>

            {/* Dialogs */}
            {p.editingLead && (<EditLeadDialog lead={p.editingLead} open={!!p.editingLead} onOpenChange={(open) => !open && p.setEditingLead(null)} onSuccess={p.handleUpdateLead} />)}
            {p.convertingLead && (<ConvertToJobDialog lead={p.convertingLead} open={!!p.convertingLead} onOpenChange={(open) => !open && p.setConvertingLead(null)} onSuccess={p.handleConvertSuccess} />)}
        </div>
    );
};
