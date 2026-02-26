import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { useCallsByContact } from '../hooks/useConversations';
import { usePulseTimeline } from '../hooks/usePulseTimeline';
import { messagingApi } from '../services/messagingApi';
import { pulseApi } from '../services/pulseApi';
import * as leadsApi from '../services/leadsApi';
import * as contactsApi from '../services/contactsApi';
import { useRealtimeEvents, type SSECallEvent, type SSETranscriptDeltaEvent, type SSETranscriptFinalizedEvent } from '../hooks/useRealtimeEvents';
import { appendTranscriptDelta, finalizeTranscript } from '../hooks/useLiveTranscript';
import { callsApi } from '../services/api';
import { PulseTimeline } from '../components/pulse/PulseTimeline';
import { SmsForm } from '../components/pulse/SmsForm';
import { LeadDetailPanel } from '../components/leads/LeadDetailPanel';
import { PulseContactPanel } from '../components/contacts/PulseContactPanel';
import { CreateLeadJobWizard } from '../components/conversations/CreateLeadJobWizard';
import { EditLeadDialog } from '../components/leads/EditLeadDialog';
import { ConvertToJobDialog } from '../components/leads/ConvertToJobDialog';
import { formatPhoneNumber } from '../utils/formatters';
import { useLeadByPhone } from '../hooks/useLeadByPhone';
import { Input } from '../components/ui/input';
import { Skeleton } from '../components/ui/skeleton';
import { Search, PhoneOff, Activity, PhoneIncoming, PhoneOutgoing, ArrowLeftRight, MessageSquare, MessageSquareReply, MoreVertical, EyeOff, Clock, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { Call } from '../types/models';
import type { Lead } from '../types/lead';
import type { ContactLead } from '../types/contact';
import type { CallData } from '../components/call-list-item';
import './PulsePage.css';

// =============================================================================
// Contact List Item (Pulse-specific — navigates to /pulse/timeline/:timelineId)
// =============================================================================
const STATUS_ICON_COLORS: Record<string, string> = {
    'completed': '#16a34a',
    'no-answer': '#dc2626',
    'busy': '#ea580c',
    'failed': '#dc2626',
    'canceled': '#dc2626',
    'ringing': '#2563eb',
    'in-progress': '#7c3aed',
    'queued': '#2563eb',
    'initiated': '#2563eb',
    'voicemail_recording': '#ea580c',
    'voicemail_left': '#dc2626',
};

// SNOOZE_OPTIONS used in quick-action dropdown
const SNOOZE_OPTIONS = [
    { label: '30 min', ms: 30 * 60 * 1000 },
    { label: '2 hours', ms: 2 * 60 * 60 * 1000 },
    { label: 'Tomorrow 9 AM', ms: null as number | null },
    // 'Specific Date' handled separately
];
function getSnoozeUntil(option: typeof SNOOZE_OPTIONS[number]): string {
    if (option.ms) return new Date(Date.now() + option.ms).toISOString();
    // Tomorrow 9 AM
    const d = new Date();
    d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
    return d.toISOString();
}

// Reason labels
const REASON_LABELS: Record<string, string> = {
    new_message: 'New message',
    manual: 'Manual',
    estimate_approved: 'Estimate approved',
    time_confirmed: 'Time confirmed',
};

function PulseContactItem({ call, isActive, onMarkUnread, onMarkHandled, onSnooze }: {
    call: Call; isActive: boolean;
    onMarkUnread?: (timelineId: number) => void;
    onMarkHandled?: (timelineId: number) => void;
    onSnooze?: (timelineId: number, until: string) => void;
}) {
    const navigate = useNavigate();
    // Prefer timeline_id for navigation, fall back to contact_id (legacy)
    const tlId = (call as any).timeline_id;
    const contactId = call.contact?.id || call.id;
    const targetPath = tlId ? `/pulse/timeline/${tlId}` : (contactId ? `/pulse/contact/${contactId}` : null);

    // Unified unread state: timeline OR SMS OR contact level
    const hasUnread = (call as any).tl_has_unread || (call as any).sms_has_unread || call.has_unread;

    const rawPhone = (call as any).tl_phone || call.contact?.phone_e164 || call.from_number || call.to_number || call.call_sid;

    // Use last_interaction_phone from API — the actual customer phone from the last event
    const displayPhone = (call as any).last_interaction_phone || rawPhone;

    const { lead } = useLeadByPhone(rawPhone);
    const leadName = lead ? [lead.FirstName, lead.LastName].filter(Boolean).join(' ') : null;
    const company = lead?.Company || null;
    const contactName = call.contact?.full_name && call.contact.full_name !== call.contact.phone_e164
        ? call.contact.full_name : null;
    const primaryText = company || leadName || contactName || formatPhoneNumber(displayPhone);
    const showSecondaryPhone = !!(company || leadName || contactName);

    // Use last_interaction_at (call or SMS), falling back to call time
    const displayDate = new Date(call.last_interaction_at || call.started_at || call.created_at);
    const interactionType = call.last_interaction_type || 'call';

    // Action Required state from API
    const isActionRequired = (call as any).is_action_required || false;
    const arReason = (call as any).action_required_reason || null;
    const snoozedUntil = (call as any).snoozed_until;
    const isSnoozed = snoozedUntil && new Date(snoozedUntil) > new Date();
    const openTask = (call as any).open_task || null;
    const [snoozeMenuOpen, setSnoozeMenuOpen] = React.useState(false);


    // Icon logic: show last interaction type
    const callDirection = call.direction === 'inbound' ? 'inbound'
        : call.direction?.startsWith('outbound') ? 'outbound'
            : call.direction === 'internal' ? 'internal' : 'outbound';
    const callColor = STATUS_ICON_COLORS[call.status?.toLowerCase() || ''] || '#16a34a';

    function getTimeAgo(date: Date): string {
        const now = new Date();
        const diff = now.getTime() - date.getTime();
        const hours = Math.floor(diff / (1000 * 60 * 60));
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        if (hours < 1) return 'now';
        if (hours < 24) return `${hours}h ago`;
        if (days < 7) return `${days}d ago`;
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    function getFullDateTime(date: Date): string {
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' +
            date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    }

    // Render the icon based on last interaction type
    const renderIcon = () => {
        if (interactionType === 'sms_inbound') {
            return <MessageSquareReply className="size-4" style={{ color: '#2563eb' }} />;
        }
        if (interactionType === 'sms_outbound') {
            return <MessageSquare className="size-4" style={{ color: '#7c3aed' }} />;
        }
        // Call icon with direction
        if (callDirection === 'internal') return <ArrowLeftRight className="size-4" style={{ color: callColor }} />;
        if (callDirection === 'inbound') return <PhoneIncoming className="size-4" style={{ color: callColor }} />;
        return <PhoneOutgoing className="size-4" style={{ color: callColor }} />;
    };

    const [menuOpen, setMenuOpen] = React.useState(false);
    const menuRef = React.useRef<HTMLDivElement>(null);

    // Close menu on outside click
    React.useEffect(() => {
        if (!menuOpen) return;
        const handler = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [menuOpen]);

    return (
        <button
            onClick={() => {
                if (!targetPath) return;
                navigate(targetPath);
                // Mark read on explicit user click — clear timeline + SMS sources
                if (hasUnread && tlId) {
                    callsApi.markTimelineRead(tlId).catch(() => { });
                    if ((call as any).sms_conversation_id) {
                        messagingApi.markRead((call as any).sms_conversation_id).catch(() => { });
                    }
                }
            }}
            className={`w-full text-left px-4 py-3 transition-colors border-b border-gray-100 relative ${isActive ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
            style={{ outline: 'none' }}
        >
            {/* Unread left bar */}
            {hasUnread && (
                <div
                    className="absolute left-0 top-0 bottom-0 w-[3px] rounded-r"
                    style={{ backgroundColor: '#2563eb' }}
                />
            )}
            <div className="flex items-start gap-2.5">
                <div className="shrink-0 pt-0.5">
                    {renderIcon()}
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between mb-1">
                        <span className={`text-sm truncate ${hasUnread ? 'font-semibold text-gray-900' : 'font-medium text-gray-900'}`}>{primaryText}</span>
                    </div>
                    {showSecondaryPhone && (
                        <div className="text-xs text-gray-600 mb-1 font-mono">{formatPhoneNumber(displayPhone)}</div>
                    )}
                    <div className="flex items-center gap-1 text-xs text-gray-500">
                        <span>{getTimeAgo(displayDate)}</span>
                        <span className="text-gray-400">•</span>
                        <span>{getFullDateTime(displayDate)}</span>
                    </div>
                    {/* Action Required badge + quick actions */}
                    {isActionRequired && !isSnoozed && (
                        <div className="flex items-center gap-1.5 mt-1">
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-orange-100 text-orange-800">
                                <AlertTriangle className="size-3" />
                                Action Required
                            </span>
                            {arReason && <span className="text-[10px] text-gray-500">{REASON_LABELS[arReason] || arReason}</span>}
                            {openTask?.due_at && (
                                <span className="text-[10px] text-red-500">
                                    Due {new Date(openTask.due_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                                </span>
                            )}
                        </div>
                    )}
                    {isSnoozed && (
                        <div className="flex items-center gap-1 mt-1">
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-600">
                                <Clock className="size-3" />
                                Snoozed until {new Date(snoozedUntil).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                            </span>
                        </div>
                    )}
                </div>
                {/* 3-dot menu — only on active item */}
                {isActive && (
                    <div className="shrink-0 relative" ref={menuRef}>
                        <div
                            role="button"
                            tabIndex={0}
                            onClick={(e) => { e.stopPropagation(); setMenuOpen(prev => !prev); }}
                            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setMenuOpen(prev => !prev); } }}
                            className="p-1 rounded hover:bg-blue-100 transition-colors cursor-pointer"
                            title="More options"
                        >
                            <MoreVertical className="size-4 text-gray-500" />
                        </div>
                        {menuOpen && (
                            <div className="absolute right-0 top-full mt-1 z-50 bg-white rounded-md shadow-lg border border-gray-200 py-1 min-w-[180px]">
                                {/* Mark as Unread */}
                                <div
                                    role="button"
                                    tabIndex={0}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setMenuOpen(false);
                                        if (tlId && onMarkUnread) onMarkUnread(tlId);
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            e.stopPropagation();
                                            setMenuOpen(false);
                                            if (tlId && onMarkUnread) onMarkUnread(tlId);
                                        }
                                    }}
                                    className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 cursor-pointer w-full"
                                >
                                    <EyeOff className="size-3.5" />
                                    Mark as Unread
                                </div>
                                {/* Mark Handled — only when action required */}
                                {isActionRequired && (
                                    <div
                                        role="button"
                                        tabIndex={0}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setMenuOpen(false);
                                            if (tlId && onMarkHandled) onMarkHandled(tlId);
                                        }}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                e.stopPropagation();
                                                setMenuOpen(false);
                                                if (tlId && onMarkHandled) onMarkHandled(tlId);
                                            }
                                        }}
                                        className="flex items-center gap-2 px-3 py-2 text-sm text-green-700 hover:bg-green-50 cursor-pointer w-full"
                                    >
                                        <CheckCircle2 className="size-3.5" />
                                        Mark Handled
                                    </div>
                                )}
                                {/* Snooze — only when action required */}
                                {isActionRequired && (
                                    <div className="relative">
                                        <div
                                            role="button"
                                            tabIndex={0}
                                            onClick={(e) => { e.stopPropagation(); setSnoozeMenuOpen(prev => !prev); }}
                                            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setSnoozeMenuOpen(prev => !prev); } }}
                                            className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 cursor-pointer w-full"
                                        >
                                            <Clock className="size-3.5" />
                                            Snooze…
                                        </div>
                                        {snoozeMenuOpen && (
                                            <div className="absolute left-full top-0 ml-1 z-50 bg-white rounded-md shadow-lg border border-gray-200 py-1 min-w-[140px]">
                                                {SNOOZE_OPTIONS.map(opt => (
                                                    <div
                                                        key={opt.label}
                                                        role="button"
                                                        tabIndex={0}
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setMenuOpen(false);
                                                            setSnoozeMenuOpen(false);
                                                            if (tlId && onSnooze) onSnooze(tlId, getSnoozeUntil(opt));
                                                        }}
                                                        className="px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 cursor-pointer"
                                                    >
                                                        {opt.label}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </button>
    );
}

// =============================================================================
// Convert API call to CallData (same logic as ConversationPage)
// =============================================================================
function callToCallData(call: any): CallData {
    const direction: CallData['direction'] =
        (call.direction || '').includes('inbound') ? 'incoming' : 'outgoing';

    const statusMap: Record<string, CallData['status']> = {
        'completed': 'completed',
        'no-answer': 'no-answer',
        'busy': 'busy',
        'failed': 'failed',
        'canceled': 'failed',
        'ringing': 'ringing',
        'in-progress': 'in-progress',
        'queued': 'ringing',
        'initiated': 'ringing',
        'voicemail_recording': 'voicemail_recording',
        'voicemail_left': 'voicemail_left',
    };
    const status = statusMap[call.status || 'completed'] || 'completed';

    const startTime = call.started_at ? new Date(call.started_at) : new Date(call.created_at);
    const endTime = call.ended_at ? new Date(call.ended_at) : startTime;

    return {
        id: String(call.id),
        direction,
        from: call.from_number || '',
        to: call.to_number || '',
        duration: call.duration_sec,
        status,
        startTime,
        endTime,
        cost: call.price ? parseFloat(call.price) : undefined,
        callSid: call.call_sid,
        queueTime: 0,
        parentCall: call.parent_call_sid || undefined,
        twilioDirection: call.direction,
        audioUrl: call.recording?.playback_url || undefined,
        recordingDuration: call.recording?.duration_sec || undefined,
        transcription: call.transcript?.text || undefined,
        transcriptStatus: call.transcript?.status as CallData['transcriptStatus'] || undefined,
        summary: call.transcript?.gemini_summary || undefined,
        answeredBy: call.answered_by || undefined,
    };
}

// =============================================================================
// PulsePage
// =============================================================================
export const PulsePage: React.FC = () => {
    const { id } = useParams<{ id: string }>();
    const location = useLocation();
    // Detect route type: /pulse/timeline/:id or /pulse/contact/:id
    const isTimelineRoute = location.pathname.startsWith('/pulse/timeline/');
    const timelineId = isTimelineRoute ? parseInt(id || '0') : 0;
    const contactId = isTimelineRoute ? 0 : parseInt(id || '0');

    // Search with debounce (server-side search)
    const [searchQuery, setSearchQuery] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        if (debounceTimer.current) clearTimeout(debounceTimer.current);
        debounceTimer.current = setTimeout(() => {
            setDebouncedSearch(searchQuery.trim());
        }, 300);
        return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); };
    }, [searchQuery]);

    // Contact list
    const { data: contactData, isLoading: contactsLoading, refetch: refetchContacts, fetchNextPage, hasNextPage, isFetchingNextPage } = useCallsByContact(debouncedSearch || undefined);

    // Infinite scroll sentinel
    const loadMoreRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (!loadMoreRef.current) return;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) {
                    fetchNextPage();
                }
            },
            { threshold: 0.1 }
        );
        observer.observe(loadMoreRef.current);
        return () => observer.disconnect();
    }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

    // Timeline data — use timelineId if on timeline route, else contactId
    const { data: timelineData, isLoading: timelineLoading, refetch: refetchTimeline } = usePulseTimeline(contactId, timelineId || undefined);

    // Real-time updates
    useRealtimeEvents({
        onCallUpdate: (event: SSECallEvent) => {
            if (event.parent_call_sid) return;
            refetchContacts();
            if (
                (contactId && event.contact_id && Number(event.contact_id) === contactId) ||
                (timelineId && event.timeline_id && Number(event.timeline_id) === timelineId)
            ) {
                refetchTimeline();
            }
        },
        onCallCreated: () => refetchContacts(),
        onMessageAdded: () => {
            // Incoming/outgoing SMS — refresh contact list for unread state + timestamps
            refetchContacts();
            if (contactId || timelineId) refetchTimeline();
        },
        onContactRead: () => {
            refetchContacts();
        },
        onGenericEvent: (eventType: string, _data: any) => {
            // Action Required SSE events: refetch contact list to update badges/sort
            if (['thread.action_required', 'thread.handled', 'thread.snoozed', 'thread.unsnoozed', 'thread.assigned'].includes(eventType)) {
                refetchContacts();
            }
        },
        onTranscriptDelta: (event: SSETranscriptDeltaEvent) => {
            appendTranscriptDelta(event.callSid, {
                text: event.text,
                speaker: event.speaker,
                turnOrder: event.turnOrder,
                isFinal: event.isFinal,
                receivedAt: event.receivedAt,
            });
        },
        onTranscriptFinalized: (event: SSETranscriptFinalizedEvent) => {
            finalizeTranscript(event.callSid, event.text);
            // Refetch timeline to pick up persisted transcript
            if (contactId || timelineId) refetchTimeline();
        },
    });

    // Deduplicate contacts by phone digits (safety net for SMS-only + call entries)
    const filteredCalls = useMemo(() => {
        const raw = contactData?.conversations || [];
        const seen = new Map<string, number>();
        const deduped: Call[] = [];
        for (const c of raw) {
            const phone = c.contact?.phone_e164 || c.from_number || '';
            const digits = phone.replace(/\D/g, '');
            if (!digits) { deduped.push(c); continue; }
            if (!seen.has(digits)) {
                seen.set(digits, deduped.length);
                deduped.push(c);
            }
            // Keep whichever was first (already sorted by recency)
        }
        return deduped;
    }, [contactData?.conversations]);

    // Transform calls to CallData for timeline
    const callDataItems = useMemo(() => {
        if (!timelineData?.calls) return [];
        return timelineData.calls.map(callToCallData);
    }, [timelineData?.calls]);

    // SMS data
    const messages = timelineData?.messages || [];
    const conversations = timelineData?.conversations || [];

    // Derive contact info for LeadCard (same as ConversationPage)
    const contactCalls = timelineData?.calls || [];
    const contact = (timelineData as any)?.contact || contactCalls[0]?.contact;
    // Phone: try timeline data, then call contact, then call from/to, then sidebar contact, then SMS conversation
    const selectedConv = filteredCalls.find((c: Call) => {
        const tlId = (c as any).timeline_id;
        return tlId ? tlId === timelineId : c.contact?.id === contactId;
    });
    const phone = contact?.phone_e164
        || (selectedConv as any)?.tl_phone
        || contactCalls[0]?.from_number
        || contactCalls[0]?.to_number
        || selectedConv?.contact?.phone_e164
        || selectedConv?.from_number
        || conversations[0]?.customer_e164
        || '';
    const hasActiveCall = contactCalls.some((c: any) => ['ringing', 'in-progress', 'queued', 'initiated', 'voicemail_recording'].includes(c.status));

    // Lead management state
    const { lead: fetchedLead, isLoading: leadLoading } = useLeadByPhone(phone || undefined);
    const [leadOverride, setLeadOverride] = useState<Lead | null>(null);
    const [editingLead, setEditingLead] = useState<Lead | null>(null);
    const [convertingLead, setConvertingLead] = useState<Lead | null>(null);
    const [selectedToPhone, setSelectedToPhone] = useState<string>('');

    // Use overridden lead if available (after mutations), otherwise fetched
    const lead = leadOverride || fetchedLead;

    React.useEffect(() => {
        setLeadOverride(null);
        setSelectedToPhone('');
    }, [phone]);

    // Contact detail panel state (for no-lead fallback)
    const [contactDetail, setContactDetail] = useState<{ contact: any; leads: ContactLead[] } | null>(null);
    const [contactDetailLoading, setContactDetailLoading] = useState(false);

    // Fetch full contact detail when there's no open lead but contact exists
    React.useEffect(() => {
        if (lead || leadLoading || !contact?.id) {
            setContactDetail(null);
            return;
        }
        let cancelled = false;
        setContactDetailLoading(true);
        contactsApi.getContact(contact.id).then(res => {
            if (!cancelled) {
                setContactDetail({ contact: res.data.contact, leads: res.data.leads });
            }
        }).catch(err => {
            console.warn('[PulsePage] Failed to load contact detail:', err);
            if (!cancelled) setContactDetail(null);
        }).finally(() => {
            if (!cancelled) setContactDetailLoading(false);
        });
        return () => { cancelled = true; };
    }, [lead, leadLoading, contact?.id]);

    // Derive secondary phone from lead or contact
    const secondaryPhone = lead?.SecondPhone || contact?.secondary_phone || '';
    const secondaryPhoneName = lead?.SecondPhoneName || contact?.secondary_phone_name || '';

    // Normalize phone digits for comparison
    const normalizeDigits = (p: string) => (p || '').replace(/\D/g, '');

    // Determine last-used phone from timeline (most recent call or SMS)
    const lastUsedPhone = useMemo(() => {
        if (!phone || !secondaryPhone) return phone;
        const mainDigits = normalizeDigits(phone);
        const secDigits = normalizeDigits(secondaryPhone);
        if (!secDigits || mainDigits === secDigits) return phone;

        // Build a timeline of events sorted by time descending
        type PhoneEvent = { phone: string; time: number };
        const events: PhoneEvent[] = [];

        // From SMS messages
        for (const msg of messages) {
            const msgPhone = msg.direction === 'inbound' ? msg.from_number : msg.to_number;
            if (msgPhone) {
                const d = normalizeDigits(msgPhone);
                if (d === mainDigits) events.push({ phone, time: new Date(msg.date_created_remote || msg.created_at).getTime() });
                else if (d === secDigits) events.push({ phone: secondaryPhone, time: new Date(msg.date_created_remote || msg.created_at).getTime() });
            }
        }

        // From calls
        for (const call of contactCalls) {
            const callPhone = call.direction?.includes('inbound') ? call.from_number : call.to_number;
            if (callPhone) {
                const d = normalizeDigits(callPhone);
                const t = new Date(call.started_at || call.created_at).getTime();
                if (d === mainDigits) events.push({ phone, time: t });
                else if (d === secDigits) events.push({ phone: secondaryPhone, time: t });
            }
        }

        if (events.length === 0) return phone;
        events.sort((a, b) => b.time - a.time);
        return events[0].phone;
    }, [phone, secondaryPhone, messages, contactCalls]);

    // Set default selectedToPhone when timeline loads
    React.useEffect(() => {
        if (lastUsedPhone && !selectedToPhone) {
            setSelectedToPhone(lastUsedPhone);
        }
    }, [lastUsedPhone, selectedToPhone]);

    // Lead action handlers (same pattern as LeadsPage)
    const handleUpdateStatus = async (uuid: string, status: string) => {
        try {
            await leadsApi.updateLead(uuid, { Status: status } as any);
            const detail = await leadsApi.getLeadByUUID(uuid);
            setLeadOverride(detail.data.lead);
            toast.success('Status updated');
        } catch { toast.error('Failed to update status'); }
    };

    const handleUpdateSource = async (uuid: string, source: string) => {
        try {
            await leadsApi.updateLead(uuid, { JobSource: source });
            const detail = await leadsApi.getLeadByUUID(uuid);
            setLeadOverride(detail.data.lead);
            toast.success('Source updated');
        } catch { toast.error('Failed to update source'); }
    };

    const handleUpdateComments = async (uuid: string, comments: string) => {
        try {
            await leadsApi.updateLead(uuid, { Comments: comments });
            const detail = await leadsApi.getLeadByUUID(uuid);
            setLeadOverride(detail.data.lead);
            toast.success('Comments saved');
        } catch { toast.error('Failed to save comments'); }
    };

    const handleMarkLost = async (uuid: string) => {
        try {
            await leadsApi.markLost(uuid);
            const detail = await leadsApi.getLeadByUUID(uuid);
            setLeadOverride(detail.data.lead);
            toast.success('Lead marked as lost');
        } catch { toast.error('Failed to mark lead as lost'); }
    };

    const handleActivate = async (uuid: string) => {
        try {
            await leadsApi.activateLead(uuid);
            const detail = await leadsApi.getLeadByUUID(uuid);
            setLeadOverride(detail.data.lead);
            toast.success('Lead activated');
        } catch { toast.error('Failed to activate lead'); }
    };

    const handleConvert = (_uuid: string) => {
        if (lead) setConvertingLead(lead);
    };

    const handleConvertSuccess = async (updatedLead: Lead) => {
        try {
            const detail = await leadsApi.getLeadByUUID(updatedLead.UUID);
            setLeadOverride(detail.data.lead);
        } catch {
            setLeadOverride(updatedLead);
        }
        setConvertingLead(null);
    };

    const handleDelete = async (uuid: string) => {
        await handleMarkLost(uuid);
    };

    const handleUpdateLead = async (updatedLead: Lead) => {
        setLeadOverride(updatedLead);
        setEditingLead(null);
        toast.success('Lead updated');
    };

    // Derive our Twilio proxy number from call data (for starting new conversations)
    const proxyPhone = useMemo(() => {
        if (conversations.length) return conversations[0].proxy_e164 || '';
        // For call-only contacts, our number is the other side of the call
        const firstCall = contactCalls[0];
        if (!firstCall) return '';
        const dir = firstCall.direction || '';
        // Inbound call: our number is to_number; Outbound: our number is from_number
        return dir.includes('inbound') ? (firstCall.to_number || '') : (firstCall.from_number || '');
    }, [conversations, contactCalls]);

    // Send SMS handler
    const handleSendMessage = async (message: string, files?: File[], targetPhone?: string) => {
        const sendTo = targetPhone || phone;
        // Find conversation matching the target phone
        const targetConv = conversations.find(c => normalizeDigits(c.customer_e164) === normalizeDigits(sendTo));

        if (targetConv) {
            // Existing conversation — send directly
            await messagingApi.sendMessage(targetConv.id, { body: message }, files?.[0]);
        } else if (sendTo && proxyPhone) {
            // Normalize phones to E.164 before sending to Twilio
            const toE164 = (p: string) => {
                const digits = p.replace(/\D/g, '');
                if (digits.startsWith('1') && digits.length === 11) return `+${digits}`;
                if (digits.length === 10) return `+1${digits}`;
                return `+${digits}`;
            };
            // No conversation yet for this phone — create one
            await messagingApi.startConversation({
                customerE164: toE164(sendTo),
                proxyE164: toE164(proxyPhone),
                initialMessage: message,
            });
        }
        refetchTimeline();
    };

    // AI text polish handler (Wand2 button)
    const handleAiFormat = async (message: string): Promise<string> => {
        try {
            const result = await messagingApi.polishText(message);
            if (result.fallback_used) {
                toast.warning('AI polish unavailable — original text kept');
                return message;
            }
            return result.polished_text;
        } catch (err: any) {
            const msg = err?.response?.status === 504 || err?.code === 'ECONNABORTED'
                ? 'AI polish timed out — try again'
                : 'AI polish failed — try again';
            toast.error(msg);
            return message;
        }
    };

    return (
        <div className="pulse-page">
            {/* Left sidebar: contact list */}
            <div className="pulse-sidebar">
                <div className="p-3 border-b">
                    <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                        <Input
                            placeholder="Search phone..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="pl-8 h-8 text-sm"
                        />
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto">
                    {contactsLoading ? (
                        <div className="p-3 space-y-2">
                            {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
                        </div>
                    ) : filteredCalls.length === 0 ? (
                        <div className="flex-1 flex flex-col items-center justify-center py-12">
                            <PhoneOff className="size-8 mx-auto mb-2 opacity-20" />
                            <p className="text-sm text-muted-foreground">No contacts found</p>
                        </div>
                    ) : (
                        filteredCalls.map((call, idx) => {
                            const tlId = (call as any).timeline_id;
                            const cId = call.contact?.id || call.id;
                            const isActive = tlId
                                ? location.pathname === `/pulse/timeline/${tlId}`
                                : (!!cId && location.pathname === `/pulse/contact/${cId}`);
                            return (
                                <PulseContactItem
                                    key={tlId ?? call.id ?? `c-${call.contact?.id ?? (call.from_number || idx)}`}
                                    call={call}
                                    isActive={isActive}
                                    onMarkUnread={async (timelineId) => {
                                        try {
                                            await callsApi.markTimelineUnread(timelineId);
                                            refetchContacts();
                                            toast.success('Marked as unread');
                                        } catch { toast.error('Failed to mark as unread'); }
                                    }}
                                    onMarkHandled={async (timelineId) => {
                                        try {
                                            await pulseApi.markHandled(timelineId);
                                            refetchContacts();
                                            toast.success('Marked as handled');
                                        } catch { toast.error('Failed to mark handled'); }
                                    }}
                                    onSnooze={async (timelineId, until) => {
                                        try {
                                            await pulseApi.snoozeThread(timelineId, until);
                                            refetchContacts();
                                            toast.success('Thread snoozed');
                                        } catch { toast.error('Failed to snooze'); }
                                    }}
                                />
                            );
                        })
                    )}
                    {/* Infinite scroll sentinel */}
                    <div ref={loadMoreRef} className="h-8 flex items-center justify-center">
                        {isFetchingNextPage && (
                            <div className="text-xs text-muted-foreground">Loading more...</div>
                        )}
                    </div>
                </div>
            </div>

            {/* Middle column: Lead Detail Panel / Contact Detail / Create Lead */}
            <div className="w-[400px] shrink-0 border-r bg-background flex flex-col overflow-hidden">
                {(contactId || timelineId) && phone ? (
                    lead ? (
                        <LeadDetailPanel
                            lead={lead}
                            onClose={() => { }}
                            onEdit={(lead) => setEditingLead(lead)}
                            onMarkLost={handleMarkLost}
                            onActivate={handleActivate}
                            onConvert={handleConvert}
                            onUpdateComments={handleUpdateComments}
                            onUpdateStatus={handleUpdateStatus}
                            onUpdateSource={handleUpdateSource}
                            onDelete={handleDelete}
                        />
                    ) : !leadLoading && contact?.id && contactDetail ? (
                        <div className="flex-1 overflow-y-auto">
                            <PulseContactPanel
                                contact={contactDetail.contact}
                                leads={contactDetail.leads}
                                loading={contactDetailLoading}
                                onAddressesChanged={() => {
                                    contactsApi.getContact(contact.id).then(res => {
                                        setContactDetail({ contact: res.data.contact, leads: res.data.leads });
                                    }).catch(() => { });
                                }}
                                onContactChanged={() => {
                                    contactsApi.getContact(contact.id).then(res => {
                                        setContactDetail({ contact: res.data.contact, leads: res.data.leads });
                                    }).catch(() => { });
                                }}
                            />
                        </div>
                    ) : !leadLoading && !contact?.id ? (
                        <div className="flex-1 overflow-y-auto">
                            <CreateLeadJobWizard
                                phone={phone}
                                hasActiveCall={hasActiveCall}
                            />
                        </div>
                    ) : null
                ) : null}
            </div>

            {/* Right column: timeline + SMS form */}
            <div className="pulse-timeline-column">
                {!contactId && !timelineId ? (
                    <div className="pulse-empty-state">
                        <Activity className="size-12 mb-4" style={{ opacity: 0.15 }} />
                        <p className="text-muted-foreground">Select a contact to view their timeline</p>
                    </div>
                ) : (
                    <>
                        {/* Action Required Header Bar */}
                        {(() => {
                            const conv = selectedConv as any;
                            if (!conv?.is_action_required) return null;
                            const isSnoozed = conv.snoozed_until && new Date(conv.snoozed_until) > new Date();
                            const tlId = conv.timeline_id;
                            return (
                                <div className="flex items-center gap-2 px-4 py-2 border-b" style={{ backgroundColor: isSnoozed ? '#f3f4f6' : '#fff7ed' }}>
                                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold"
                                        style={{ backgroundColor: isSnoozed ? '#e5e7eb' : '#fed7aa', color: isSnoozed ? '#4b5563' : '#9a3412' }}>
                                        {isSnoozed ? <Clock className="size-3" /> : <AlertTriangle className="size-3" />}
                                        {isSnoozed ? 'Snoozed' : 'Action Required'}
                                    </span>
                                    {conv.action_required_reason && (
                                        <span className="text-xs text-gray-500">{REASON_LABELS[conv.action_required_reason] || conv.action_required_reason}</span>
                                    )}
                                    {conv.open_task?.due_at && !isSnoozed && (
                                        <span className="text-xs text-red-500">
                                            Due {new Date(conv.open_task.due_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                                        </span>
                                    )}
                                    {isSnoozed && (
                                        <span className="text-xs text-gray-500">
                                            until {new Date(conv.snoozed_until).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                                        </span>
                                    )}
                                    <div className="flex-1" />
                                    {!isSnoozed && (
                                        <>
                                            <button
                                                onClick={() => {
                                                    if (tlId) pulseApi.markHandled(tlId).then(() => { refetchContacts(); toast.success('Marked as handled'); }).catch(() => toast.error('Failed'));
                                                }}
                                                className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-green-700 bg-green-50 hover:bg-green-100 rounded transition-colors"
                                            >
                                                <CheckCircle2 className="size-3" /> Handled
                                            </button>
                                            <div className="relative group">
                                                <button className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded transition-colors">
                                                    <Clock className="size-3" /> Snooze
                                                </button>
                                                <div className="absolute right-0 top-full mt-1 z-50 bg-white rounded-md shadow-lg border border-gray-200 py-1 min-w-[140px] hidden group-hover:block">
                                                    {SNOOZE_OPTIONS.map(opt => (
                                                        <div
                                                            key={opt.label}
                                                            role="button"
                                                            tabIndex={0}
                                                            onClick={() => {
                                                                if (tlId) pulseApi.snoozeThread(tlId, getSnoozeUntil(opt)).then(() => { refetchContacts(); toast.success('Snoozed'); }).catch(() => toast.error('Failed'));
                                                            }}
                                                            className="px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 cursor-pointer"
                                                        >
                                                            {opt.label}
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        </>
                                    )}
                                </div>
                            );
                        })()}
                        <div className="pulse-timeline-scroll">
                            <PulseTimeline
                                calls={callDataItems}
                                messages={messages}
                                loading={timelineLoading}
                            />
                        </div>
                        {phone && (
                            <SmsForm
                                onSend={handleSendMessage}
                                onAiFormat={handleAiFormat}
                                disabled={!phone}
                                lead={lead}
                                mainPhone={phone}
                                secondaryPhone={secondaryPhone}
                                secondaryPhoneName={secondaryPhoneName}
                                selectedPhone={selectedToPhone || phone}
                                onPhoneChange={setSelectedToPhone}
                            />
                        )}
                    </>
                )}
            </div>

            {/* Dialogs */}
            {editingLead && (
                <EditLeadDialog
                    lead={editingLead}
                    open={!!editingLead}
                    onOpenChange={(open) => !open && setEditingLead(null)}
                    onSuccess={handleUpdateLead}
                />
            )}

            {convertingLead && (
                <ConvertToJobDialog
                    lead={convertingLead}
                    open={!!convertingLead}
                    onOpenChange={(open) => !open && setConvertingLead(null)}
                    onSuccess={handleConvertSuccess}
                />
            )}
        </div>
    );
};
