/**
 * BUG-22b regression (MANDATORY) — login-redirect loop breaker.
 *
 * A failed kc.init with a live SSO session used to redirect→bounce→redirect
 * forever (infinite reload + one otp/send per cycle). The breaker allows at
 * most LOGIN_REDIRECTS_MAX forced re-logins per window, cross-reload via
 * sessionStorage; then the app must show the fatal screen instead of looping.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
    loginRedirectAllowed, clearLoginRedirects,
    LOGIN_REDIRECTS_KEY, LOGIN_REDIRECTS_MAX, LOGIN_REDIRECTS_WINDOW_MS,
} from './loginLoopBreaker';

// node env: minimal sessionStorage stand-in (persists across "reloads" within a test)
const store = new Map<string, string>();
(globalThis as any).sessionStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
};

beforeEach(() => store.clear());

describe('loginRedirectAllowed', () => {
    it(`allows exactly ${LOGIN_REDIRECTS_MAX} redirects per window, then halts the loop`, () => {
        const t = 1_000_000;
        expect(loginRedirectAllowed(t)).toBe(true);          // redirect #1 (reload happens)
        expect(loginRedirectAllowed(t + 500)).toBe(true);    // redirect #2 (reload happens)
        expect(loginRedirectAllowed(t + 1000)).toBe(false);  // LOOP DETECTED — must halt
        expect(loginRedirectAllowed(t + 2000)).toBe(false);  // stays halted inside the window
    });

    it('window expiry re-allows a redirect (user can retry later)', () => {
        const t = 1_000_000;
        loginRedirectAllowed(t);
        loginRedirectAllowed(t + 1);
        expect(loginRedirectAllowed(t + 2)).toBe(false);
        expect(loginRedirectAllowed(t + LOGIN_REDIRECTS_WINDOW_MS + 10)).toBe(true);
    });

    it('clearLoginRedirects (successful init) resets the ledger', () => {
        const t = 1_000_000;
        loginRedirectAllowed(t);
        loginRedirectAllowed(t + 1);
        clearLoginRedirects();
        expect(loginRedirectAllowed(t + 2)).toBe(true);
    });

    it('corrupt ledger data fails open (never locks the user out)', () => {
        store.set(LOGIN_REDIRECTS_KEY, '{not json');
        expect(loginRedirectAllowed()).toBe(true);
    });
});
