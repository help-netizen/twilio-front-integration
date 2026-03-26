import { useQuery } from '@tanstack/react-query';
import { authedFetch } from '../services/apiClient';

// ─── Canonical types ─────────────────────────────────────────────────────────

export interface CustomFieldDef {
    id: string;
    display_name: string;
    api_name: string;
    field_type: string;
    is_system: boolean;
    is_searchable?: boolean;
    sort_order: number;
}

export interface JobTypeDef {
    name: string;
}

export interface LeadFormSettings {
    customFields: CustomFieldDef[];
    jobTypes: string[];
}

// ─── Hook ────────────────────────────────────────────────────────────────────

/**
 * Shared React Query hook for `/api/settings/lead-form`.
 * Caches the response so multiple consumers share a single network request.
 *
 * @param enabled — set to false to defer fetching (e.g. until dialog opens)
 */
export function useLeadFormSettings(enabled = true) {
    const { data, isLoading, error } = useQuery<LeadFormSettings>({
        queryKey: ['lead-form-settings'],
        queryFn: async () => {
            const res = await authedFetch('/api/settings/lead-form');
            const json = await res.json();
            if (!json.success) throw new Error('Failed to load lead-form settings');
            return {
                customFields: json.customFields ?? [],
                jobTypes: (json.jobTypes ?? []).map((jt: JobTypeDef) => jt.name),
            };
        },
        staleTime: 5 * 60 * 1000,  // 5 minutes — settings change rarely
        enabled,
    });

    return {
        customFields: data?.customFields ?? [],
        jobTypes: data?.jobTypes ?? [],
        isLoading,
        error,
    };
}
