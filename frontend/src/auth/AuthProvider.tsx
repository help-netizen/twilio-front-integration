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
    /** Re-pull permissions/company/membership from /api/auth/me (e.g. right after onboarding). */
    refreshAuthz: () => Promise<void>;
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
    refreshAuthz: async () => { },
});

// ─── Feature flag ─────────────────────────────────────────────────────────────

const FEATURE_AUTH = import.meta.env.VITE_FEATURE_AUTH_ENABLED === 'true';
const KEYCLOAK_URL = import.meta.env.VITE_KEYCLOAK_URL || 'http://localhost:8080';
const KEYCLOAK_REALM = import.meta.env.VITE_KEYCLOAK_REALM || 'crm-prod';
const KEYCLOAK_CLIENT_ID = import.meta.env.VITE_KEYCLOAK_CLIENT_ID || 'crm-web';

const DEV_COMPANY = { id: '00000000-0000-0000-0000-000000000001', name: 'Boston Masters', slug: 'boston-masters', status: 'active', timezone: 'America/New_York' };
const DEV_MEMBERSHIP = { id: 'dev-membership', role_key: 'tenant_admin', role_name: 'Tenant Admin', is_primary: true, status: 'active' };
const DEV_PERMISSIONS = [
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
    'tasks.view', 'tasks.create', 'tasks.manage',
    'financial_data.view',
    'estimates.view', 'estimates.create', 'estimates.send',
    'invoices.view', 'invoices.create', 'invoices.send',
    'payments.view', 'payments.collect_online', 'payments.collect_offline', 'payments.refund',
    'reports.dashboard.view', 'reports.jobs.view', 'reports.leads.view',
    'reports.calls.view', 'reports.payments.view', 'reports.financial.view',
    'client_job_history.view',
    'provider.enabled', 'phone_calls.use', 'call_masking.use',
    'gps_tracking.view', 'gps_tracking.collect',
];
const DEV_SCOPES = { job_visibility: 'all', financial_scope: 'full', dashboard_scope: 'all_widgets', report_scope: 'all', job_close_scope: 'close_allowed' };

// ─── Keycloak instance (singleton) ───────────────────────────────────────────

let keycloakInstance: Keycloak | null = null;
let kcInitialized = false;

export function getKeycloak(): Keycloak {
    if (!keycloakInstance) {
        keycloakInstance = new Keycloak({
            url: KEYCLOAK_URL,
            realm: KEYCLOAK_REALM,
            clientId: KEYCLOAK_CLIENT_ID,
        });
    }
    return keycloakInstance;
}

// GOOGLE-SSO-FIX-001: the public /signup page skips the main kc.init() below
// (see the `publicPage` guard), so the shared instance has no adapter and no
// pkceMethod. Calling kc.login() directly therefore throws
// "Cannot read properties of undefined (reading 'login')", and even if it built
// a URL the crm-web client (PKCE-required) would reject a challenge-less
// request. This helper lazily initializes the instance WITHOUT an onLoad (no
// auto-redirect — it only wires the adapter + PKCE) and then starts the social
// login. keycloak-js persists the PKCE verifier in callback storage, so the
// return page's init (onLoad:'login-required', same pkceMethod) completes the
// code→token exchange.
let kcInitPromise: Promise<boolean> | null = null;
export function ensureKeycloakInitialized(): Promise<boolean> {
    const kc = getKeycloak();
    if (!kcInitPromise) {
        kcInitialized = true;
        kcInitPromise = kc.init({ pkceMethod: 'S256', checkLoginIframe: false });
    }
    return kcInitPromise;
}

export async function loginWithIdp(idpHint: string, redirectUri: string): Promise<void> {
    await ensureKeycloakInitialized();
    await getKeycloak().login({ idpHint, redirectUri });
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

// Paths that must render WITHOUT forcing a Keycloak login (ALB-101)
// /pay/:token is the customer-facing Stripe Pay-now page (F018) — opaque token is the credential.
// /e/:token is the customer-facing public Estimate view page (SEND-DOC-001) — same model.
const PUBLIC_AUTH_PATHS = ['/signup', '/pay', '/e'];
function isPublicAuthPath() {
    return PUBLIC_AUTH_PATHS.some(p => window.location.pathname.startsWith(p));
}

export function AuthProvider({ children }: { children: ReactNode }) {
    const publicPage = isPublicAuthPath();
    const [authenticated, setAuthenticated] = useState(!FEATURE_AUTH);
    const [user, setUser] = useState<AuthUser | null>(
        FEATURE_AUTH ? null : { sub: 'dev', email: 'dev@localhost', name: 'Dev User', roles: ['super_admin', 'company_admin'] }
    );
    const [token, setToken] = useState<string | null>(null);
    const [loading, setLoading] = useState(FEATURE_AUTH && !publicPage);
    const [accessDeniedMessage, setAccessDeniedMessage] = useState<string | null>(null);

    // PF007 Extended Profile state
    const [platformRole, setPlatformRole] = useState<string>('none');
    const [company, setCompany] = useState<any>(FEATURE_AUTH ? null : DEV_COMPANY);
    const [membership, setMembership] = useState<any>(FEATURE_AUTH ? null : DEV_MEMBERSHIP);
    const [permissions, setPermissions] = useState<string[]>(FEATURE_AUTH ? [] : DEV_PERMISSIONS);
    const [scopes, setScopes] = useState<Record<string, any>>(FEATURE_AUTH ? {} : DEV_SCOPES);

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

    // ONBOARD-FIX-001 (A): re-pull the authz context on demand (permissions,
    // company, membership) WITHOUT a full reload. Called right after onboarding so
    // the SPA reflects the freshly created company + tenant_admin membership —
    // otherwise the stale post-init context (no company) loops the onboarding gate
    // and 403s /pulse. The backend resolves from company_memberships, so the
    // current token is sufficient (no token refresh needed).
    const refreshAuthz = useCallback(async () => {
        if (!FEATURE_AUTH) return;
        const t = getKeycloak().token;
        if (t) await fetchAuthzContext(t);
    }, []);

    useEffect(() => {
        if (!FEATURE_AUTH) {
            // Dev mode mock context
            setPlatformRole('none');
            setCompany(DEV_COMPANY);
            setMembership(DEV_MEMBERSHIP);
            setPermissions(DEV_PERMISSIONS);
            setScopes(DEV_SCOPES);
            return;
        }

        if (publicPage) return; // signup wizard is public — no login redirect
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

    // Security fallback: kc.init('login-required') normally redirects an
    // unauthenticated visitor to Keycloak before this provider renders the app.
    // But if init instead RESOLVED without a session, or THREW (caught above and
    // set loading=false), we must not fall through to rendering {children} — the
    // AppLayout chrome would leak to a logged-out user. Force the login redirect.
    useEffect(() => {
        if (FEATURE_AUTH && !publicPage && !loading && !authenticated) {
            getKeycloak().login();
        }
    }, [loading, authenticated, publicPage]);

    // AUTH-SESSION-001: when a backgrounded (mobile) tab becomes visible again, the
    // 30s refresh interval was suspended and the access token may have expired —
    // refresh it immediately so the resumed tab never fires an API call with a stale
    // token. Best-effort: on failure the interval / onTokenExpired / apiClient 401
    // path still handle a genuinely dead session.
    useEffect(() => {
        if (!FEATURE_AUTH) return;
        const refreshOnResume = () => {
            if (document.visibilityState !== 'visible') return;
            const kc = getKeycloak();
            if (!kc?.authenticated) return;
            kc.updateToken(60)
                .then((refreshed) => { if (refreshed) setToken(kc.token || null); })
                .catch(() => { /* leave recovery to the interval / 401-refresh */ });
        };
        document.addEventListener('visibilitychange', refreshOnResume);
        window.addEventListener('focus', refreshOnResume);
        return () => {
            document.removeEventListener('visibilitychange', refreshOnResume);
            window.removeEventListener('focus', refreshOnResume);
        };
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
                height: '100vh', background: 'var(--blanc-bg, #efe9df)', color: 'var(--blanc-ink-2, #536070)',
                fontFamily: '"IBM Plex Sans", system-ui, sans-serif',
            }}>
                <div style={{ textAlign: 'center' }}>
                    <div className="animate-spin" style={{ width: 22, height: 22, border: '2px solid var(--blanc-line, rgba(117,106,89,0.25))', borderTopColor: 'var(--blanc-ink-2, #536070)', borderRadius: '50%', margin: '0 auto 12px' }} />
                    <div style={{ fontSize: 14 }}>Authenticating…</div>
                </div>
            </div>
        );
    }

    // Hard auth gate: with auth enabled, an unauthenticated visitor on a
    // protected page never renders the app shell. The effect above is redirecting
    // to Keycloak; show a blocker until the browser navigates away.
    if (FEATURE_AUTH && !publicPage && !authenticated) {
        return (
            <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                height: '100vh', background: 'var(--blanc-bg, #efe9df)', color: 'var(--blanc-ink-2, #536070)',
                fontFamily: '"IBM Plex Sans", system-ui, sans-serif',
            }}>
                <div style={{ textAlign: 'center' }}>
                    <div className="animate-spin" style={{ width: 22, height: 22, border: '2px solid var(--blanc-line, rgba(117,106,89,0.25))', borderTopColor: 'var(--blanc-ink-2, #536070)', borderRadius: '50%', margin: '0 auto 12px' }} />
                    <div style={{ fontSize: 14 }}>Redirecting to sign in…</div>
                </div>
            </div>
        );
    }

    return (
        <AuthContext.Provider value={{
            authenticated, user, token, loading, 
            platformRole, company, membership, permissions, scopes,
            hasRole, logout, accessDeniedMessage, clearAccessDenied, refreshAuthz
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
