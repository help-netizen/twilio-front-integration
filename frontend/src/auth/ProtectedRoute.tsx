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
        // Platform surfaces require the resolved platform role (ALB-106:
        // a legacy realm super_admin role no longer grants access).
        checks.push(hasPlatformRole(...platformRoles));
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
                height: '100vh', background: 'var(--blanc-bg, #efe9df)',
                fontFamily: '"IBM Plex Sans", system-ui, sans-serif', padding: 16,
            }}>
                <div style={{ textAlign: 'center', maxWidth: 360 }}>
                    <h2 style={{ margin: '0 0 8px', fontFamily: 'Manrope, sans-serif', fontSize: 20, fontWeight: 600, color: 'var(--blanc-ink-1, #202734)' }}>You don't have access here</h2>
                    <p style={{ color: 'var(--blanc-ink-2, #536070)', fontSize: 14, lineHeight: 1.6, margin: 0 }}>
                        This area isn't part of your role. Ask an admin if you need access to it.
                    </p>
                </div>
            </div>
        );
    }

    return <>{children}</>;
}
