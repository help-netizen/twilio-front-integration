import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Loader2 } from 'lucide-react';
import { BankTransferDetails } from '../components/settings/BankTransferDetails';
import { SettingsPageShell } from '../components/settings/SettingsPageShell';
import { SettingsSection } from '../components/settings/SettingsSection';
import { Button } from '../components/ui/button';
import { companyProfileApi, type CompanyProfile } from '../services/companyProfileApi';

export default function BankTransferDetailsPage() {
    const queryClient = useQueryClient();
    const profileQuery = useQuery({
        queryKey: ['company-profile'],
        queryFn: companyProfileApi.get,
    });
    const applySaved = (profile: CompanyProfile) => queryClient.setQueryData(['company-profile'], profile);

    return (
        <SettingsPageShell
            title="Bank transfer details"
            description="Control the direct-transfer instructions shown on customer documents."
        >
            {profileQuery.isLoading ? (
                <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--blanc-ink-3)' }}>
                    <Loader2 className="size-4 animate-spin" /> Loading bank transfer details…
                </div>
            ) : profileQuery.isError || !profileQuery.data ? (
                <SettingsSection>
                    <p className="flex items-start gap-2 text-sm" style={{ color: 'var(--blanc-warning)' }}>
                        <AlertCircle className="mt-0.5 size-4 shrink-0" />
                        {(profileQuery.error as Error | null)?.message || 'Could not load bank transfer details.'}
                    </p>
                    <Button variant="outline" size="sm" className="mt-3" onClick={() => profileQuery.refetch()}>
                        Try again
                    </Button>
                </SettingsSection>
            ) : (
                <BankTransferDetails profile={profileQuery.data} onSaved={applySaved} />
            )}
        </SettingsPageShell>
    );
}
