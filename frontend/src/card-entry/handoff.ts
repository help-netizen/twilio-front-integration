import {
    isCardframeCompletionMessage,
    isCardframeInitMessage,
    type CardframeCompletionMessage,
    type CardframeInitMessage,
} from './protocol';

const HANDOFF_TTL_MS = 10 * 60 * 1000;
const RESULT_TTL_MS = 30 * 60 * 1000;

interface StoredCardEntryHandoff {
    version: 1;
    expiresAt: number;
    sessionId: number;
    initMessage: CardframeInitMessage;
    resumeContext?: unknown;
}

export interface CardEntryHandoff {
    sessionId: number;
    initMessage: CardframeInitMessage;
    returnTo: string;
    resumeContext?: unknown;
}

interface StoredCardEntryResult {
    version: 1;
    expiresAt: number;
    sessionId: number;
    completion: CardframeCompletionMessage;
    resumeContext?: unknown;
}

export interface CardEntrySameWindowResult {
    sessionId: number;
    completion: CardframeCompletionMessage;
    resumeContext?: unknown;
}

interface SameWindowLocation {
    origin: string;
    pathname: string;
    search: string;
    hash: string;
    assign: (url: string) => void;
    replace: (url: string) => void;
}

interface SameWindowHistory {
    replaceState: (data: unknown, unused: string, url?: string | URL | null) => void;
}

interface RandomSource {
    randomUUID: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function safeReturnTo(value: string | null, origin: string): string {
    if (!value) return '/';
    try {
        const url = new URL(value, origin);
        if (url.origin !== origin || !url.pathname.startsWith('/')) return '/';
        return `${url.pathname}${url.search}${url.hash}`;
    } catch {
        return '/';
    }
}

function currentReturnTo(
    location: Pick<SameWindowLocation, 'pathname' | 'search' | 'hash'>,
): string {
    const params = new URLSearchParams(location.search);
    params.delete('cardResult');
    const search = params.toString();
    return `${location.pathname}${search ? `?${search}` : ''}${location.hash}`;
}

function withQueryParam(path: string, name: string, value: string, origin: string): string {
    const url = new URL(path, origin);
    url.searchParams.set(name, value);
    return `${url.pathname}${url.search}${url.hash}`;
}

function randomStorageKey(crypto: RandomSource): string {
    return `cardframe:${crypto.randomUUID()}`;
}

export function beginCardEntrySameWindow(
    host: {
        location: Pick<SameWindowLocation, 'origin' | 'pathname' | 'search' | 'hash' | 'assign'>;
        sessionStorage: Storage;
        crypto: RandomSource;
    },
    payload: {
        sessionId: number;
        initMessage: CardframeInitMessage;
        resumeContext?: unknown;
    },
    now = Date.now(),
): void {
    const key = randomStorageKey(host.crypto);
    const returnTo = currentReturnTo(host.location);
    const stored: StoredCardEntryHandoff = {
        version: 1,
        expiresAt: now + HANDOFF_TTL_MS,
        sessionId: payload.sessionId,
        initMessage: payload.initMessage,
        ...(payload.resumeContext === undefined ? {} : { resumeContext: payload.resumeContext }),
    };
    host.sessionStorage.setItem(key, JSON.stringify(stored));
    const params = new URLSearchParams({ handoff: key, return_to: returnTo });
    host.location.assign(`/card-entry.html?${params.toString()}`);
}

export function consumeCardEntryHandoff(
    host: {
        location: Pick<SameWindowLocation, 'origin' | 'search'>;
        sessionStorage: Storage;
    },
    now = Date.now(),
): { handoff: CardEntryHandoff | null; returnTo: string; requested: boolean } {
    const params = new URLSearchParams(host.location.search);
    const key = params.get('handoff');
    const returnTo = safeReturnTo(params.get('return_to'), host.location.origin);
    if (!key) return { handoff: null, returnTo, requested: false };
    if (!key.startsWith('cardframe:')) {
        return { handoff: null, returnTo, requested: true };
    }

    const raw = host.sessionStorage.getItem(key);
    host.sessionStorage.removeItem(key);
    if (!raw) return { handoff: null, returnTo, requested: true };

    try {
        const stored: unknown = JSON.parse(raw);
        if (
            !isRecord(stored)
            || stored.version !== 1
            || typeof stored.expiresAt !== 'number'
            || stored.expiresAt < now
            || !isPositiveInteger(stored.sessionId)
            || !isCardframeInitMessage(stored.initMessage)
        ) {
            return { handoff: null, returnTo, requested: true };
        }
        return {
            handoff: {
                sessionId: stored.sessionId,
                initMessage: stored.initMessage,
                returnTo,
                ...(stored.resumeContext === undefined
                    ? {}
                    : { resumeContext: stored.resumeContext }),
            },
            returnTo,
            requested: true,
        };
    } catch {
        return { handoff: null, returnTo, requested: true };
    }
}

export function completeCardEntrySameWindow(
    host: {
        location: Pick<SameWindowLocation, 'origin' | 'replace'>;
        sessionStorage: Storage;
        crypto: RandomSource;
    },
    handoff: CardEntryHandoff,
    completion: CardframeCompletionMessage,
    now = Date.now(),
): void {
    const key = randomStorageKey(host.crypto);
    const stored: StoredCardEntryResult = {
        version: 1,
        expiresAt: now + RESULT_TTL_MS,
        sessionId: handoff.sessionId,
        completion,
        ...(handoff.resumeContext === undefined
            ? {}
            : { resumeContext: handoff.resumeContext }),
    };
    host.sessionStorage.setItem(key, JSON.stringify(stored));
    host.location.replace(withQueryParam(
        handoff.returnTo,
        'cardResult',
        key,
        host.location.origin,
    ));
}

export function consumeCardEntrySameWindowResult(
    host: {
        location: Pick<SameWindowLocation, 'pathname' | 'search' | 'hash'>;
        sessionStorage: Storage;
        history: SameWindowHistory;
    },
    now = Date.now(),
): CardEntrySameWindowResult | null {
    const params = new URLSearchParams(host.location.search);
    const key = params.get('cardResult');
    if (!key) return null;

    params.delete('cardResult');
    const search = params.toString();
    host.history.replaceState(
        null,
        '',
        `${host.location.pathname}${search ? `?${search}` : ''}${host.location.hash}`,
    );
    if (!key.startsWith('cardframe:')) return null;
    const raw = host.sessionStorage.getItem(key);
    host.sessionStorage.removeItem(key);
    if (!raw) return null;

    try {
        const stored: unknown = JSON.parse(raw);
        if (
            !isRecord(stored)
            || stored.version !== 1
            || typeof stored.expiresAt !== 'number'
            || stored.expiresAt < now
            || !isPositiveInteger(stored.sessionId)
            || !isCardframeCompletionMessage(stored.completion)
        ) {
            return null;
        }
        return {
            sessionId: stored.sessionId,
            completion: stored.completion,
            ...(stored.resumeContext === undefined
                ? {}
                : { resumeContext: stored.resumeContext }),
        };
    } catch {
        return null;
    }
}
