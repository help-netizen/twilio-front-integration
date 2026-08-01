import { Navigate } from 'react-router-dom';
import { useAuthz } from '../../hooks/useAuthz';
import { resolveSettingsLanding, type SettingsGroupId } from './settingsNav';

export function SettingsLandingRedirect({ groupId }: { groupId?: SettingsGroupId }) {
    const { loading, permissions, platformRole, membership } = useAuthz();
    if (loading) return null;
    const to = resolveSettingsLanding({
        permissions,
        platformRole,
        tenantRole: membership?.role_key,
    }, groupId);
    return <Navigate to={to} replace />;
}
