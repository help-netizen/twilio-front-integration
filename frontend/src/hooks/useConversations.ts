import { useQuery, useQueryClient } from '@tanstack/react-query';
import { callsApi } from '../services/api';
import { useCallback } from 'react';

/**
 * Hook: list of calls grouped by contact (sidebar / conversations list)
 */
export const useCallsByContact = () => {
    const queryClient = useQueryClient();

    const query = useQuery({
        queryKey: ['calls-by-contact'],
        queryFn: () => callsApi.getByContact(100),
        staleTime: 60000,
    });

    const refetch = useCallback(() => {
        queryClient.invalidateQueries({ queryKey: ['calls-by-contact'] });
    }, [queryClient]);

    return { ...query, refetch };
};

/**
 * Hook: all calls for a specific contact
 */
export const useContactCalls = (contactId: number) => {
    return useQuery({
        queryKey: ['contact-calls', contactId],
        queryFn: () => callsApi.getByContactId(contactId),
        enabled: !!contactId,
        refetchInterval: 5000,
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
