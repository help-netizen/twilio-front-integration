import { useEffect, useRef, useCallback, useState } from 'react';

/**
 * SSE Event Types
 */
export interface SSECallEvent {
    call_sid: string;
    status: string;
    is_final?: boolean;
    updated_at?: string;
    from_number?: string;
    to_number?: string;
    from?: string;
    to?: string;
    created_at?: string;
}

export interface SSEConnectionEvent {
    connectionId: number;
    timestamp: string;
}

/**
 * SSE Hook Options
 */
interface UseRealtimeEventsOptions {
    onCallUpdate?: (event: SSECallEvent) => void;
    onCallCreated?: (event: SSECallEvent) => void;
    onConnected?: (event: SSEConnectionEvent) => void;
    onError?: (error: Error) => void;
    autoReconnect?: boolean;
    reconnectDelay?: number;
}

/**
 * Custom hook for subscribing to Server-Sent Events
 * 
 * Uses refs for callbacks to avoid reconnecting on every render.
 */
export function useRealtimeEvents(options: UseRealtimeEventsOptions = {}) {
    const {
        autoReconnect = true,
        reconnectDelay = 3000
    } = options;

    // Store callbacks in refs so changes don't trigger reconnect
    const onCallUpdateRef = useRef(options.onCallUpdate);
    const onCallCreatedRef = useRef(options.onCallCreated);
    const onConnectedRef = useRef(options.onConnected);
    const onErrorRef = useRef(options.onError);

    // Keep refs current
    onCallUpdateRef.current = options.onCallUpdate;
    onCallCreatedRef.current = options.onCallCreated;
    onConnectedRef.current = options.onConnected;
    onErrorRef.current = options.onError;

    const eventSourceRef = useRef<EventSource | null>(null);
    const reconnectTimeoutRef = useRef<number | null>(null);
    const isManuallyClosedRef = useRef(false);
    const reconnectAttemptsRef = useRef(0);

    const [connected, setConnected] = useState(false);

    /**
     * Connect to SSE endpoint
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

        console.log('[SSE] Connecting to /events/calls...');

        try {
            const eventSource = new EventSource('/events/calls');
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

                window.dispatchEvent(new CustomEvent('sse-event-received', {
                    detail: {
                        call_sid: data.call_sid,
                        status: data.status,
                        from: data.from_number,
                        to: data.to_number,
                        timestamp: new Date().toISOString()
                    }
                }));

                onCallUpdateRef.current?.(data);
            });

            // Call created event
            eventSource.addEventListener('call.created', (e) => {
                const data = JSON.parse(e.data) as SSECallEvent;
                console.log('[SSE] Call created:', data.call_sid);

                window.dispatchEvent(new CustomEvent('sse-event-received', {
                    detail: {
                        call_sid: data.call_sid,
                        status: data.status,
                        from: data.from_number,
                        to: data.to_number,
                        timestamp: new Date().toISOString()
                    }
                }));

                onCallCreatedRef.current?.(data);
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

