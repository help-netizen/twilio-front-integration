import { useEffect, useRef, useCallback, useState } from 'react';
import { getAuthToken } from '../auth/AuthProvider';
import type {
    SSECallEvent, SSEConnectionEvent, SSEMessageAddedEvent, SSEMessageDeliveryEvent,
    SSEConversationUpdatedEvent, SSEContactReadEvent, SSETranscriptDeltaEvent,
    SSETranscriptFinalizedEvent, SSEJobUpdatedEvent, UseRealtimeEventsOptions,
} from './realtimeEventTypes';

export type { SSECallEvent, SSEConnectionEvent, SSEMessageAddedEvent, SSEMessageDeliveryEvent, SSEConversationUpdatedEvent, SSEContactReadEvent, SSEJobUpdatedEvent, SSETranscriptDeltaEvent, SSETranscriptFinalizedEvent, UseRealtimeEventsOptions };

export function useRealtimeEvents(options: UseRealtimeEventsOptions = {}) {
    const { autoReconnect = true, reconnectDelay = 3000 } = options;
    const onCallUpdateRef = useRef(options.onCallUpdate); const onCallCreatedRef = useRef(options.onCallCreated);
    const onMessageAddedRef = useRef(options.onMessageAdded); const onMessageDeliveryRef = useRef(options.onMessageDelivery);
    const onConversationUpdatedRef = useRef(options.onConversationUpdated); const onContactReadRef = useRef(options.onContactRead);
    const onTranscriptDeltaRef = useRef(options.onTranscriptDelta); const onTranscriptFinalizedRef = useRef(options.onTranscriptFinalized);
    const onJobUpdatedRef = useRef(options.onJobUpdated);
    const onGenericEventRef = useRef(options.onGenericEvent); const onConnectedRef = useRef(options.onConnected); const onErrorRef = useRef(options.onError);

    onCallUpdateRef.current = options.onCallUpdate; onCallCreatedRef.current = options.onCallCreated;
    onMessageAddedRef.current = options.onMessageAdded; onMessageDeliveryRef.current = options.onMessageDelivery;
    onConversationUpdatedRef.current = options.onConversationUpdated; onContactReadRef.current = options.onContactRead;
    onTranscriptDeltaRef.current = options.onTranscriptDelta; onTranscriptFinalizedRef.current = options.onTranscriptFinalized;
    onJobUpdatedRef.current = options.onJobUpdated;
    onGenericEventRef.current = options.onGenericEvent; onConnectedRef.current = options.onConnected; onErrorRef.current = options.onError;

    const eventSourceRef = useRef<EventSource | null>(null);
    const reconnectTimeoutRef = useRef<number | null>(null);
    const isManuallyClosedRef = useRef(false);
    const reconnectAttemptsRef = useRef(0);
    const [connected, setConnected] = useState(false);

    const connect = useCallback(() => {
        if (eventSourceRef.current) { eventSourceRef.current.close(); eventSourceRef.current = null; }
        if (reconnectTimeoutRef.current) { clearTimeout(reconnectTimeoutRef.current); reconnectTimeoutRef.current = null; }
        const token = getAuthToken();
        const sseUrl = token ? `/events/calls?token=${encodeURIComponent(token)}` : '/events/calls';
        try {
            const es = new EventSource(sseUrl);
            eventSourceRef.current = es;
            es.addEventListener('connected', e => { const d = JSON.parse(e.data) as SSEConnectionEvent; setConnected(true); reconnectAttemptsRef.current = 0; onConnectedRef.current?.(d); });
            es.addEventListener('call.updated', e => { onCallUpdateRef.current?.(JSON.parse(e.data)); });
            es.addEventListener('call.created', e => { onCallCreatedRef.current?.(JSON.parse(e.data)); });
            es.addEventListener('message.added', e => { onMessageAddedRef.current?.(JSON.parse(e.data)); });
            es.addEventListener('message.delivery', e => { onMessageDeliveryRef.current?.(JSON.parse(e.data)); });
            es.addEventListener('conversation.updated', e => { onConversationUpdatedRef.current?.(JSON.parse(e.data)); });
            es.addEventListener('contact.read', e => { onContactReadRef.current?.(JSON.parse(e.data)); });
            es.addEventListener('transcript.delta', e => { onTranscriptDeltaRef.current?.(JSON.parse(e.data)); });
            es.addEventListener('transcript.finalized', e => { onTranscriptFinalizedRef.current?.(JSON.parse(e.data)); });
            es.addEventListener('job.updated', e => { onJobUpdatedRef.current?.(JSON.parse(e.data)); });
            const genericEventTypes = ['thread.action_required', 'thread.handled', 'thread.snoozed', 'thread.unsnoozed', 'thread.assigned', 'timeline.read', 'timeline.unread', 'contact.unread', 'call.holding'];
            for (const et of genericEventTypes) { es.addEventListener(et, e => { try { onGenericEventRef.current?.(et, JSON.parse(e.data)); } catch { } }); }
            es.onerror = () => { setConnected(false); es.close(); if (autoReconnect && !isManuallyClosedRef.current) { reconnectAttemptsRef.current++; const delay = reconnectDelay * Math.min(reconnectAttemptsRef.current, 5); reconnectTimeoutRef.current = window.setTimeout(() => connect(), delay); } onErrorRef.current?.(new Error('SSE connection error')); };
        } catch (error) { onErrorRef.current?.(error as Error); }
    }, [autoReconnect, reconnectDelay]);

    const disconnect = useCallback(() => { isManuallyClosedRef.current = true; if (reconnectTimeoutRef.current) { clearTimeout(reconnectTimeoutRef.current); reconnectTimeoutRef.current = null; } if (eventSourceRef.current) { eventSourceRef.current.close(); eventSourceRef.current = null; } setConnected(false); }, []);
    const reconnect = useCallback(() => { isManuallyClosedRef.current = false; connect(); }, [connect]);

    useEffect(() => { isManuallyClosedRef.current = false; connect(); return () => { disconnect(); }; }, [connect, disconnect]);

    return { connected, disconnect, reconnect };
}
