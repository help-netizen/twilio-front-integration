import { useQuery } from '@tanstack/react-query';
import { getLeadsByPhones } from '../services/leadsApi';
import type { Lead } from '../types/lead';

/**
 * Batch-fetch leads for a list of phone numbers in 1 request.
 * Returns a map of normalized-phone (last 10 digits) → Lead | null.
 *
 * Use this in list views (PulseContactItem, ConversationListItem)
 * instead of calling useLeadByPhone() per item (N+1 problem).
 */
export function useLeadsByPhones(phones: string[]) {
    // Normalize to last-10-digits for stable cache keys
    const normalizePhone = (p: string) => {
        const d = (p || '').replace(/\D/g, '');
        return d.length >= 10 ? d.slice(-10) : d;
    };

    const normalizedPhones = phones
        .map(normalizePhone)
        .filter(d => d.length > 0);
    const uniquePhones = [...new Set(normalizedPhones)];

    // Stable sort for cache key
    const sortedKey = [...uniquePhones].sort().join(',');

    const query = useQuery({
        queryKey: ['leads-by-phones', sortedKey],
        queryFn: async () => {
            if (uniquePhones.length === 0) return {} as Record<string, Lead | null>;
            return getLeadsByPhones(uniquePhones);
        },
        enabled: uniquePhones.length > 0,
        staleTime: 60_000,
        retry: false,
    });

    return {
        leadsMap: (query.data ?? {}) as Record<string, Lead | null>,
        isLoading: query.isLoading,
        /**
         * Get lead for a specific raw phone number.
         * Returns null if not found or still loading.
         */
        getLeadForPhone: (rawPhone: string | undefined): Lead | null => {
            if (!rawPhone || !query.data) return null;
            const key = normalizePhone(rawPhone);
            return query.data[key] ?? null;
        },
    };
}
