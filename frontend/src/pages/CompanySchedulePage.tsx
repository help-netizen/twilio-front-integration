import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { DispatchSettingsForm } from '../components/settings/DispatchSettingsForm';
import { RecommendationSettings } from '../components/settings/RecommendationSettings';
import { SettingsPageShell } from '../components/settings/SettingsPageShell';
import { SettingsSection } from '../components/settings/SettingsSection';
import { Button } from '../components/ui/button';
import { useAuthz } from '../hooks/useAuthz';
import {
    fetchDispatchSettings,
    updateDispatchSettings,
    type DispatchSettings,
} from '../services/scheduleApi';

export const COMPANY_SCHEDULE_QUERY_KEY = ['dispatch-settings'] as const;

export default function CompanySchedulePage() {
    const queryClient = useQueryClient();
    const { hasPermission } = useAuthz();
    const canDispatch = hasPermission('schedule.dispatch');
    // Each embedded section retains its existing API guard.
    const canManageRecommendations = hasPermission('tenant.company.manage');
    const settingsQuery = useQuery({
        queryKey: COMPANY_SCHEDULE_QUERY_KEY,
        queryFn: fetchDispatchSettings,
        enabled: canDispatch,
    });
    const saveMutation = useMutation({
        mutationFn: updateDispatchSettings,
        onSuccess: (settings: DispatchSettings) => {
            queryClient.setQueryData(COMPANY_SCHEDULE_QUERY_KEY, settings);
            toast.success('Company schedule saved');
        },
        onError: (error: Error) => toast.error(error.message || 'Failed to save company schedule'),
    });

    return (
        <SettingsPageShell
            title="Company schedule"
            description={canDispatch && canManageRecommendations
                ? 'Set the company timezone, working week, and scheduling recommendation defaults.'
                : canDispatch
                    ? 'Set the company timezone and working week.'
                    : 'Tune the defaults Albusto uses for scheduling recommendations.'}
        >
            {canDispatch && (
                settingsQuery.isLoading ? (
                    <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--blanc-ink-3)' }}>
                        <Loader2 className="size-4 animate-spin" /> Loading company schedule…
                    </div>
                ) : settingsQuery.isError || !settingsQuery.data ? (
                    <SettingsSection>
                        <p className="flex items-start gap-2 text-sm" style={{ color: 'var(--blanc-warning)' }}>
                            <AlertCircle className="mt-0.5 size-4 shrink-0" />
                            {(settingsQuery.error as Error | null)?.message || 'Could not load the company schedule.'}
                        </p>
                        <Button variant="outline" size="sm" className="mt-3" onClick={() => settingsQuery.refetch()}>
                            Try again
                        </Button>
                    </SettingsSection>
                ) : (
                    <SettingsSection
                        title="Working week"
                        description="These hours define when the company is open for scheduling."
                    >
                        <DispatchSettingsForm
                            settings={settingsQuery.data}
                            onSave={updates => saveMutation.mutateAsync(updates)}
                        />
                    </SettingsSection>
                )
            )}

            {canManageRecommendations && (
                <SettingsSection
                    title="Recommendations"
                    description="Tune how Albusto finds and ranks available appointment windows."
                    flat
                >
                    <RecommendationSettings />
                </SettingsSection>
            )}
        </SettingsPageShell>
    );
}
