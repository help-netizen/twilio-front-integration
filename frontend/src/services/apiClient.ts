/**
 * Authenticated fetch wrapper.
 * Injects Keycloak Bearer token into all requests when VITE_FEATURE_AUTH is enabled.
 */

import { getAuthHeaders } from '../auth/AuthProvider';

/**
 * Wrapper around fetch() that auto-injects Authorization header.
 * Drop-in replacement for window.fetch — same signature.
 */
export async function authedFetch(
    input: RequestInfo | URL,
    init?: RequestInit
): Promise<Response> {
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
