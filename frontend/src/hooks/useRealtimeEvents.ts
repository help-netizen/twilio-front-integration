import { useEffect, useRef, useCallback, useState } from 'react';
import { getAuthToken } from '../auth/AuthProvider';

// Extend Window to support SSE notification suppression flag
declare global {
    interface Window {
        __suppressSSENotifications?: boolean;
    }
}

/**
 * SSE Event Types — enriched with full call data for cache updates
 */
export interface SSECallEvent {
    id?: number;
    call_sid: string;
    parent_call_sid?: string;
    direction?: string;
    from_number?: string;
    to_number?: string;
    status: string;
    is_final?: boolean;
    started_at?: string;
    answered_at?: string;
    ended_at?: string;
    duration_sec?: number;
    answered_by?: string;
    contact_id?: number;
    timeline_id?: number;
    contact?: {
        id: number;
        phone_e164: string;
        full_name?: string;
    };
    updated_at?: string;
    created_at?: string;
}

export interface SSEConnectionEvent {
    connectionId: number;
    timestamp: string;
}

/** Messaging SSE events */
export interface SSEMessageAddedEvent {
    message: any;
    conversationId: string;
}

export interface SSEMessageDeliveryEvent {
    messageSid: string;
    status: string;
    errorCode: number | null;
}

export interface SSEConversationUpdatedEvent {
    conversation: any;
}

export interface SSEContactReadEvent {
    contactId: number;
}

/** Realtime transcription SSE events */
export interface SSETranscriptDeltaEvent {
    callSid: string;
    track: string;
    speaker: 'customer' | 'agent';
    text: string;
    isFinal: boolean;
    turnOrder: number;
    startMs?: number;
    endMs?: number;
    receivedAt: string;
}

export interface SSETranscriptFinalizedEvent {
    callSid: string;
    text: string;
    segmentCount: number;
    finalizedAt: string;
}

/**
 * SSE Hook Options
 */
interface UseRealtimeEventsOptions {
    onCallUpdate?: (event: SSECallEvent) => void;
    onCallCreated?: (event: SSECallEvent) => void;
    onMessageAdded?: (event: SSEMessageAddedEvent) => void;
    onMessageDelivery?: (event: SSEMessageDeliveryEvent) => void;
    onConversationUpdated?: (event: SSEConversationUpdatedEvent) => void;
    onContactRead?: (event: SSEContactReadEvent) => void;
    onTranscriptDelta?: (event: SSETranscriptDeltaEvent) => void;
    onTranscriptFinalized?: (event: SSETranscriptFinalizedEvent) => void;
    onConnected?: (event: SSEConnectionEvent) => void;
    onError?: (error: Error) => void;
    autoReconnect?: boolean;
    reconnectDelay?: number;
}

/**
 * Custom hook for subscribing to Server-Sent Events
 * 
 * Uses refs for callbacks to avoid reconnecting on every render.
 * Appends ?token= to the SSE URL for authentication (EventSource can't send headers).
 */
export function useRealtimeEvents(options: UseRealtimeEventsOptions = {}) {
    const {
        autoReconnect = true,
        reconnectDelay = 3000
    } = options;

    // Store callbacks in refs so changes don't trigger reconnect
    const onCallUpdateRef = useRef(options.onCallUpdate);
    const onCallCreatedRef = useRef(options.onCallCreated);
    const onMessageAddedRef = useRef(options.onMessageAdded);
    const onMessageDeliveryRef = useRef(options.onMessageDelivery);
    const onConversationUpdatedRef = useRef(options.onConversationUpdated);
    const onContactReadRef = useRef(options.onContactRead);
    const onTranscriptDeltaRef = useRef(options.onTranscriptDelta);
    const onTranscriptFinalizedRef = useRef(options.onTranscriptFinalized);
    const onConnectedRef = useRef(options.onConnected);
    const onErrorRef = useRef(options.onError);

    // Keep refs current
    onCallUpdateRef.current = options.onCallUpdate;
    onCallCreatedRef.current = options.onCallCreated;
    onMessageAddedRef.current = options.onMessageAdded;
    onMessageDeliveryRef.current = options.onMessageDelivery;
    onConversationUpdatedRef.current = options.onConversationUpdated;
    onContactReadRef.current = options.onContactRead;
    onTranscriptDeltaRef.current = options.onTranscriptDelta;
    onTranscriptFinalizedRef.current = options.onTranscriptFinalized;
    onConnectedRef.current = options.onConnected;
    onErrorRef.current = options.onError;

    const eventSourceRef = useRef<EventSource | null>(null);
    const reconnectTimeoutRef = useRef<number | null>(null);
    const isManuallyClosedRef = useRef(false);
    const reconnectAttemptsRef = useRef(0);

    const [connected, setConnected] = useState(false);

    /**
     * Connect to SSE endpoint with auth token
     */
    const connect = useCallback(() => {
        // Clean up existing connection
        if (eventSourceRef.current) {
            eventSourceRef.current.close();
            eventSourceRef.current = null;
        }

        if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
        }

        // Build SSE URL with auth token
        const token = getAuthToken();
        const sseUrl = token
            ? `/events/calls?token=${encodeURIComponent(token)}`
            : '/events/calls';

        console.log('[SSE] Connecting to', sseUrl.replace(/token=.*/, 'token=***'));

        try {
            const eventSource = new EventSource(sseUrl);
            eventSourceRef.current = eventSource;

            // Connection opened
            eventSource.addEventListener('connected', (e) => {
                const data = JSON.parse(e.data) as SSEConnectionEvent;
                console.log('[SSE] Connected:', data);
                setConnected(true);
                reconnectAttemptsRef.current = 0;
                onConnectedRef.current?.(data);
            });

            // Call updated event
            eventSource.addEventListener('call.updated', (e) => {
                const data = JSON.parse(e.data) as SSECallEvent;
                console.log('[SSE] Call updated:', data.call_sid, data.status);
                onCallUpdateRef.current?.(data);
            });

            // Call created event
            eventSource.addEventListener('call.created', (e) => {
                const data = JSON.parse(e.data) as SSECallEvent;
                console.log('[SSE] Call created:', data.call_sid);
                onCallCreatedRef.current?.(data);
            });

            // Messaging events
            eventSource.addEventListener('message.added', (e) => {
                const data = JSON.parse(e.data) as SSEMessageAddedEvent;
                console.log('[SSE] Message added:', data.conversationId);
                onMessageAddedRef.current?.(data);
            });

            eventSource.addEventListener('message.delivery', (e) => {
                const data = JSON.parse(e.data) as SSEMessageDeliveryEvent;
                console.log('[SSE] Message delivery:', data.messageSid, data.status);
                onMessageDeliveryRef.current?.(data);
            });

            eventSource.addEventListener('conversation.updated', (e) => {
                const data = JSON.parse(e.data) as SSEConversationUpdatedEvent;
                console.log('[SSE] Conversation updated:', data.conversation?.id);
                onConversationUpdatedRef.current?.(data);
            });

            // Contact read event
            eventSource.addEventListener('contact.read', (e) => {
                const data = JSON.parse(e.data) as SSEContactReadEvent;
                console.log('[SSE] Contact read:', data.contactId);
                onContactReadRef.current?.(data);
            });

            // Realtime transcription events
            eventSource.addEventListener('transcript.delta', (e) => {
                const data = JSON.parse(e.data) as SSETranscriptDeltaEvent;
                onTranscriptDeltaRef.current?.(data);
            });

            eventSource.addEventListener('transcript.finalized', (e) => {
                const data = JSON.parse(e.data) as SSETranscriptFinalizedEvent;
                console.log('[SSE] Transcript finalized:', data.callSid, data.segmentCount, 'segments');
                onTranscriptFinalizedRef.current?.(data);
            });

            // Error handling
            eventSource.onerror = () => {
                console.error('[SSE] Connection error');
                setConnected(false);
                eventSource.close();

                if (autoReconnect && !isManuallyClosedRef.current) {
                    reconnectAttemptsRef.current++;
                    const delay = reconnectDelay * Math.min(reconnectAttemptsRef.current, 5);
                    console.log(`[SSE] Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current})...`);

                    reconnectTimeoutRef.current = window.setTimeout(() => {
                        connect();
                    }, delay);
                }

                onErrorRef.current?.(new Error('SSE connection error'));
            };

        } catch (error) {
            console.error('[SSE] Failed to create EventSource:', error);
            onErrorRef.current?.(error as Error);
        }
    }, [autoReconnect, reconnectDelay]); // Only reconnect config in deps, NOT callbacks

    /**
     * Disconnect from SSE
     */
    const disconnect = useCallback(() => {
        console.log('[SSE] Disconnecting...');
        isManuallyClosedRef.current = true;

        if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
        }

        if (eventSourceRef.current) {
            eventSourceRef.current.close();
            eventSourceRef.current = null;
        }

        setConnected(false);
    }, []);

    /**
     * Reconnect (manual)
     */
    const reconnect = useCallback(() => {
        isManuallyClosedRef.current = false;
        connect();
    }, [connect]);

    // Auto-connect on mount, disconnect on unmount
    useEffect(() => {
        isManuallyClosedRef.current = false;
        connect();
        return () => { disconnect(); };
    }, [connect, disconnect]);

    return {
        connected,
        disconnect,
        reconnect
    };
}
