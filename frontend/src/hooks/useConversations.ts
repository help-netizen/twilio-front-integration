import { useQuery, useQueryClient } from '@tanstack/react-query';
import { callsApi } from '../services/api';
import { useCallback } from 'react';

/**
 * Hook: list of calls grouped by contact (sidebar / conversations list)
 */
export const useCallsByContact = (search?: string) => {
    const queryClient = useQueryClient();

    const query = useQuery({
        queryKey: ['calls-by-contact', search || ''],
        queryFn: () => callsApi.getByContact(100, 0, search || undefined),
        staleTime: 0, // Always refetch on mount so new messages show after navigating
    });

    const refetch = useCallback(() => {
        queryClient.invalidateQueries({ queryKey: ['calls-by-contact'] });
    }, [queryClient]);

    return { ...query, refetch };
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
