import type { ReactNode } from 'react';
import { useAuth } from './AuthProvider';

interface ProtectedRouteProps {
    children: ReactNode;
    roles?: string[];
}

/**
 * Wraps a route to check that the user has at least one of the required roles.
 * If no roles specified, just checks that user is authenticated.
 * Shows "Access Denied" if the user lacks the required role.
 */
export function ProtectedRoute({ children, roles }: ProtectedRouteProps) {
    const { authenticated, hasRole } = useAuth();

    if (!authenticated) {
        return null; // AuthProvider handles redirect
    }

    if (roles && roles.length > 0 && !hasRole(...roles)) {
        return (
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100vh',
                background: '#0a0a0a',
                color: '#dc2626',
                fontFamily: 'Inter, system-ui, sans-serif',
            }}>
                <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>🚫</div>
                    <h2 style={{ margin: '0 0 0.5rem', color: '#fff' }}>Access Denied</h2>
                    <p style={{ color: '#888', fontSize: '0.875rem' }}>
                        You don't have permission to view this page.
                        <br />
                        Required role: {roles.join(' or ')}
                    </p>
                </div>
            </div>
        );
    }

    return <>{children}</>;
}
