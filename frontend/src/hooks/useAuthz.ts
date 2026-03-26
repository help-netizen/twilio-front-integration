import { useAuth } from '../auth/AuthProvider';

export function useAuthz() {
    const { authenticated, user, loading, platformRole, company, membership, permissions, scopes } = useAuth();

    const hasPermission = (key: string) => {
        if (!authenticated || !permissions) return false;
        return permissions.includes(key);
    };

    const hasAnyPermission = (...keys: string[]) => {
        if (!authenticated || !permissions) return false;
        return keys.some(k => permissions.includes(k));
    };

    const hasPlatformRole = (...roles: string[]) => {
        if (!authenticated || !platformRole) return false;
        return roles.includes(platformRole);
    };

    const isTenantAdmin = () => {
        return membership?.role_key === 'tenant_admin' || user?.roles.includes('company_admin');
    };

    return {
        authenticated,
        loading,
        user,
        platformRole,
        company,
        membership,
        permissions,
        scopes,
        hasPermission,
        hasAnyPermission,
        hasPlatformRole,
        isTenantAdmin,
    };
}
