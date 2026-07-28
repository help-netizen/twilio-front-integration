import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/AuthProvider', () => ({
    getAuthToken: () => 'must-not-enter-an-sse-url',
}));

const isNativeWebViewAuthMode = vi.fn(() => true);
vi.mock('../auth/nativeWebViewBridge', () => ({
    isNativeWebViewAuthMode,
}));

afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    isNativeWebViewAuthMode.mockClear();
});

describe('sseManager native WebView spike gate', () => {
    it('does not construct an EventSource while the native marker is active', async () => {
        const eventSource = vi.fn();
        vi.stubGlobal('EventSource', eventSource);
        const manager = await import('./sseManager');

        const subscriptionId = manager.subscribe('task.changed', vi.fn());

        expect(eventSource).not.toHaveBeenCalled();
        expect(manager.isConnected()).toBe(false);
        manager.unsubscribe(subscriptionId);
    });
});
