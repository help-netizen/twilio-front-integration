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
    
    // PF007 Extended Profile
    platformRole?: string;
    company?: { id: string; name: string; slug: string; status: string; timezone: string } | null;
    membership?: { id: string; role_key: string; role_name: string; is_primary: boolean; status: string } | null;
    permissions?: string[];
    scopes?: Record<string, any>;

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
let kcInitialized = false;

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

    if ((parsed.realm_access as any)?.roles) {
        (parsed.realm_access as any).roles.forEach((r: string) => roles.add(r));
    }
    if (Array.isArray(parsed.realm_roles)) {
        (parsed.realm_roles as string[]).forEach(r => roles.add(r));
    }

    return Array.from(roles);
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
    const [authenticated, setAuthenticated] = useState(!FEATURE_AUTH);
    const [user, setUser] = useState<AuthUser | null>(
        FEATURE_AUTH ? null : { sub: 'dev', email: 'dev@localhost', name: 'Dev User', roles: ['super_admin', 'company_admin'] }
    );
    const [token, setToken] = useState<string | null>(null);
    const [loading, setLoading] = useState(FEATURE_AUTH);
    const [accessDeniedMessage, setAccessDeniedMessage] = useState<string | null>(null);

    // PF007 Extended Profile state
    const [platformRole, setPlatformRole] = useState<string>('none');
    const [company, setCompany] = useState<any>(null);
    const [membership, setMembership] = useState<any>(null);
    const [permissions, setPermissions] = useState<string[]>([]);
    const [scopes, setScopes] = useState<Record<string, any>>({});

    // Listen for 401/403 events dispatched by API interceptors
    useEffect(() => {
        let loginPending = false;
        const handleSessionExpired = () => {
            if (FEATURE_AUTH && !loginPending) {
                loginPending = true;
                getKeycloak().login();
            }
        };
        const handleAccessDenied = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            setAccessDeniedMessage(detail?.message || 'Access denied');
            setTimeout(() => setAccessDeniedMessage(null), 5000);
        };

        window.addEventListener('auth:session-expired', handleSessionExpired);
        window.addEventListener('auth:access-denied', handleAccessDenied);
        return () => {
            window.removeEventListener('auth:session-expired', handleSessionExpired);
            window.removeEventListener('auth:access-denied', handleAccessDenied);
        };
    }, []);

    // Fetch authz context from backend
    const fetchAuthzContext = async (jwtToken: string) => {
        try {
            const res = await fetch('/api/auth/me', {
                headers: { 'Authorization': `Bearer ${jwtToken}` }
            });
            if (res.ok) {
                const data = await res.json();
                setPlatformRole(data.user?.platform_role || 'none');
                setCompany(data.company);
                setMembership(data.membership);
                setPermissions(data.permissions || []);
                setScopes(data.scopes || {});
            } else {
                console.warn('[Auth] Failed to load auth context', res.status);
            }
        } catch (err) {
            console.error('[Auth] Error fetching auth context', err);
        }
    };

    useEffect(() => {
        if (!FEATURE_AUTH) {
            // Dev mode mock context
            setPlatformRole('none');
            setCompany({ id: '00000000-0000-0000-0000-000000000001', name: 'Boston Masters', slug: 'boston-masters', status: 'active', timezone: 'America/New_York' });
            setMembership({ id: 'dev-membership', role_key: 'tenant_admin', role_name: 'Tenant Admin', is_primary: true, status: 'active' });
            setPermissions([
                'tenant.company.view', 'tenant.company.manage',
                'tenant.users.view', 'tenant.users.manage',
                'tenant.roles.view', 'tenant.roles.manage',
                'tenant.integrations.manage', 'tenant.telephony.manage',
                'dashboard.view', 'pulse.view',
                'messages.view_internal', 'messages.view_client', 'messages.send',
                'contacts.view', 'contacts.edit',
                'leads.view', 'leads.create', 'leads.edit', 'leads.convert',
                'jobs.view', 'jobs.create', 'jobs.edit', 'jobs.assign',
                'jobs.close', 'jobs.done_pending_approval',
                'schedule.view', 'schedule.dispatch',
                'financial_data.view',
                'estimates.view', 'estimates.create', 'estimates.send',
                'invoices.view', 'invoices.create', 'invoices.send',
                'payments.view', 'payments.collect_online', 'payments.collect_offline', 'payments.refund',
                'reports.dashboard.view', 'reports.jobs.view', 'reports.leads.view',
                'reports.calls.view', 'reports.payments.view', 'reports.financial.view',
                'client_job_history.view',
                'provider.enabled', 'phone_calls.use', 'call_masking.use',
                'gps_tracking.view', 'gps_tracking.collect',
            ]);
            setScopes({ job_visibility: 'all', financial_scope: 'full', dashboard_scope: 'all_widgets', report_scope: 'all', job_close_scope: 'close_allowed' });
            return;
        }

        if (kcInitialized) return;
        kcInitialized = true;

        const kc = getKeycloak();

        kc.init({
            onLoad: 'login-required',
            checkLoginIframe: false,
            pkceMethod: 'S256',
        })
            .then(async (auth) => {
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
                    
                    // PF007: Load full authorization context
                    if (kc.token) {
                        await fetchAuthzContext(kc.token);
                    }

                    setInterval(() => {
                        kc.updateToken(60).catch(() => {
                            console.warn('[Auth] Token refresh failed, redirecting to login');
                            kc.login();
                        });
                    }, 30000);

                    kc.onTokenExpired = () => {
                        kc.updateToken(60).then(() => {
                            setToken(kc.token || null);
                            if (kc.token) fetchAuthzContext(kc.token);
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

    if (loading) {
        return (
            <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                height: '100vh', background: '#0a0a0a', color: '#888',
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
        <AuthContext.Provider value={{ 
            authenticated, user, token, loading, 
            platformRole, company, membership, permissions, scopes,
            hasRole, logout, accessDeniedMessage, clearAccessDenied 
        }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth(): AuthContextType {
    return useContext(AuthContext);
}

export function getAuthHeaders(): Record<string, string> {
    const kc = FEATURE_AUTH ? getKeycloak() : null;
    if (kc?.token) {
        return { Authorization: `Bearer ${kc.token}` };
    }
    return {};
}

export function getAuthToken(): string | null {
    const kc = FEATURE_AUTH ? getKeycloak() : null;
    return kc?.token || null;
}
