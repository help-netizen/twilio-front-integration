import { useQuery } from '@tanstack/react-query';
import { getLeadByContact } from '../services/leadsApi';
import type { Lead } from '../types/lead';

export function useLeadByContact(contactId: number | undefined) {
    const query = useQuery({
        queryKey: ['lead-by-contact', contactId],
        queryFn: async () => {
            if (!contactId) return null;
            const res = await getLeadByContact(contactId);
            return res.data.lead as Lead | null;
        },
        enabled: !!contactId,
        staleTime: 60_000,
        retry: false,
    });

    return {
        lead: query.data ?? null,
        isLoading: query.isLoading,
    };
}
