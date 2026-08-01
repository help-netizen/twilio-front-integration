import { useCallback } from 'react';
import { useRealtimeEvents } from '../hooks/useRealtimeEvents';

export function useMessagesRealtime(
    selectedConversationId: string | null,
    refetchConversations: () => Promise<void>,
    refetchMessages: (conversationId: string) => Promise<void>,
) {
    const refreshMessagesData = useCallback(() => {
        void refetchConversations();
        if (selectedConversationId) void refetchMessages(selectedConversationId);
    }, [refetchConversations, refetchMessages, selectedConversationId]);

    useRealtimeEvents({
        onMessageAdded: refreshMessagesData,
        onConversationUpdated: refreshMessagesData,
        onMessageDelivery: refreshMessagesData,
    });
}
