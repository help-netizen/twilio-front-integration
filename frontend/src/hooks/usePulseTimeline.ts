import { useQuery, useQueryClient } from '@tanstack/react-query';
import { pulseApi } from '../services/pulseApi';
import { useCallback } from 'react';

/**
 * Hook: combined timeline (calls + SMS) for a contact or timeline.
 * Supports both contactId (legacy) and timelineId (new).
 *
 * React Query passes an AbortSignal to queryFn — when the user switches
 * timelines rapidly, the previous in-flight request is automatically cancelled.
 */
export const usePulseTimeline = (contactId: number, timelineId?: number) => {
    const queryClient = useQueryClient();
    const mode = timelineId ? 'timeline' : 'contact';
    const key = timelineId || contactId;

    const query = useQuery({
        queryKey: ['pulse-timeline', mode, key],
        queryFn: ({ signal }) => timelineId
            ? pulseApi.getTimelineById(timelineId, signal)
            : pulseApi.getTimeline(contactId, signal),
        enabled: !!key,
        staleTime: 30000,
    });

    const refetch = useCallback(() => {
        queryClient.invalidateQueries({ queryKey: ['pulse-timeline', mode, key] });
    }, [queryClient, mode, key]);

    return { ...query, refetch };
};
