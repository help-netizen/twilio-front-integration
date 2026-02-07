import { useEffect, useRef, useCallback } from 'react';

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
 * Usage:
 * ```tsx
 * const { connected, stats } = useRealtimeEvents({
 *   onCallUpdate: (event) => {
 *     console.log('Call updated:', event);
 *     // Update state, refresh UI, etc.
 *   }
 * });
 * ```
 */
export function useRealtimeEvents(options: UseRealtimeEventsOptions = {}) {
    const {
        onCallUpdate,
        onCallCreated,
        onConnected,
        onError,
        autoReconnect = true,
        reconnectDelay = 3000
    } = options;

    const eventSourceRef = useRef<EventSource | null>(null);
    const reconnectTimeoutRef = useRef<number | null>(null);
    const isManuallyClosedRef = useRef(false);

    // Stats
    const statsRef = useRef({
        connected: false,
        connectionId: null as number | null,
        eventsReceived: 0,
        lastEventAt: null as Date | null,
        reconnectAttempts: 0
    });

    /**
     * Connect to SSE endpoint
     */
    const connect = useCallback(() => {
        // Clean up existing connection
        if (eventSourceRef.current) {
            eventSourceRef.current.close();
            eventSourceRef.current = null;
        }

        // Clear reconnect timeout
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

                statsRef.current.connected = true;
                statsRef.current.connectionId = data.connectionId;
                statsRef.current.reconnectAttempts = 0;

                onConnected?.(data);
            });

            // Call updated event
            eventSource.addEventListener('call.updated', (e) => {
                const data = JSON.parse(e.data) as SSECallEvent;
                console.log('[SSE] Call updated:', data.call_sid, data.status);

                statsRef.current.eventsReceived++;
                statsRef.current.lastEventAt = new Date();

                onCallUpdate?.(data);
            });

            // Call created event
            eventSource.addEventListener('call.created', (e) => {
                const data = JSON.parse(e.data) as SSECallEvent;
                console.log('[SSE] Call created:', data.call_sid);

                statsRef.current.eventsReceived++;
                statsRef.current.lastEventAt = new Date();

                onCallCreated?.(data);
            });

            // Error handling
            eventSource.onerror = () => {
                console.error('[SSE] Connection error');
                statsRef.current.connected = false;

                // Close the connection
                eventSource.close();

                // Auto-reconnect if not manually closed
                if (autoReconnect && !isManuallyClosedRef.current) {
                    statsRef.current.reconnectAttempts++;
                    const delay = reconnectDelay * Math.min(statsRef.current.reconnectAttempts, 5); // Max 5x delay

                    console.log(`[SSE] Reconnecting in ${delay}ms (attempt ${statsRef.current.reconnectAttempts})...`);

                    reconnectTimeoutRef.current = setTimeout(() => {
                        connect();
                    }, delay);
                }

                onError?.(new Error('SSE connection error'));
            };

        } catch (error) {
            console.error('[SSE] Failed to create EventSource:', error);
            onError?.(error as Error);
        }
    }, [onCallUpdate, onCallCreated, onConnected, onError, autoReconnect, reconnectDelay]);

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

        statsRef.current.connected = false;
    }, []);

    /**
     * Reconnect (manual)
     */
    const reconnect = useCallback(() => {
        isManuallyClosedRef.current = false;
        connect();
    }, [connect]);

    // Auto-connect on mount
    useEffect(() => {
        isManuallyClosedRef.current = false;
        connect();

        // Cleanup on unmount
        return () => {
            disconnect();
        };
    }, [connect, disconnect]);

    return {
        connected: statsRef.current.connected,
        connectionId: statsRef.current.connectionId,
        stats: statsRef.current,
        disconnect,
        reconnect
    };
}
