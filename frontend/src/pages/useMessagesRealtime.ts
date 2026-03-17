import { useCallback } from 'react';
import { useRealtimeEvents, type SSEMessageAddedEvent, type SSEConversationUpdatedEvent, type SSEMessageDeliveryEvent } from '../hooks/useRealtimeEvents';
import type { Conversation, Message } from '../types/messaging';

export function useMessagesRealtime(
    selectedConversation: Conversation | null,
    setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
    setConversations: React.Dispatch<React.SetStateAction<Conversation[]>>,
    setSelectedConversation: React.Dispatch<React.SetStateAction<Conversation | null>>,
) {
    useRealtimeEvents({
        onMessageAdded: useCallback((event: SSEMessageAddedEvent) => {
            if (selectedConversation && event.conversationId === selectedConversation.id) {
                setMessages(prev => {
                    const exists = prev.some(m => m.id === event.message.id || (m.twilio_message_sid && m.twilio_message_sid === event.message.twilio_message_sid));
                    if (exists) return prev;
                    return [...prev, event.message];
                });
            }
        }, [selectedConversation]),

        onConversationUpdated: useCallback((event: SSEConversationUpdatedEvent) => {
            const updatedConv = event.conversation;
            setConversations(prev => {
                const idx = prev.findIndex(c => c.id === updatedConv.id);
                if (idx >= 0) {
                    const updated = [...prev];
                    updated[idx] = updatedConv;
                    updated.sort((a, b) => {
                        if (a.has_unread !== b.has_unread) return a.has_unread ? -1 : 1;
                        const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
                        const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
                        return tb - ta;
                    });
                    return updated;
                } else return [updatedConv, ...prev];
            });
            if (selectedConversation && updatedConv.id === selectedConversation.id) setSelectedConversation(updatedConv);
        }, [selectedConversation]),

        onMessageDelivery: useCallback((event: SSEMessageDeliveryEvent) => {
            setMessages(prev => prev.map(m => m.twilio_message_sid === event.messageSid ? { ...m, delivery_status: event.status } : m));
        }, []),
    });
}
