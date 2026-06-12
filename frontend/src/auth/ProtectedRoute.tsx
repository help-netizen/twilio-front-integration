import type { ReactNode } from 'react';
import { useAuth } from './AuthProvider';
import { useAuthz } from '../hooks/useAuthz';

interface ProtectedRouteProps {
    children: ReactNode;
    /** Legacy tenant role names (compatibility only — no super_admin bypass). */
    roles?: string[];
    /** Canonical permission keys; access granted if the user has any of them. */
    permissions?: string[];
    /** Platform roles for platform-only routes (e.g. super_admin). */
    platformRoles?: string[];
}

/**
 * Permission-aware route guard (PF007-HARDENING-001).
 *
 * - permissions: checked against effective permissions from GET /api/auth/me
 * - roles: legacy compatibility check; a legacy `super_admin` token role does
 *   NOT grant tenant access anymore
 * - platformRoles: for platform-only surfaces; accepts the resolved platform
 *   role (with a legacy-token fallback during rollout)
 *
 * The backend stays authoritative — this guard only prevents loading hidden UI.
 */
export function ProtectedRoute({ children, roles, permissions, platformRoles }: ProtectedRouteProps) {
    const { authenticated, hasRole } = useAuth();
    const { hasAnyPermission, hasPlatformRole } = useAuthz();

    if (!authenticated) {
        return null; // AuthProvider handles redirect
    }

    const checks: boolean[] = [];

    if (platformRoles && platformRoles.length > 0) {
        // Rollout fallback: legacy realm super_admin still reaches the
        // platform page; it grants no tenant capability anywhere else.
        checks.push(hasPlatformRole(...platformRoles) || hasRole(...platformRoles));
    }
    if (roles && roles.length > 0) {
        checks.push(hasRole(...roles));
    }
    if (permissions && permissions.length > 0) {
        checks.push(hasAnyPermission(...permissions));
    }

    const hasAccess = checks.length === 0 ? true : checks.some(Boolean);

    if (!hasAccess) {
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
                        {platformRoles && platformRoles.length > 0 && <span>Platform role required: {platformRoles.join(' or ')}</span>}
                    </p>
                </div>
            </div>
        );
    }

    return <>{children}</>;
}
