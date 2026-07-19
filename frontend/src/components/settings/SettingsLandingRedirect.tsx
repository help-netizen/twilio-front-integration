import { Navigate } from 'react-router-dom';
import { useAuthz } from '../../hooks/useAuthz';
import { resolveSettingsLanding, type SettingsGroupId } from './settingsNav';

export function SettingsLandingRedirect({ groupId }: { groupId?: SettingsGroupId }) {
    const { loading, permissions, platformRole } = useAuthz();
    if (loading) return null;
    const to = resolveSettingsLanding({ permissions, platformRole }, groupId);
    return <Navigate to={to} replace />;
}
