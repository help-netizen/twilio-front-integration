/**
 * Authenticated fetch wrapper.
 * Injects Keycloak Bearer token into all requests when VITE_FEATURE_AUTH is enabled.
 */

import { getAuthHeaders, getKeycloak } from '../auth/AuthProvider';
import { requireTwoFactor } from './twoFactorGate';

const FEATURE_AUTH = import.meta.env.VITE_FEATURE_AUTH_ENABLED === 'true';

function rawFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const authHeaders = getAuthHeaders();
    const existingHeaders = init?.headers as Record<string, string> | undefined;
    return fetch(input, {
        ...init,
        headers: {
            ...authHeaders,
            ...existingHeaders,
        },
    });
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
    if (res.status === 401) {
        let code: string | undefined;
        try { code = (await res.clone().json())?.code; } catch { /* non-JSON 401 */ }
        if (code === 'PHONE_VERIFICATION_REQUIRED') {
            await requireTwoFactor();        // resolves once the device is trusted
            return rawFetch(input, init);    // retry once with the new cookie
        }
        // A generic 401 on a cold page load is usually a token race / near-expiry,
        // not a dead session. Force-refresh the token and retry once before
        // surfacing the failure to the caller.
        if (FEATURE_AUTH) {
            try {
                await getKeycloak().updateToken(-1); // force refresh
                res = await rawFetch(input, init);   // retry once with the fresh token
            } catch { /* refresh failed → genuine session end, return the 401 */ }
        }
    }
    return res;
}
