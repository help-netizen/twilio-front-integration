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

/**
 * CARDFRAME-HANDOFF-002 — the hand-off must survive a change of BROWSING CONTEXT.
 *
 * It originally lived in sessionStorage only, which is scoped to one tab: it works for
 * the same-window navigation and for nothing else. But this flow deliberately spans
 * contexts — an installed PWA opens the card page as a separate document, a blocked
 * pop-up falls back to the same window, an opened pop-up is a second context — and in
 * every one of those the receiving document read an empty sessionStorage. That is both
 * reported symptoms: the card details "not saving" (the RESULT was lost on the way back)
 * and now "payment session expired" (the INIT was lost on the way there).
 *
 * localStorage is shared across every context of the origin, so it carries the hand-off
 * whichever way the browser decides to open the page. It is written alongside
 * sessionStorage and read as the fallback; entries are deleted the moment they are read
 * and expire on their own, so nothing lingers. Secrets stay out of the URL either way.
 */
type HandoffStores = { sessionStorage?: Storage | null; localStorage?: Storage | null };

function eachStore(host: HandoffStores): Storage[] {
    const stores: Storage[] = [];
    // sessionStorage first: same-tab is the common path and the shortest-lived store.
    for (const store of [host.sessionStorage, host.localStorage]) {
        if (store) stores.push(store);
    }
    return stores;
}

function writeToStores(host: HandoffStores, key: string, value: string): void {
    for (const store of eachStore(host)) {
        try {
            store.setItem(key, value);
        } catch {
            /* private mode / quota — the other store may still take it */
        }
    }
}

function takeFromStores(host: HandoffStores, key: string): string | null {
    let found: string | null = null;
    for (const store of eachStore(host)) {
        try {
            found = found ?? store.getItem(key);
            store.removeItem(key);
        } catch {
            /* unreadable store — try the next one */
        }
    }
    return found;
}

/** Drop hand-offs the receiving page never picked up, so localStorage can't accumulate. */
function pruneExpired(host: HandoffStores, now: number): void {
    const store = host.localStorage;
    if (!store) return;
    try {
        const stale: string[] = [];
        for (let i = 0; i < store.length; i++) {
            const key = store.key(i);
            if (!key || !key.startsWith('cardframe:')) continue;
            try {
                const parsed: unknown = JSON.parse(store.getItem(key) || 'null');
                if (!isRecord(parsed) || typeof parsed.expiresAt !== 'number' || parsed.expiresAt < now) {
                    stale.push(key);
                }
            } catch {
                stale.push(key);
            }
        }
        stale.forEach(key => store.removeItem(key));
    } catch {
        /* best effort */
    }
}

export function beginCardEntrySameWindow(
    host: {
        location: Pick<SameWindowLocation, 'origin' | 'pathname' | 'search' | 'hash' | 'assign'>;
        sessionStorage?: Storage | null;
        localStorage?: Storage | null;
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
    pruneExpired(host, now);
    writeToStores(host, key, JSON.stringify(stored));
    const params = new URLSearchParams({ handoff: key, return_to: returnTo });
    host.location.assign(`/card-entry.html?${params.toString()}`);
}

/** Why a requested hand-off could not be restored — surfaced so a failure is diagnosable. */
export type CardEntryHandoffFailure = 'bad-key' | 'not-found' | 'expired' | 'bad-payload';

export function consumeCardEntryHandoff(
    host: {
        location: Pick<SameWindowLocation, 'origin' | 'search'>;
        sessionStorage?: Storage | null;
        localStorage?: Storage | null;
    },
    now = Date.now(),
): {
    handoff: CardEntryHandoff | null;
    returnTo: string;
    requested: boolean;
    failure?: CardEntryHandoffFailure;
} {
    const params = new URLSearchParams(host.location.search);
    const key = params.get('handoff');
    const returnTo = safeReturnTo(params.get('return_to'), host.location.origin);
    if (!key) return { handoff: null, returnTo, requested: false };
    if (!key.startsWith('cardframe:')) {
        return { handoff: null, returnTo, requested: true, failure: 'bad-key' };
    }

    const raw = takeFromStores(host, key);
    if (!raw) return { handoff: null, returnTo, requested: true, failure: 'not-found' };

    try {
        const stored: unknown = JSON.parse(raw);
        if (
            !isRecord(stored)
            || stored.version !== 1
            || typeof stored.expiresAt !== 'number'
            || !isPositiveInteger(stored.sessionId)
            || !isCardframeInitMessage(stored.initMessage)
        ) {
            return { handoff: null, returnTo, requested: true, failure: 'bad-payload' };
        }
        if (stored.expiresAt < now) {
            return { handoff: null, returnTo, requested: true, failure: 'expired' };
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
        return { handoff: null, returnTo, requested: true, failure: 'bad-payload' };
    }
}

export function completeCardEntrySameWindow(
    host: {
        location: Pick<SameWindowLocation, 'origin' | 'replace'>;
        sessionStorage?: Storage | null;
        localStorage?: Storage | null;
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
    writeToStores(host, key, JSON.stringify(stored));
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
        sessionStorage?: Storage | null;
        localStorage?: Storage | null;
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
    const raw = takeFromStores(host, key);
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
