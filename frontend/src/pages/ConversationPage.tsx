import React from 'react';
import { useParams } from 'react-router-dom';
import { useContactCalls } from '../hooks/useConversations';
import { ConversationList } from '../components/conversations/ConversationList';
import { CallListItem, type CallData } from '../components/call-list-item';
import { formatPhoneNumber } from '../utils/formatters';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import { Phone, PhoneOff } from 'lucide-react';
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
    };
}

export const ConversationPage: React.FC = () => {
    const { id } = useParams<{ id: string }>();
    const contactId = parseInt(id || '0');
    const { data: calls, isLoading } = useContactCalls(contactId);

    if (isLoading) {
        return (
            <div className="flex h-full overflow-hidden">
                <div className="w-[360px] shrink-0 border-r flex flex-col bg-background">
                    <ConversationList />
                </div>
                <div className="flex-1 flex flex-col bg-background p-6 space-y-4">
                    <Skeleton className="h-10 w-64" />
                    {[...Array(3)].map((_, i) => (
                        <Skeleton key={i} className="h-32 w-full" />
                    ))}
                </div>
            </div>
        );
    }

    if (!calls || calls.length === 0) {
        return (
            <div className="flex h-full overflow-hidden">
                <div className="w-[360px] shrink-0 border-r flex flex-col bg-background">
                    <ConversationList />
                </div>
                <div className="flex-1 flex flex-col bg-background">
                    <div className="flex-1 flex items-center justify-center">
                        <div className="text-center">
                            <PhoneOff className="size-12 mx-auto mb-3 opacity-20" />
                            <p className="text-lg mb-2">No calls found</p>
                            <p className="text-sm text-muted-foreground">
                                No calls found for this contact
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    // Derive contact info from the first call
    const contact = calls[0]?.contact;
    const displayName = contact?.full_name || contact?.phone_e164 || calls[0]?.from_number || calls[0]?.to_number;

    return (
        <div className="flex h-full overflow-hidden">
            <div className="w-[360px] shrink-0 border-r flex flex-col bg-background">
                <ConversationList />
            </div>

            <div className="flex-1 flex flex-col bg-background overflow-hidden">
                <div className="border-b p-4">
                    <div className="flex items-center gap-3">
                        <Phone className="size-5 text-muted-foreground" />
                        <h2
                            className="text-xl font-semibold"
                            dangerouslySetInnerHTML={{
                                __html: formatPhoneNumber(displayName || 'Unknown')
                            }}
                        />
                        <Badge variant="secondary">{calls.length} calls</Badge>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto p-5">
                    <div className="space-y-4 max-w-3xl">
                        {calls.map((call) => (
                            <CallListItem
                                key={call.id}
                                call={callToCallData(call)}
                            />
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};
