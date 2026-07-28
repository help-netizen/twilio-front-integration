const BRIDGE_VERSION = 1 as const;
const REFRESH_TIMEOUT_MS = 15_000;
const MAX_TOKEN_LENGTH = 32_768;
const MAX_IDENTIFIER_LENGTH = 256;

interface NativeWebViewMarker {
    version: typeof BRIDGE_VERSION;
    origin: string;
    nonce: string;
    accessToken?: string;
}

interface AuthUpdateEnvelope {
    version: typeof BRIDGE_VERSION;
    nonce: string;
    requestId: string;
    type: 'AUTH_UPDATE';
    accessToken: string;
}

interface OutboundEnvelope {
    version: typeof BRIDGE_VERSION;
    nonce: string;
    requestId: string;
    type: 'AUTH_REFRESH_REQUEST' | 'AUTH_SESSION_EXPIRED';
}

declare global {
    interface Window {
        __ALBUSTO_NATIVE_WEBVIEW_V1__?: unknown;
        ReactNativeWebView?: {
            postMessage(message: string): void;
        };
    }
}

type TokenListener = (token: string | null) => void;

let bridgeNonce: string | null = null;
let accessToken: string | null = null;
let refreshInFlight: Promise<string> | null = null;
let pendingRefresh: {
    requestId: string;
    resolve: (token: string) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
} | null = null;
const tokenListeners = new Set<TokenListener>();

function isBoundedIdentifier(value: unknown): value is string {
    return typeof value === 'string'
        && value.length >= 16
        && value.length <= MAX_IDENTIFIER_LENGTH
        && /^[A-Za-z0-9_-]+$/.test(value);
}

function isJwtAccessToken(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= MAX_TOKEN_LENGTH
        && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

function readMarker(): NativeWebViewMarker | null {
    if (typeof window === 'undefined' || window.self !== window.top) return null;

    const marker = window.__ALBUSTO_NATIVE_WEBVIEW_V1__;
    if (!marker || typeof marker !== 'object') return null;

    const candidate = marker as Partial<NativeWebViewMarker>;
    if (candidate.version !== BRIDGE_VERSION
        || candidate.origin !== window.location.origin
        || !isBoundedIdentifier(candidate.nonce)) {
        return null;
    }

    return candidate as NativeWebViewMarker;
}

function createRequestId(): string {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function postToNative(envelope: OutboundEnvelope): boolean {
    if (!window.ReactNativeWebView?.postMessage) return false;
    window.ReactNativeWebView.postMessage(JSON.stringify(envelope));
    return true;
}

function publishToken(token: string | null) {
    accessToken = token;
    tokenListeners.forEach(listener => listener(token));
}

function handleNativeMessage(event: MessageEvent) {
    if (!bridgeNonce
        || typeof event.data !== 'string'
        || (event.origin && event.origin !== window.location.origin)) {
        return;
    }

    let envelope: Partial<AuthUpdateEnvelope>;
    try {
        envelope = JSON.parse(event.data) as Partial<AuthUpdateEnvelope>;
    } catch {
        return;
    }

    if (envelope.version !== BRIDGE_VERSION
        || envelope.type !== 'AUTH_UPDATE'
        || envelope.nonce !== bridgeNonce
        || !isBoundedIdentifier(envelope.requestId)
        || !isJwtAccessToken(envelope.accessToken)) {
        return;
    }

    publishToken(envelope.accessToken);
    if (pendingRefresh?.requestId === envelope.requestId) {
        const pending = pendingRefresh;
        pendingRefresh = null;
        refreshInFlight = null;
        clearTimeout(pending.timeout);
        pending.resolve(envelope.accessToken);
    }
}

const marker = readMarker();
if (marker) {
    bridgeNonce = marker.nonce;
    if (isJwtAccessToken(marker.accessToken)) accessToken = marker.accessToken;

    // Consume the bootstrap token so the bridge remains its only owner.
    window.__ALBUSTO_NATIVE_WEBVIEW_V1__ = {
        version: BRIDGE_VERSION,
        origin: marker.origin,
        nonce: marker.nonce,
    };
    window.addEventListener('message', handleNativeMessage);
}

export function isNativeWebViewAuthMode(): boolean {
    return bridgeNonce !== null;
}

export function getNativeWebViewAccessToken(): string | null {
    return accessToken;
}

export function subscribeNativeWebViewToken(listener: TokenListener): () => void {
    tokenListeners.add(listener);
    return () => tokenListeners.delete(listener);
}

export function requestNativeWebViewTokenRefresh(): Promise<string> {
    if (!bridgeNonce) return Promise.reject(new Error('Native WebView auth bridge is unavailable'));
    if (refreshInFlight) return refreshInFlight;

    const requestId = createRequestId();
    let resolveRefresh!: (token: string) => void;
    let rejectRefresh!: (error: Error) => void;
    const promise = new Promise<string>((resolve, reject) => {
        resolveRefresh = resolve;
        rejectRefresh = reject;
    });
    refreshInFlight = promise;

    const timeout = setTimeout(() => {
        pendingRefresh = null;
        refreshInFlight = null;
        rejectRefresh(new Error('Native WebView token refresh timed out'));
    }, REFRESH_TIMEOUT_MS);
    pendingRefresh = {
        requestId,
        resolve: resolveRefresh,
        reject: rejectRefresh,
        timeout,
    };

    if (!postToNative({
        version: BRIDGE_VERSION,
        nonce: bridgeNonce,
        requestId,
        type: 'AUTH_REFRESH_REQUEST',
    })) {
        clearTimeout(timeout);
        pendingRefresh = null;
        refreshInFlight = null;
        rejectRefresh(new Error('Native WebView message channel is unavailable'));
    }

    return promise;
}

export function signalNativeWebViewSessionExpired(): void {
    if (!bridgeNonce) return;

    if (pendingRefresh) {
        const pending = pendingRefresh;
        pendingRefresh = null;
        refreshInFlight = null;
        clearTimeout(pending.timeout);
        pending.reject(new Error('Native WebView session expired'));
    }
    publishToken(null);
    postToNative({
        version: BRIDGE_VERSION,
        nonce: bridgeNonce,
        requestId: createRequestId(),
        type: 'AUTH_SESSION_EXPIRED',
    });
}
