import React, { useState, useMemo } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { useCallsByContact } from '../hooks/useConversations';
import { usePulseTimeline } from '../hooks/usePulseTimeline';
import { messagingApi } from '../services/messagingApi';
import { useRealtimeEvents, type SSECallEvent } from '../hooks/useRealtimeEvents';
import { PulseTimeline } from '../components/pulse/PulseTimeline';
import { SmsForm } from '../components/pulse/SmsForm';
import { LeadCard } from '../components/conversations/LeadCard';
import { normalizePhoneNumber, formatPhoneNumber } from '../utils/formatters';
import { useLeadByPhone } from '../hooks/useLeadByPhone';
import { Input } from '../components/ui/input';
import { Skeleton } from '../components/ui/skeleton';
import { Search, PhoneOff, Activity, PhoneIncoming, PhoneOutgoing, ArrowLeftRight } from 'lucide-react';
import type { Call } from '../types/models';
import type { CallData } from '../components/call-list-item';
import './PulsePage.css';

// =============================================================================
// Contact List Item (Pulse-specific — navigates to /pulse/contact/:id)
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

function PulseContactItem({ call, isActive }: { call: Call; isActive: boolean }) {
    const navigate = useNavigate();
    const targetPath = call.contact ? `/pulse/contact/${call.contact.id}` : `/pulse/contact/${call.id}`;

    const rawPhone = call.contact?.phone_e164 || call.from_number || call.to_number || call.call_sid;
    const { lead } = useLeadByPhone(rawPhone);
    const leadName = lead ? [lead.FirstName, lead.LastName].filter(Boolean).join(' ') : null;
    const company = lead?.Company || null;
    const primaryText = company || leadName || formatPhoneNumber(rawPhone);
    const showSecondaryPhone = !!(company || leadName);
    const displayDate = new Date(call.started_at || call.created_at);
    const iconDirection = call.direction === 'inbound' ? 'inbound'
        : call.direction?.startsWith('outbound') ? 'outbound'
            : call.direction === 'internal' ? 'internal' : 'outbound';
    const color = STATUS_ICON_COLORS[call.status?.toLowerCase() || ''] || '#16a34a';

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

    return (
        <button
            onClick={() => navigate(targetPath)}
            className={`w-full text-left px-4 py-3 transition-colors border-b border-gray-100 ${isActive ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
            style={{ outline: 'none' }}
        >
            <div className="flex items-start gap-2.5">
                <div className="shrink-0 pt-0.5">
                    {iconDirection === 'internal' ? <ArrowLeftRight className="size-4" style={{ color }} /> :
                        iconDirection === 'inbound' ? <PhoneIncoming className="size-4" style={{ color }} /> :
                            <PhoneOutgoing className="size-4" style={{ color }} />}
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between mb-1">
                        <span className="text-sm font-medium text-gray-900 truncate">{primaryText}</span>
                        {call.call_count !== undefined && call.call_count !== null && (
                            <span className="text-xs text-gray-500 ml-2 shrink-0">({call.call_count})</span>
                        )}
                    </div>
                    {showSecondaryPhone && (
                        <div className="text-xs text-gray-600 mb-1 font-mono">{formatPhoneNumber(rawPhone)}</div>
                    )}
                    <div className="flex items-center gap-1 text-xs text-gray-500">
                        <span>{getTimeAgo(displayDate)}</span>
                        <span className="text-gray-400">•</span>
                        <span>{getFullDateTime(displayDate)}</span>
                    </div>
                </div>
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
        answeredBy: call.answered_by || undefined,
    };
}

// =============================================================================
// PulsePage
// =============================================================================
export const PulsePage: React.FC = () => {
    const { id } = useParams<{ id: string }>();
    const contactId = parseInt(id || '0');
    const location = useLocation();

    // Contact list
    const { data: contactData, isLoading: contactsLoading, refetch: refetchContacts } = useCallsByContact();
    const [searchQuery, setSearchQuery] = useState('');

    // Timeline data
    const { data: timelineData, isLoading: timelineLoading, refetch: refetchTimeline } = usePulseTimeline(contactId);

    // Real-time updates
    useRealtimeEvents({
        onCallUpdate: (event: SSECallEvent) => {
            if (event.parent_call_sid) return;
            refetchContacts();
            if (contactId && event.contact_id && Number(event.contact_id) === contactId) {
                refetchTimeline();
            }
        },
        onCallCreated: () => refetchContacts(),
    });

    // Filter contacts
    const calls = contactData?.conversations || [];
    const filteredCalls = useMemo(() => {
        if (!searchQuery.trim()) return calls;
        const normalizedQuery = normalizePhoneNumber(searchQuery);
        return calls.filter(call => {
            const phone = call.from_number || call.to_number || '';
            return normalizePhoneNumber(phone).includes(normalizedQuery);
        });
    }, [calls, searchQuery]);

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
    const contact = contactCalls[0]?.contact;
    const phone = contact?.phone_e164 || contactCalls[0]?.from_number || contactCalls[0]?.to_number || '';
    const hasActiveCall = contactCalls.some((c: any) => ['ringing', 'in-progress', 'queued', 'initiated', 'voicemail_recording'].includes(c.status));

    // Send SMS handler
    const handleSendMessage = async (body: string, file?: File) => {
        if (!conversations.length) return;
        const convId = conversations[0].id;
        await messagingApi.sendMessage(convId, { body }, file);
        refetchTimeline();
    };

    return (
        <div className="pulse-page">
            {/* Left sidebar: contact list */}
            <div className="pulse-sidebar">
                <div className="flex items-center p-3 border-b gap-3">
                    <h2 className="text-lg font-semibold shrink-0">Pulse</h2>
                    <div className="relative flex-1 min-w-0">
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
                        filteredCalls.map((call) => (
                            <PulseContactItem
                                key={call.id}
                                call={call}
                                isActive={location.pathname === `/pulse/contact/${call.contact?.id || call.id}`}
                            />
                        ))
                    )}
                </div>
            </div>

            {/* Middle column: LeadCard / wizard (same as Calls section) */}
            <div className="w-[400px] shrink-0 border-r bg-background overflow-y-auto">
                {contactId && phone ? (
                    <LeadCard
                        phone={phone}
                        callCount={contactCalls.length}
                        hasActiveCall={hasActiveCall}
                    />
                ) : null}
            </div>

            {/* Right column: timeline + SMS form */}
            <div className="pulse-timeline-column">
                {!contactId ? (
                    <div className="pulse-empty-state">
                        <Activity className="size-12 mb-4" style={{ opacity: 0.15 }} />
                        <p className="text-muted-foreground">Select a contact to view their timeline</p>
                    </div>
                ) : (
                    <>
                        <div className="pulse-timeline-scroll">
                            <PulseTimeline
                                calls={callDataItems}
                                messages={messages}
                                loading={timelineLoading}
                            />
                        </div>
                        {conversations.length > 0 && (
                            <SmsForm
                                onSend={handleSendMessage}
                                disabled={!conversations.length}
                            />
                        )}
                    </>
                )}
            </div>
        </div>
    );
};
