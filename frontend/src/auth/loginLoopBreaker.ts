/**
 * BUG-22b: login-redirect loop breaker.
 *
 * Every auth-failure path used to answer with kc.login(). With a LIVE Keycloak
 * SSO session that redirect bounces straight back; if the underlying failure
 * repeats (e.g. the code→token exchange dying on iOS), the app reloads forever —
 * flashing the 2FA gate and firing an otp/send per cycle (prod incident
 * 2026-07-13, BUG-22). The guard is CROSS-RELOAD (sessionStorage survives the
 * bounce, per-tab): allow at most LOGIN_REDIRECTS_MAX forced re-login redirects
 * per LOGIN_REDIRECTS_WINDOW_MS, then the caller must surface a fatal error
 * screen instead of looping. A successful kc.init clears the ledger.
 */

export const LOGIN_REDIRECTS_KEY = 'albusto_login_redirects';
export const LOGIN_REDIRECTS_MAX = 2;
export const LOGIN_REDIRECTS_WINDOW_MS = 30_000;

export function loginRedirectAllowed(now: number = Date.now()): boolean {
    try {
        const raw = sessionStorage.getItem(LOGIN_REDIRECTS_KEY);
        const recent: number[] = (raw ? JSON.parse(raw) : [])
            .filter((t: number) => Number.isFinite(t) && now - t < LOGIN_REDIRECTS_WINDOW_MS);
        if (recent.length >= LOGIN_REDIRECTS_MAX) return false;
        recent.push(now);
        sessionStorage.setItem(LOGIN_REDIRECTS_KEY, JSON.stringify(recent));
        return true;
    } catch {
        return true; // storage unavailable → behave as before rather than lock the user out
    }
}

export function clearLoginRedirects(): void {
    try { sessionStorage.removeItem(LOGIN_REDIRECTS_KEY); } catch { /* ignore */ }
}
