import { useQuery, useQueryClient } from '@tanstack/react-query';
import { conversationsApi } from '../services/api';
import { useCallback } from 'react';

export const useConversations = () => {
    const queryClient = useQueryClient();

    const query = useQuery({
        queryKey: ['conversations'],
        queryFn: conversationsApi.getAll,
        // Removed polling - will use SSE events for updates
        staleTime: 60000 // Consider data fresh for 1 minute
    });

    // Manual refetch function for SSE events
    const refetch = useCallback(() => {
        queryClient.invalidateQueries({ queryKey: ['conversations'] });
    }, [queryClient]);

    return {
        ...query,
        refetch
    };
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
