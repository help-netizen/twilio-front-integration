import { useQuery } from '@tanstack/react-query';
import { conversationsApi } from '../services/api';

export const useConversations = () => {
    return useQuery({
        queryKey: ['conversations'],
        queryFn: conversationsApi.getAll,
        refetchInterval: 10000  // Poll every 10 seconds for new calls
    });
};

export const useConversation = (id: string) => {
    return useQuery({
        queryKey: ['conversation', id],
        queryFn: () => conversationsApi.getById(id),
        enabled: !!id
    });
};

export const useConversationMessages = (conversationId: string) => {
    return useQuery({
        queryKey: ['messages', conversationId],
        queryFn: () => conversationsApi.getMessages(conversationId),
        enabled: !!conversationId,
        refetchInterval: 5000  // Poll every 5 seconds for new messages
    });
};
