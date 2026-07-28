import { afterEach, describe, expect, it, vi } from 'vitest';

const TOKEN_A = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLWEifQ.signature-a';
const TOKEN_B = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLWIifQ.signature-b';
const NONCE = 'native_nonce_0123456789abcdef';

function installWindow(options: { origin?: string; markerOrigin?: string; framed?: boolean } = {}) {
    const origin = options.origin ?? 'https://app.albusto.test';
    const messageListeners = new Set<(event: MessageEvent) => void>();
    const posted: string[] = [];
    const fakeWindow: any = {
        location: { origin },
        ReactNativeWebView: {
            postMessage: vi.fn((message: string) => posted.push(message)),
        },
        addEventListener: vi.fn((type: string, listener: (event: MessageEvent) => void) => {
            if (type === 'message') messageListeners.add(listener);
        }),
        removeEventListener: vi.fn(),
        __ALBUSTO_NATIVE_WEBVIEW_V1__: {
            version: 1,
            origin: options.markerOrigin ?? origin,
            nonce: NONCE,
            accessToken: TOKEN_A,
        },
    };
    fakeWindow.self = fakeWindow;
    fakeWindow.top = options.framed ? {} : fakeWindow;
    vi.stubGlobal('window', fakeWindow);

    return {
        fakeWindow,
        posted,
        dispatchMessage(data: unknown, eventOrigin = '') {
            messageListeners.forEach(listener => listener({ data, origin: eventOrigin } as MessageEvent));
        },
    };
}

afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
});

describe('nativeWebViewBridge', () => {
    it('activates only for a same-origin main-frame marker and consumes the bootstrap token', async () => {
        const { fakeWindow } = installWindow();
        const bridge = await import('./nativeWebViewBridge');

        expect(bridge.isNativeWebViewAuthMode()).toBe(true);
        expect(bridge.getNativeWebViewAccessToken()).toBe(TOKEN_A);
        expect(fakeWindow.__ALBUSTO_NATIVE_WEBVIEW_V1__.accessToken).toBeUndefined();

        const auth = await import('./AuthProvider');
        expect(auth.getAuthToken()).toBe(TOKEN_A);
        expect(auth.getAuthHeaders()).toEqual({ Authorization: `Bearer ${TOKEN_A}` });
    });

    it.each([
        { markerOrigin: 'https://evil.example', framed: false },
        { markerOrigin: 'https://app.albusto.test', framed: true },
    ])('rejects an origin-mismatched or framed marker', async ({ markerOrigin, framed }) => {
        installWindow({ markerOrigin, framed });
        const bridge = await import('./nativeWebViewBridge');

        expect(bridge.isNativeWebViewAuthMode()).toBe(false);
        expect(bridge.getNativeWebViewAccessToken()).toBeNull();
    });

    it('coalesces refresh callers and accepts only the matching nonce/requestId update', async () => {
        const { posted, dispatchMessage } = installWindow();
        const bridge = await import('./nativeWebViewBridge');

        const first = bridge.requestNativeWebViewTokenRefresh();
        const second = bridge.requestNativeWebViewTokenRefresh();
        expect(second).toBe(first);
        expect(posted).toHaveLength(1);

        const request = JSON.parse(posted[0]);
        expect(request).toMatchObject({
            version: 1,
            nonce: NONCE,
            type: 'AUTH_REFRESH_REQUEST',
        });

        dispatchMessage(JSON.stringify({
            version: 1,
            nonce: 'wrong_nonce_0123456789abcdef',
            requestId: request.requestId,
            type: 'AUTH_UPDATE',
            accessToken: TOKEN_B,
        }));
        expect(bridge.getNativeWebViewAccessToken()).toBe(TOKEN_A);

        dispatchMessage(JSON.stringify({
            version: 1,
            nonce: NONCE,
            requestId: request.requestId,
            type: 'AUTH_UPDATE',
            accessToken: TOKEN_B,
        }), 'https://evil.example');
        expect(bridge.getNativeWebViewAccessToken()).toBe(TOKEN_A);

        dispatchMessage(JSON.stringify({
            version: 1,
            nonce: NONCE,
            requestId: request.requestId,
            type: 'AUTH_UPDATE',
            accessToken: TOKEN_B,
        }));

        await expect(first).resolves.toBe(TOKEN_B);
        await expect(second).resolves.toBe(TOKEN_B);
        expect(bridge.getNativeWebViewAccessToken()).toBe(TOKEN_B);
    });

    it('clears the in-memory token and emits a versioned session-expired envelope', async () => {
        const { posted } = installWindow();
        const bridge = await import('./nativeWebViewBridge');

        bridge.signalNativeWebViewSessionExpired();

        expect(bridge.getNativeWebViewAccessToken()).toBeNull();
        expect(JSON.parse(posted[0])).toMatchObject({
            version: 1,
            nonce: NONCE,
            type: 'AUTH_SESSION_EXPIRED',
        });
    });
});
