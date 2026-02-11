import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import Keycloak from 'keycloak-js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuthUser {
    sub: string;
    email: string;
    name: string;
    roles: string[];
}

interface AuthContextType {
    authenticated: boolean;
    user: AuthUser | null;
    token: string | null;
    loading: boolean;
    hasRole: (...roles: string[]) => boolean;
    logout: () => void;
    accessDeniedMessage: string | null;
    clearAccessDenied: () => void;
}

const AuthContext = createContext<AuthContextType>({
    authenticated: false,
    user: null,
    token: null,
    loading: true,
    hasRole: () => false,
    logout: () => { },
    accessDeniedMessage: null,
    clearAccessDenied: () => { },
});

// ─── Feature flag ─────────────────────────────────────────────────────────────

const FEATURE_AUTH = import.meta.env.VITE_FEATURE_AUTH_ENABLED === 'true';
const KEYCLOAK_URL = import.meta.env.VITE_KEYCLOAK_URL || 'http://localhost:8080';
const KEYCLOAK_REALM = import.meta.env.VITE_KEYCLOAK_REALM || 'crm-prod';
const KEYCLOAK_CLIENT_ID = import.meta.env.VITE_KEYCLOAK_CLIENT_ID || 'crm-web';

// ─── Keycloak instance (singleton) ───────────────────────────────────────────

let keycloakInstance: Keycloak | null = null;

function getKeycloak(): Keycloak {
    if (!keycloakInstance) {
        keycloakInstance = new Keycloak({
            url: KEYCLOAK_URL,
            realm: KEYCLOAK_REALM,
            clientId: KEYCLOAK_CLIENT_ID,
        });
    }
    return keycloakInstance;
}

// ─── Extract roles from Keycloak token ──────────────────────────────────────

function extractRoles(kc: Keycloak): string[] {
    const roles = new Set<string>();
    const parsed = kc.tokenParsed as Record<string, unknown> | undefined;
    if (!parsed) return [];

    // realm_access.roles (standard Keycloak)
    const realmAccess = parsed.realm_access as { roles?: string[] } | undefined;
    if (realmAccess?.roles) {
        realmAccess.roles.forEach(r => roles.add(r));
    }

    // realm_roles (custom mapper)
    if (Array.isArray(parsed.realm_roles)) {
        (parsed.realm_roles as string[]).forEach(r => roles.add(r));
    }

    return Array.from(roles);
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
    const [authenticated, setAuthenticated] = useState(!FEATURE_AUTH);
    const [user, setUser] = useState<AuthUser | null>(
        FEATURE_AUTH ? null : { sub: 'dev', email: 'dev@localhost', name: 'Dev User', roles: ['owner_admin'] }
    );
    const [token, setToken] = useState<string | null>(null);
    const [loading, setLoading] = useState(FEATURE_AUTH);
    const [accessDeniedMessage, setAccessDeniedMessage] = useState<string | null>(null);

    // Listen for 401/403 events dispatched by API interceptors
    useEffect(() => {
        const handleSessionExpired = () => {
            if (FEATURE_AUTH) {
                getKeycloak().login();
            }
        };
        const handleAccessDenied = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            setAccessDeniedMessage(detail?.message || 'Access denied');
            // Auto-clear after 5 seconds
            setTimeout(() => setAccessDeniedMessage(null), 5000);
        };

        window.addEventListener('auth:session-expired', handleSessionExpired);
        window.addEventListener('auth:access-denied', handleAccessDenied);
        return () => {
            window.removeEventListener('auth:session-expired', handleSessionExpired);
            window.removeEventListener('auth:access-denied', handleAccessDenied);
        };
    }, []);

    useEffect(() => {
        if (!FEATURE_AUTH) return;

        const kc = getKeycloak();

        kc.init({
            onLoad: 'login-required',
            checkLoginIframe: false,
            pkceMethod: 'S256',
        })
            .then((auth) => {
                if (auth) {
                    const roles = extractRoles(kc);
                    setUser({
                        sub: kc.tokenParsed?.sub || '',
                        email: (kc.tokenParsed as Record<string, unknown>)?.email as string || '',
                        name: (kc.tokenParsed as Record<string, unknown>)?.name as string || 'Unknown',
                        roles,
                    });
                    setToken(kc.token || null);
                    setAuthenticated(true);

                    // Auto-refresh token before expiry
                    setInterval(() => {
                        kc.updateToken(60).catch(() => {
                            console.warn('[Auth] Token refresh failed, redirecting to login');
                            kc.login();
                        });
                    }, 30000);

                    // Update token in state when refreshed
                    kc.onTokenExpired = () => {
                        kc.updateToken(60).then(() => {
                            setToken(kc.token || null);
                        }).catch(() => kc.login());
                    };

                    kc.onAuthRefreshSuccess = () => {
                        setToken(kc.token || null);
                    };
                }
                setLoading(false);
            })
            .catch((err) => {
                console.error('[Auth] Keycloak init failed:', err);
                setLoading(false);
            });
    }, []);

    const hasRole = useCallback((...roles: string[]) => {
        if (!user) return false;
        return roles.some(r => user.roles.includes(r));
    }, [user]);

    const logout = useCallback(() => {
        if (FEATURE_AUTH) {
            getKeycloak().logout({ redirectUri: window.location.origin });
        }
    }, []);

    const clearAccessDenied = useCallback(() => setAccessDeniedMessage(null), []);

    // Loading screen
    if (loading) {
        return (
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100vh',
                background: '#0a0a0a',
                color: '#888',
                fontFamily: 'Inter, system-ui, sans-serif',
            }}>
                <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>🔐</div>
                    <div>Authenticating…</div>
                </div>
            </div>
        );
    }

    return (
        <AuthContext.Provider value={{ authenticated, user, token, loading, hasRole, logout, accessDeniedMessage, clearAccessDenied }}>
            {children}
        </AuthContext.Provider>
    );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useAuth(): AuthContextType {
    return useContext(AuthContext);
}

// ─── Fetch helper that injects auth token ────────────────────────────────────

export function getAuthHeaders(): Record<string, string> {
    const kc = FEATURE_AUTH ? getKeycloak() : null;
    if (kc?.token) {
        return { Authorization: `Bearer ${kc.token}` };
    }
    return {};
}
