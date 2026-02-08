import React from 'react';
import { useParams } from 'react-router-dom';
import { useContactCalls } from '../hooks/useConversations';
import { ConversationList } from '../components/conversations/ConversationList';
import { CallListItem, type CallData } from '../components/call-list-item';
import { createPhoneLink } from '../utils/formatters';
import type { Call } from '../types/models';
import './ConversationPage.css';

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
        transcription: call.transcript?.text || undefined,
    };
}

export const ConversationPage: React.FC = () => {
    const { id } = useParams<{ id: string }>();
    const contactId = parseInt(id || '0');
    const { data: calls, isLoading } = useContactCalls(contactId);

    if (isLoading) {
        return (
            <div className="home-page">
                <div className="inbox-sidebar">
                    <ConversationList />
                </div>
                <div className="conversation-area">
                    <div className="loading">Loading...</div>
                </div>
            </div>
        );
    }

    if (!calls || calls.length === 0) {
        return (
            <div className="home-page">
                <div className="inbox-sidebar">
                    <ConversationList />
                </div>
                <div className="conversation-area">
                    <div className="error">No calls found for this contact</div>
                </div>
            </div>
        );
    }

    // Derive contact info from the first call
    const contact = calls[0]?.contact;
    const displayName = contact?.full_name || contact?.phone_e164 || calls[0]?.from_number || calls[0]?.to_number;

    return (
        <div className="home-page">
            <div className="inbox-sidebar">
                <ConversationList />
            </div>

            <div className="conversation-area">
                <div className="conversation-header">
                    <div className="header-left">
                        <h2 dangerouslySetInnerHTML={{
                            __html: createPhoneLink(displayName || 'Unknown')
                        }} />
                        <div className="conversation-stats">
                            {calls.length} calls
                        </div>
                    </div>
                </div>

                <div className="messages-area">
                    <div className="space-y-4">
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
