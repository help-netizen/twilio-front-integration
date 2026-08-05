import { Navigate } from 'react-router-dom';
import { useAuthz } from '../../hooks/useAuthz';
import { resolveSettingsLanding, type SettingsGroupId } from './settingsNav';

export function SettingsLandingRedirect({ groupId }: { groupId?: SettingsGroupId }) {
    const { loading, permissions, platformRole, membership, company } = useAuthz();
    if (loading) return null;
    const to = resolveSettingsLanding({
        permissions,
        platformRole,
        tenantRole: membership?.role_key,
        companyFlags: { app_studio_enabled: company?.app_studio_enabled },
    }, groupId);
    return <Navigate to={to} replace />;
}
