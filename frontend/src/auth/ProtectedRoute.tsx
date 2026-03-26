import type { ReactNode } from 'react';
import { useAuth } from './AuthProvider';
import { useAuthz } from '../hooks/useAuthz';

interface ProtectedRouteProps {
    children: ReactNode;
    roles?: string[];
    permissions?: string[];
}

/**
 * Wraps a route to check that the user has at least one of the required roles OR permissions.
 * If no roles/permissions specified, just checks that user is authenticated.
 * Shows "Access Denied" if the user lacks access.
 */
export function ProtectedRoute({ children, roles, permissions }: ProtectedRouteProps) {
    const { authenticated, hasRole } = useAuth();
    const { hasAnyPermission } = useAuthz();

    if (!authenticated) {
        return null; // AuthProvider handles redirect
    }

    let hasAccess = true;

    // Check legacy roles if provided
    if (roles && roles.length > 0) {
        hasAccess = hasRole(...roles);
    }

    // Check new permissions if provided (combinative logic: if roles failed, check permissions)
    if (!hasAccess && permissions && permissions.length > 0) {
        hasAccess = hasAnyPermission(...permissions);
    }

    // Default: if permissions provided but roles not provided
    if ((!roles || roles.length === 0) && permissions && permissions.length > 0) {
        hasAccess = hasAnyPermission(...permissions);
    }
    
    // Exception for super_admin on legacy roles check
    if (roles && roles.length > 0 && hasRole('super_admin')) {
         hasAccess = true;
    }

    if (!hasAccess && ((roles && roles.length > 0) || (permissions && permissions.length > 0))) {
        return (
            <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                height: '100vh', background: '#0a0a0a', color: '#dc2626',
                fontFamily: 'Inter, system-ui, sans-serif',
            }}>
                <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>🚫</div>
                    <h2 style={{ margin: '0 0 0.5rem', color: '#fff' }}>Access Denied</h2>
                    <p style={{ color: '#888', fontSize: '0.875rem' }}>
                        You don't have permission to view this page.
                        <br />
                        {roles && roles.length > 0 && <span>Required role: {roles.join(' or ')}</span>}
                        {roles && permissions && <br />}
                        {permissions && permissions.length > 0 && <span>Required permission: {permissions.join(' or ')}</span>}
                    </p>
                </div>
            </div>
        );
    }

    return <>{children}</>;
}
