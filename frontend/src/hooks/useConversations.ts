import { useQuery, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { callsApi } from '../services/api';
import { useCallback } from 'react';

const PAGE_SIZE = 50;

/**
 * Hook: list of timelines grouped by contact (sidebar / conversations list)
 * Uses infinite query for scroll-based pagination.
 */
export const useCallsByContact = (search?: string) => {
    const queryClient = useQueryClient();

    const query = useInfiniteQuery({
        queryKey: ['calls-by-contact', search || ''],
        queryFn: ({ pageParam = 0 }) =>
            callsApi.getByContact(PAGE_SIZE, pageParam, search || undefined),
        initialPageParam: 0,
        getNextPageParam: (lastPage, allPages) => {
            const lastPageSize = lastPage.conversations?.length || 0;
            // If the last page returned fewer items than PAGE_SIZE, there are no more
            if (lastPageSize < PAGE_SIZE) return undefined;
            const loaded = allPages.reduce((n, p) => n + (p.conversations?.length || 0), 0);
            return loaded;
        },
        staleTime: 0,
    });

    const refetch = useCallback(() => {
        queryClient.invalidateQueries({ queryKey: ['calls-by-contact'] });
    }, [queryClient]);

    // Flatten pages into single conversations array for backwards compatibility
    const conversations = query.data?.pages?.flatMap(p => p.conversations || []) || [];
    const total = query.data?.pages?.[0]?.total || 0;

    return {
        ...query,
        data: { conversations, total },
        refetch,
    };
};

/**
 * Hook: all calls for a specific contact
 * Updates are driven by SSE events invalidating the cache key.
 */
export const useContactCalls = (contactId: number) => {
    return useQuery({
        queryKey: ['contact-calls', contactId],
        queryFn: () => callsApi.getByContactId(contactId),
        enabled: !!contactId,
    });
};

/**
 * Hook: active (non-final) calls
 */
export const useActiveCalls = () => {
    return useQuery({
        queryKey: ['active-calls'],
        queryFn: callsApi.getActive,
        refetchInterval: 3000,
    });
};

/**
 * Hook: single call by call_sid
 */
export const useCall = (callSid: string) => {
    return useQuery({
        queryKey: ['call', callSid],
        queryFn: () => callsApi.getByCallSid(callSid),
        enabled: !!callSid,
    });
};

/**
 * Hook: media (recordings + transcripts) for a call
 */
export const useCallMedia = (callSid: string) => {
    return useQuery({
        queryKey: ['call-media', callSid],
        queryFn: () => callsApi.getMedia(callSid),
        enabled: !!callSid,
    });
};
