import React from 'react';
import { useParams } from 'react-router-dom';
import { useConversation, useConversationMessages } from '../hooks/useConversations';
import { ConversationList } from '../components/conversations/ConversationList';
import { CallListItem, type CallData } from '../components/call-list-item';
import { createPhoneLink } from '../utils/formatters';
import type { Message } from '../types/models';
import './ConversationPage.css';

function messageToCallData(message: Message): CallData {
    const direction: CallData['direction'] =
        (message.metadata?.actual_direction || message.direction || '').includes('inbound')
            ? 'incoming'
            : 'outgoing';

    // Map status to CallData status subset
    const rawStatus = message.call?.status || message.metadata?.status || 'completed';
    const statusMap: Record<string, CallData['status']> = {
        'completed': 'completed',
        'no-answer': 'no-answer',
        'busy': 'busy',
        'failed': 'failed',
        'canceled': 'failed',
    };
    const status = statusMap[rawStatus] || 'completed';

    const startTime = message.call?.start_time
        ? new Date(message.call.start_time)
        : new Date(message.created_at * 1000);
    const endTime = message.call?.end_time
        ? new Date(message.call.end_time)
        : startTime;

    return {
        id: message.id,
        direction,
        from: message.call?.from || message.metadata?.from_number || '',
        to: message.call?.to || message.metadata?.to_number || '',
        duration: message.call?.duration ?? message.metadata?.duration ?? null,
        totalDuration: message.metadata?.total_duration,
        talkTime: message.metadata?.talk_time,
        waitTime: message.metadata?.wait_time,
        status,
        startTime,
        endTime,
        cost: message.call?.price ? parseFloat(message.call.price) : undefined,
        callSid: message.call?.sid || message.metadata?.call_sid || message.external_id,
        queueTime: 0,
        parentCall: message.metadata?.parent_call_sid,
        twilioDirection: message.direction,
        audioUrl: message.call?.recording_url || message.metadata?.recording_url,
    };
}

export const ConversationPage: React.FC = () => {
    const { id } = useParams<{ id: string }>();
    const { data: conversation, isLoading: conversationLoading } = useConversation(id!);
    const { data: messages, isLoading: messagesLoading } = useConversationMessages(id!);

    if (conversationLoading || messagesLoading) {
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

    if (!conversation) {
        return (
            <div className="home-page">
                <div className="inbox-sidebar">
                    <ConversationList />
                </div>
                <div className="conversation-area">
                    <div className="error">Conversation not found</div>
                </div>
            </div>
        );
    }

    return (
        <div className="home-page">
            <div className="inbox-sidebar">
                <ConversationList />
            </div>

            <div className="conversation-area">
                <div className="conversation-header">
                    <div className="header-left">
                        <h2 dangerouslySetInnerHTML={{
                            __html: createPhoneLink(conversation.contact.name || conversation.contact.handle || conversation.external_id)
                        }} />
                        <div className="conversation-stats">
                            {conversation.metadata.total_calls} calls
                        </div>
                    </div>
                </div>

                <div className="messages-area">
                    <div className="space-y-4">
                        {messages?.map((message) => (
                            <CallListItem
                                key={message.id}
                                call={messageToCallData(message)}
                            />
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};

