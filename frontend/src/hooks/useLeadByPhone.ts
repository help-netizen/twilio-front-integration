import { useQuery } from '@tanstack/react-query';
import { getLeadByPhone } from '../services/leadsApi';
import type { Lead } from '../types/lead';

export function useLeadByPhone(phone: string | undefined) {
    const query = useQuery({
        queryKey: ['lead-by-phone', phone],
        queryFn: async () => {
            if (!phone) return null;
            const res = await getLeadByPhone(phone);
            return res.data.lead as Lead | null;
        },
        enabled: !!phone,
        staleTime: 60_000,
        retry: false,
    });

    return {
        lead: query.data ?? null,
        isLoading: query.isLoading,
    };
}
