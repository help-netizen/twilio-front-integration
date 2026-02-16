import { useQuery, useQueryClient } from '@tanstack/react-query';
import { pulseApi } from '../services/pulseApi';
import { useCallback } from 'react';

/**
 * Hook: combined timeline (calls + SMS) for a contact
 */
export const usePulseTimeline = (contactId: number) => {
    const queryClient = useQueryClient();

    const query = useQuery({
        queryKey: ['pulse-timeline', contactId],
        queryFn: () => pulseApi.getTimeline(contactId),
        enabled: !!contactId,
        staleTime: 30000,
    });

    const refetch = useCallback(() => {
        queryClient.invalidateQueries({ queryKey: ['pulse-timeline', contactId] });
    }, [queryClient, contactId]);

    return { ...query, refetch };
};
