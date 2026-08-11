/**
 * BUG-22 regression (MANDATORY) — 2FA gate handling in BOTH http clients.
 *
 * The app has TWO http clients: fetch-based `authedFetch` (apiClient.ts) and
 * the axios client (api.ts, used by Pulse). A 401 `PHONE_VERIFICATION_REQUIRED`
 * means "device untrusted", NOT "session dead". Historically only authedFetch
 * knew that; the axios client dispatched `auth:session-expired` → kc.login() →
 * live SSO bounced straight back → infinite reload loop + an otp/send per cycle
 * (prod incident 2026-07-13, account a5085140320@).
 *
 * These tests pin the contract for BOTH clients:
 *   1. 401 PHONE_VERIFICATION_REQUIRED → requireTwoFactor() + ONE retry,
 *      and NEVER an `auth:session-expired` dispatch.
 *   2. A generic 401 ends in exactly one `auth:session-expired` dispatch.
 *
 * Any future auth-flow change MUST keep both clients in lockstep (memory:
 * bug22-axios-2fa-loop).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── shared mocks ─────────────────────────────────────────────────────────────

const requireTwoFactor = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
vi.mock('./twoFactorGate', () => ({ requireTwoFactor }));

const updateToken = vi.fn().mockRejectedValue(new Error('refresh failed'));
let authHeaderToken = 'test-token';
vi.mock('../auth/AuthProvider', () => ({
    getAuthHeaders: () => ({ Authorization: `Bearer ${authHeaderToken}` }),
    getKeycloak: () => ({ updateToken }),
}));

const isNativeWebViewAuthMode = vi.fn(() => false);
const requestNativeWebViewTokenRefresh = vi.fn<() => Promise<string>>()
    .mockResolvedValue('fresh-native-token');
const signalNativeWebViewSessionExpired = vi.fn();
vi.mock('../auth/nativeWebViewBridge', () => ({
    isNativeWebViewAuthMode,
    requestNativeWebViewTokenRefresh,
    signalNativeWebViewSessionExpired,
}));

// Minimal window stand-in (node environment): only what api.ts touches.
const dispatchEvent = vi.fn();
(globalThis as any).window = { dispatchEvent };

function tfa401Body() {
    return { code: 'PHONE_VERIFICATION_REQUIRED', message: 'Confirm this device with the SMS code' };
}

beforeEach(() => {
    vi.stubEnv('VITE_FEATURE_AUTH_ENABLED', 'true');
    authHeaderToken = 'test-token';
    isNativeWebViewAuthMode.mockReturnValue(false);
    requestNativeWebViewTokenRefresh.mockImplementation(async () => {
        authHeaderToken = 'fresh-native-token';
        return authHeaderToken;
    });
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    requireTwoFactor.mockClear();
    updateToken.mockClear();
    isNativeWebViewAuthMode.mockClear();
    requestNativeWebViewTokenRefresh.mockClear();
    signalNativeWebViewSessionExpired.mockClear();
    dispatchEvent.mockClear();
});

// ── axios client (services/api.ts) — the BUG-22 hole ────────────────────────

describe('axios client: 401 PHONE_VERIFICATION_REQUIRED', () => {
    it('routes to the 2FA gate, retries once, never dispatches session-expired', async () => {
        const api = await import('./api');
        const client = (api as any).apiClient ?? (api as any).default;
        expect(client, 'api.ts must export the axios client').toBeTruthy();

        let calls = 0;
        client.defaults.adapter = async (config: any) => {
            calls += 1;
            if (calls === 1) {
                const error: any = new Error('Request failed with status code 401');
                error.config = config;
                error.response = { status: 401, data: tfa401Body(), config };
                error.isAxiosError = true;
                throw error;
            }
            return { status: 200, statusText: 'OK', data: { ok: true }, headers: {}, config };
        };

        const res = await client.get('/calls');

        expect(res.status).toBe(200);
        expect(calls).toBe(2);                                   // original + exactly one retry
        expect(requireTwoFactor).toHaveBeenCalledTimes(1);       // gate surfaced
        expect(updateToken).not.toHaveBeenCalled();              // no pointless token refresh
        const dispatched = dispatchEvent.mock.calls.map(([e]) => (e as CustomEvent).type);
        expect(dispatched).not.toContain('auth:session-expired'); // the loop trigger
    });

    it('generic 401 (dead session) still dispatches auth:session-expired after refresh fails', async () => {
        const api = await import('./api');
        const client = (api as any).apiClient ?? (api as any).default;

        client.defaults.adapter = async (config: any) => {
            const error: any = new Error('Request failed with status code 401');
            error.config = config;
            error.response = { status: 401, data: { code: 'UNAUTHENTICATED' }, config };
            error.isAxiosError = true;
            throw error;
        };

        await expect(client.get('/calls')).rejects.toBeTruthy();
        const dispatched = dispatchEvent.mock.calls.map(([e]) => (e as CustomEvent).type);
        expect(dispatched.filter(type => type === 'auth:session-expired')).toHaveLength(1);
        expect(requireTwoFactor).not.toHaveBeenCalled();
    });

    it('dispatches session-expired once when a refreshed token is also rejected', async () => {
        updateToken.mockResolvedValueOnce(true);
        const api = await import('./api');
        const client = (api as any).apiClient ?? (api as any).default;
        let calls = 0;

        client.defaults.adapter = async (config: any) => {
            calls += 1;
            const error: any = new Error('Request failed with status code 401');
            error.config = config;
            error.response = { status: 401, data: { code: 'SESSION_REVOKED' }, config };
            error.isAxiosError = true;
            throw error;
        };

        await expect(client.get('/calls')).rejects.toBeTruthy();

        const dispatched = dispatchEvent.mock.calls.map(([e]) => (e as CustomEvent).type);
        expect(calls).toBe(2);
        expect(updateToken).toHaveBeenCalledTimes(1);
        expect(dispatched.filter(type => type === 'auth:session-expired')).toHaveLength(1);
        expect(requireTwoFactor).not.toHaveBeenCalled();
    });
});

describe('axios client: native WebView 401 refresh', () => {
    it('asks native once and retries once without Keycloak or the browser 2FA gate', async () => {
        isNativeWebViewAuthMode.mockReturnValue(true);
        const api = await import('./api');
        const client = (api as any).apiClient ?? (api as any).default;

        let calls = 0;
        client.defaults.adapter = async (config: any) => {
            calls += 1;
            if (calls === 1) {
                const error: any = new Error('Request failed with status code 401');
                error.config = config;
                error.response = { status: 401, data: tfa401Body(), config };
                error.isAxiosError = true;
                throw error;
            }
            expect(config.headers.Authorization).toBe('Bearer fresh-native-token');
            return { status: 200, statusText: 'OK', data: { ok: true }, headers: {}, config };
        };

        const response = await client.get('/tasks');

        expect(response.status).toBe(200);
        expect(calls).toBe(2);
        expect(requestNativeWebViewTokenRefresh).toHaveBeenCalledTimes(1);
        expect(updateToken).not.toHaveBeenCalled();
        expect(requireTwoFactor).not.toHaveBeenCalled();
        expect(signalNativeWebViewSessionExpired).not.toHaveBeenCalled();
    });

    it('signals native after the single retry is also unauthorized', async () => {
        isNativeWebViewAuthMode.mockReturnValue(true);
        const api = await import('./api');
        const client = (api as any).apiClient ?? (api as any).default;

        client.defaults.adapter = async (config: any) => {
            const error: any = new Error('Request failed with status code 401');
            error.config = config;
            error.response = { status: 401, data: { code: 'UNAUTHENTICATED' }, config };
            error.isAxiosError = true;
            throw error;
        };

        await expect(client.get('/tasks')).rejects.toBeTruthy();
        expect(requestNativeWebViewTokenRefresh).toHaveBeenCalledTimes(1);
        expect(signalNativeWebViewSessionExpired).toHaveBeenCalledTimes(1);
        expect(updateToken).not.toHaveBeenCalled();
        expect(dispatchEvent).not.toHaveBeenCalled();
    });
});

// ── fetch client (services/apiClient.ts) — must stay in lockstep ────────────

describe('authedFetch: 401 PHONE_VERIFICATION_REQUIRED', () => {
    it('routes to the 2FA gate and retries once', async () => {
        const { authedFetch } = await import('./apiClient');

        let calls = 0;
        const fetchMock = vi.fn(async () => {
            calls += 1;
            if (calls === 1) {
                return new Response(JSON.stringify(tfa401Body()), { status: 401 });
            }
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
        });
        vi.stubGlobal('fetch', fetchMock);

        const res = await authedFetch('/api/calls');

        expect(res.status).toBe(200);
        expect(calls).toBe(2);
        expect(requireTwoFactor).toHaveBeenCalledTimes(1);
        const dispatched = dispatchEvent.mock.calls.map(([e]) => (e as CustomEvent).type);
        expect(dispatched).not.toContain('auth:session-expired');
    });
});

describe('authedFetch: generic 401', () => {
    it('dispatches session-expired once when token refresh fails', async () => {
        const { authedFetch } = await import('./apiClient');
        const fetchMock = vi.fn(async () => (
            new Response(JSON.stringify({ code: 'SESSION_REVOKED' }), { status: 401 })
        ));
        vi.stubGlobal('fetch', fetchMock);

        const response = await authedFetch('/api/calls');

        const dispatched = dispatchEvent.mock.calls.map(([e]) => (e as CustomEvent).type);
        expect(response.status).toBe(401);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(updateToken).toHaveBeenCalledTimes(1);
        expect(dispatched.filter(type => type === 'auth:session-expired')).toHaveLength(1);
        expect(requireTwoFactor).not.toHaveBeenCalled();
    });

    it('dispatches session-expired once when a refreshed token is also rejected', async () => {
        updateToken.mockResolvedValueOnce(true);
        const { authedFetch } = await import('./apiClient');
        const fetchMock = vi.fn(async () => (
            new Response(JSON.stringify({ code: 'SESSION_REVOKED' }), { status: 401 })
        ));
        vi.stubGlobal('fetch', fetchMock);

        const response = await authedFetch('/api/calls');

        const dispatched = dispatchEvent.mock.calls.map(([e]) => (e as CustomEvent).type);
        expect(response.status).toBe(401);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(updateToken).toHaveBeenCalledTimes(1);
        expect(dispatched.filter(type => type === 'auth:session-expired')).toHaveLength(1);
        expect(requireTwoFactor).not.toHaveBeenCalled();
    });
});

describe('authedFetch: native WebView 401 refresh', () => {
    it('asks native once and retries once without Keycloak or the browser 2FA gate', async () => {
        isNativeWebViewAuthMode.mockReturnValue(true);
        const { authedFetch } = await import('./apiClient');

        let calls = 0;
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            calls += 1;
            if (calls === 1) {
                return new Response(JSON.stringify(tfa401Body()), { status: 401 });
            }
            expect((init?.headers as Record<string, string>).Authorization)
                .toBe('Bearer fresh-native-token');
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
        });
        vi.stubGlobal('fetch', fetchMock);

        const response = await authedFetch('/api/tasks');

        expect(response.status).toBe(200);
        expect(calls).toBe(2);
        expect(requestNativeWebViewTokenRefresh).toHaveBeenCalledTimes(1);
        expect(updateToken).not.toHaveBeenCalled();
        expect(requireTwoFactor).not.toHaveBeenCalled();
        expect(signalNativeWebViewSessionExpired).not.toHaveBeenCalled();
    });

    it('signals native after the single retry is also unauthorized', async () => {
        isNativeWebViewAuthMode.mockReturnValue(true);
        const { authedFetch } = await import('./apiClient');

        const fetchMock = vi.fn(async () => (
            new Response(JSON.stringify({ code: 'UNAUTHENTICATED' }), { status: 401 })
        ));
        vi.stubGlobal('fetch', fetchMock);

        const response = await authedFetch('/api/tasks');

        expect(response.status).toBe(401);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(requestNativeWebViewTokenRefresh).toHaveBeenCalledTimes(1);
        expect(signalNativeWebViewSessionExpired).toHaveBeenCalledTimes(1);
        expect(updateToken).not.toHaveBeenCalled();
    });
});
