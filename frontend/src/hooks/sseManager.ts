/**
 * Singleton SSE Manager
 *
 * Maintains ONE EventSource connection for the entire app.
 * All useRealtimeEvents() hooks subscribe to this shared instance
 * instead of creating their own connections.
 *
 * Fixes Bug #12: 9+ independent EventSource connections per tab
 * caused hundreds of Fetch/XHR requests when ERR_HTTP2_PROTOCOL_ERROR
 * triggered simultaneous reconnection loops.
 */

import { getAuthToken } from '../auth/AuthProvider';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SSEEventHandler = (data: any) => void;

interface Subscription {
    id: number;
    eventType: string;
    handler: SSEEventHandler;
}

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let eventSource: EventSource | null = null;
let reconnectTimeout: number | null = null;
let reconnectAttempts = 0;
let isManuallyDisconnected = false;
let subscriberCount = 0;
let nextSubscriptionId = 0;
const subscriptions: Subscription[] = [];
let connected = false;
const connectedListeners = new Set<(val: boolean) => void>();

// Backoff config
const BASE_DELAY = 2_000;      // 2s initial
const MAX_DELAY = 60_000;      // 60s cap
const JITTER_FACTOR = 0.3;     // ±30% jitter

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getBackoffDelay(): number {
    const exp = Math.min(reconnectAttempts, 8); // 2^8 = 256 × 2s = 512s, but capped at 60s
    const base = Math.min(BASE_DELAY * Math.pow(2, exp), MAX_DELAY);
    const jitter = base * JITTER_FACTOR * (Math.random() * 2 - 1); // ±30%
    return Math.max(1000, base + jitter);
}

function setConnected(val: boolean) {
    if (connected !== val) {
        connected = val;
        connectedListeners.forEach(fn => fn(val));
    }
}

function dispatch(eventType: string, data: any) {
    for (const sub of subscriptions) {
        if (sub.eventType === eventType) {
            try { sub.handler(data); } catch { /* consumer error */ }
        }
    }
}

// ---------------------------------------------------------------------------
// Connection management
// ---------------------------------------------------------------------------

function connect() {
    // Don't connect if no subscribers or manually disconnected
    if (subscriberCount <= 0 || isManuallyDisconnected) return;

    // Close existing
    if (eventSource) { eventSource.close(); eventSource = null; }
    if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }

    const token = getAuthToken();
    const sseUrl = token ? `/events/calls?token=${encodeURIComponent(token)}` : '/events/calls';

    try {
        const es = new EventSource(sseUrl);
        eventSource = es;

        // Named event types the server sends
        const namedEvents = [
            'connected', 'call.updated', 'call.created',
            'message.added', 'message.delivery', 'conversation.updated',
            'contact.read', 'transcript.delta', 'transcript.finalized',
            'job.updated',
            // Generic pulse events
            'thread.action_required', 'thread.handled', 'thread.snoozed',
            'thread.unsnoozed', 'thread.assigned', 'timeline.read',
            'timeline.unread', 'contact.unread', 'call.holding',
        ];

        for (const eventType of namedEvents) {
            es.addEventListener(eventType, (e: MessageEvent) => {
                try {
                    const data = JSON.parse(e.data);
                    if (eventType === 'connected') {
                        setConnected(true);
                        reconnectAttempts = 0;
                        console.log('[SSE] Connected (shared)');
                    }
                    dispatch(eventType, data);
                } catch { /* parse error */ }
            });
        }

        es.onerror = () => {
            setConnected(false);
            es.close();
            if (eventSource === es) eventSource = null;

            if (!isManuallyDisconnected && subscriberCount > 0) {
                reconnectAttempts++;
                const delay = getBackoffDelay();
                console.log(`[SSE] Connection lost — reconnect #${reconnectAttempts} in ${Math.round(delay / 1000)}s`);
                reconnectTimeout = window.setTimeout(() => connect(), delay);
            }

            dispatch('__error', new Error('SSE connection error'));
        };
    } catch (error) {
        dispatch('__error', error);
    }
}

// ---------------------------------------------------------------------------
// Page visibility: pause when tab hidden, resume when visible
// ---------------------------------------------------------------------------

if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            // Tab hidden — disconnect to save resources
            if (eventSource) {
                eventSource.close();
                eventSource = null;
            }
            if (reconnectTimeout) {
                clearTimeout(reconnectTimeout);
                reconnectTimeout = null;
            }
            setConnected(false);
        } else {
            // Tab visible again — reconnect immediately
            if (subscriberCount > 0 && !isManuallyDisconnected) {
                reconnectAttempts = 0; // fresh start on tab focus
                connect();
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function subscribe(eventType: string, handler: SSEEventHandler): number {
    const id = ++nextSubscriptionId;
    subscriptions.push({ id, eventType, handler });
    subscriberCount++;

    // First subscriber triggers connection
    if (subscriberCount === 1 && !eventSource && !isManuallyDisconnected) {
        connect();
    }

    return id;
}

export function unsubscribe(id: number) {
    const idx = subscriptions.findIndex(s => s.id === id);
    if (idx !== -1) {
        subscriptions.splice(idx, 1);
        subscriberCount--;

        // Last subscriber gone — disconnect
        if (subscriberCount <= 0) {
            subscriberCount = 0;
            if (eventSource) { eventSource.close(); eventSource = null; }
            if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
            setConnected(false);
        }
    }
}

export function onConnectedChange(fn: (val: boolean) => void): () => void {
    connectedListeners.add(fn);
    return () => connectedListeners.delete(fn);
}

export function isConnected(): boolean {
    return connected;
}

export function manualDisconnect() {
    isManuallyDisconnected = true;
    if (eventSource) { eventSource.close(); eventSource = null; }
    if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
    setConnected(false);
}

export function manualReconnect() {
    isManuallyDisconnected = false;
    reconnectAttempts = 0;
    connect();
}
