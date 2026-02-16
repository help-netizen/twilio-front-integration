import React from 'react';
import { useParams } from 'react-router-dom';
import { useContactCalls } from '../hooks/useConversations';
import { useRealtimeEvents, type SSECallEvent } from '../hooks/useRealtimeEvents';
import { useQueryClient } from '@tanstack/react-query';
import { ConversationList } from '../components/conversations/ConversationList';
import { CallListItem, type CallData } from '../components/call-list-item';
import { LeadCard } from '../components/conversations/LeadCard';
import { Skeleton } from '../components/ui/skeleton';
import { PhoneOff } from 'lucide-react';
import type { Call } from '../types/models';

function callToCallData(call: Call): CallData {
    const direction: CallData['direction'] =
        (call.direction || '').includes('inbound') ? 'incoming' : 'outgoing';

    const rawStatus = call.status || 'completed';
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
    const status = statusMap[rawStatus] || 'completed';

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

export const ConversationPage: React.FC = () => {
    const { id } = useParams<{ id: string }>();
    const contactId = parseInt(id || '0');
    const { data: calls, isLoading } = useContactCalls(contactId);
    const queryClient = useQueryClient();

    // Subscribe to SSE events — update contact-calls cache inline
    // so duration, status, and other fields update in real-time
    useRealtimeEvents({
        onCallUpdate: (event: SSECallEvent) => {
            if (event.parent_call_sid) return; // skip child legs

            // Only process events for this contact
            if (event.contact_id && event.contact_id !== contactId) return;

            // Inline update for instant duration/status feedback
            queryClient.setQueryData<Call[]>(
                ['contact-calls', contactId],
                (old) => {
                    if (!old) return old;
                    const idx = old.findIndex(c => c.call_sid === event.call_sid);
                    if (idx === -1) return old;

                    const updated = [...old];
                    updated[idx] = {
                        ...updated[idx],
                        status: (event.status as Call['status']) ?? updated[idx].status,
                        is_final: event.is_final ?? updated[idx].is_final,
                        duration_sec: event.duration_sec ?? updated[idx].duration_sec,
                        ended_at: event.ended_at ?? updated[idx].ended_at,
                        answered_by: event.answered_by ?? updated[idx].answered_by,
                    };
                    return updated;
                }
            );

            // Also refetch full data so recordings/transcripts appear
            // (they arrive via separate events not included in call SSE payload)
            if (event.is_final) {
                queryClient.invalidateQueries({ queryKey: ['contact-calls', contactId] });
            }
        },
        onCallCreated: (event: SSECallEvent) => {
            if (event.parent_call_sid) return;
            if (event.contact_id && event.contact_id === contactId) {
                queryClient.invalidateQueries({ queryKey: ['contact-calls', contactId] });
            }
        },
    });

    if (isLoading) {
        return (
            <div className="flex h-full overflow-hidden">
                <div className="w-[360px] shrink-0 border-r flex flex-col bg-background">
                    <ConversationList />
                </div>
                <div className="w-[400px] shrink-0 border-r bg-background overflow-y-auto">
                    <Skeleton className="h-10 w-64 m-4" />
                </div>
                <div className="flex-1 flex flex-col bg-background p-6 space-y-4 overflow-y-auto">
                    {[...Array(3)].map((_, i) => (
                        <Skeleton key={i} className="h-32 w-full" />
                    ))}
                </div>
            </div>
        );
    }

    // Derive contact info from the first call
    const contact = calls?.[0]?.contact;
    const phone = contact?.phone_e164 || calls?.[0]?.from_number || calls?.[0]?.to_number || '';

    return (
        <div className="flex h-full overflow-hidden">
            <div className="w-[360px] shrink-0 border-r flex flex-col bg-background">
                <ConversationList />
            </div>

            {/* Lead card / wizard — 400px fixed column, no padding */}
            <div className="w-[400px] shrink-0 border-r bg-background overflow-y-auto">
                {phone && (
                    <LeadCard
                        phone={phone}
                        callCount={calls?.length}
                        hasActiveCall={calls?.some(c => ['ringing', 'in-progress', 'queued', 'initiated', 'voicemail_recording'].includes(c.status))}
                    />
                )}
            </div>

            {/* Call list — remaining space */}
            <div className="flex-1 flex flex-col bg-background overflow-y-auto">
                {!calls || calls.length === 0 ? (
                    <div className="flex-1 flex items-center justify-center">
                        <div className="text-center">
                            <PhoneOff className="size-12 mx-auto mb-3 opacity-20" />
                            <p className="text-lg mb-2">No calls found</p>
                            <p className="text-sm text-muted-foreground">
                                No calls found for this contact
                            </p>
                        </div>
                    </div>
                ) : (
                    <div className="p-5">
                        <div className="space-y-4">
                            {calls.map((call) => (
                                <CallListItem
                                    key={call.id}
                                    call={callToCallData(call)}
                                />
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};
