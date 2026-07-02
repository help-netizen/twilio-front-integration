/**
 * useOnboardingChecklist — ONBTEL-001 Part A.
 *
 * React Query wrapper for GET /api/onboarding/checklist. Enabled ONLY for a
 * signed-in tenant_admin with a company (spec §1.4 A5/A7 — non-admins and
 * mid-onboarding users never fire the request). Errors are fail-quiet (A8):
 * no toast — the card simply doesn't render; React Query retries per its
 * own defaults.
 */
import { useQuery } from '@tanstack/react-query';
import { useAuthz } from './useAuthz';
import { fetchOnboardingChecklist, type OnboardingChecklist } from '../services/onboardingApi';

export function useOnboardingChecklist() {
    const { authenticated, company, isTenantAdmin } = useAuthz();

    const query = useQuery<OnboardingChecklist>({
        queryKey: ['onboarding-checklist', company?.id],
        queryFn: () => fetchOnboardingChecklist(),
        enabled: authenticated && !!company && isTenantAdmin(),
        // Spec §1.5/A4: refetch on mount + window focus closes the
        // return-from-wizard scenario (number bought → card disappears).
        // The app-level QueryClient disables focus refetch globally
        // (App.tsx defaultOptions), so this query opts back in.
        refetchOnWindowFocus: true,
    });

    return {
        checklist: query.data ?? null,
        isLoading: query.isLoading,
        error: query.error,
    };
}
