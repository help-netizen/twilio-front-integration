/**
 * Authenticated fetch wrapper.
 * Injects Keycloak Bearer token into all requests when VITE_FEATURE_AUTH is enabled.
 */

import { getAuthHeaders, getKeycloak } from '../auth/AuthProvider';
import {
    isNativeWebViewAuthMode,
    requestNativeWebViewTokenRefresh,
    signalNativeWebViewSessionExpired,
} from '../auth/nativeWebViewBridge';
import { requireTwoFactor } from './twoFactorGate';

const FEATURE_AUTH = import.meta.env.VITE_FEATURE_AUTH_ENABLED === 'true';

function rawFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const authHeaders = getAuthHeaders();
    const existingHeaders = init?.headers as Record<string, string> | undefined;
    return fetch(input, {
        // Send the trusted-device cookie (albusto_td) on every authed request so a
        // retried call after the 2FA gate actually carries it. Without this the
        // retry 401s again → gate re-opens → SMS loop. `credentials` is still
        // overridable per-call via init for the rare caller that needs to opt out.
        credentials: 'include',
        ...init,
        headers: {
            ...authHeaders,
            ...existingHeaders,
        },
    });
}

function dispatchSessionExpired(): void {
    window.dispatchEvent(new CustomEvent('auth:session-expired'));
}

async function readUnauthorizedCode(res: Response): Promise<string | undefined> {
    try { return (await res.clone().json())?.code; } catch { return undefined; }
}

async function retryAfterTwoFactor(
    input: RequestInfo | URL,
    init?: RequestInit
): Promise<Response> {
    await requireTwoFactor();
    const retried = await rawFetch(input, init);
    if (retried.status === 401
        && await readUnauthorizedCode(retried) !== 'PHONE_VERIFICATION_REQUIRED') {
        dispatchSessionExpired();
    }
    return retried;
}

/**
 * Wrapper around fetch() that auto-injects Authorization header.
 * Drop-in replacement for window.fetch — same signature.
 *
 * AUTH-2FA-GATE: when the backend answers 401 `PHONE_VERIFICATION_REQUIRED`
 * (trusted-device cookie expired / new device, FEATURE_SMS_2FA on), surface the
 * global 2FA gate, wait for the device to be re-trusted, then retry the request
 * once — so callers never see the raw 401 and the user isn't locked out.
 */
export async function authedFetch(
    input: RequestInfo | URL,
    init?: RequestInit
): Promise<Response> {
    let res = await rawFetch(input, init);
    if (res.status === 401 && FEATURE_AUTH && isNativeWebViewAuthMode()) {
        try {
            await requestNativeWebViewTokenRefresh();
            res = await rawFetch(input, init);
        } catch { /* native refresh failed → session expired below */ }
        if (res.status === 401) signalNativeWebViewSessionExpired();
        return res;
    }
    if (res.status === 401) {
        const code = await readUnauthorizedCode(res);
        if (code === 'PHONE_VERIFICATION_REQUIRED') {
            return retryAfterTwoFactor(input, init);
        }
        // A generic 401 on a cold page load is usually a token race / near-expiry,
        // not a dead session. Force-refresh the token and retry once before
        // surfacing the failure to the caller.
        if (FEATURE_AUTH) {
            try {
                await getKeycloak().updateToken(-1); // force refresh
                res = await rawFetch(input, init);   // retry once with the fresh token
            } catch {
                dispatchSessionExpired();            // refresh failed → genuine session end
                return res;
            }

            if (res.status === 401) {
                // Preserve the device-verification ordering even if the token
                // refresh changes the backend's first applicable auth gate.
                if (await readUnauthorizedCode(res) === 'PHONE_VERIFICATION_REQUIRED') {
                    return retryAfterTwoFactor(input, init);
                }
                dispatchSessionExpired();            // refreshed token was still rejected
            }
        } else {
            dispatchSessionExpired();
        }
    }
    return res;
}
