/**
 * useRealtimeEvents — React hook for SSE events.
 *
 * All instances share a SINGLE EventSource connection via sseManager.
 * Previously each hook call created its own EventSource, causing 9+
 * simultaneous connections and massive request spam on reconnection (Bug #12).
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { subscribe, unsubscribe, onConnectedChange, isConnected, manualDisconnect, manualReconnect } from './sseManager';
import type {
    SSECallEvent, SSEConnectionEvent, SSEMessageAddedEvent, SSEMessageDeliveryEvent,
    SSEConversationUpdatedEvent, SSEContactReadEvent, SSETranscriptDeltaEvent,
    SSETranscriptFinalizedEvent, SSEJobUpdatedEvent, UseRealtimeEventsOptions,
} from './realtimeEventTypes';

export type { SSECallEvent, SSEConnectionEvent, SSEMessageAddedEvent, SSEMessageDeliveryEvent, SSEConversationUpdatedEvent, SSEContactReadEvent, SSEJobUpdatedEvent, SSETranscriptDeltaEvent, SSETranscriptFinalizedEvent, UseRealtimeEventsOptions };

export function useRealtimeEvents(options: UseRealtimeEventsOptions = {}) {
    // Keep refs to latest callbacks so subscriptions always call current version
    const onCallUpdateRef = useRef(options.onCallUpdate);
    const onCallCreatedRef = useRef(options.onCallCreated);
    const onMessageAddedRef = useRef(options.onMessageAdded);
    const onMessageDeliveryRef = useRef(options.onMessageDelivery);
    const onConversationUpdatedRef = useRef(options.onConversationUpdated);
    const onContactReadRef = useRef(options.onContactRead);
    const onTranscriptDeltaRef = useRef(options.onTranscriptDelta);
    const onTranscriptFinalizedRef = useRef(options.onTranscriptFinalized);
    const onJobUpdatedRef = useRef(options.onJobUpdated);
    const onGenericEventRef = useRef(options.onGenericEvent);
    const onConnectedRef = useRef(options.onConnected);
    const onErrorRef = useRef(options.onError);

    // Sync refs
    onCallUpdateRef.current = options.onCallUpdate;
    onCallCreatedRef.current = options.onCallCreated;
    onMessageAddedRef.current = options.onMessageAdded;
    onMessageDeliveryRef.current = options.onMessageDelivery;
    onConversationUpdatedRef.current = options.onConversationUpdated;
    onContactReadRef.current = options.onContactRead;
    onTranscriptDeltaRef.current = options.onTranscriptDelta;
    onTranscriptFinalizedRef.current = options.onTranscriptFinalized;
    onJobUpdatedRef.current = options.onJobUpdated;
    onGenericEventRef.current = options.onGenericEvent;
    onConnectedRef.current = options.onConnected;
    onErrorRef.current = options.onError;

    const [connected, setConnected] = useState(isConnected);

    useEffect(() => {
        // Subscribe to all event types this hook cares about
        const ids: number[] = [];

        // Connected state
        const unsub = onConnectedChange(setConnected);

        ids.push(subscribe('connected', (d) => onConnectedRef.current?.(d)));
        ids.push(subscribe('call.updated', (d) => onCallUpdateRef.current?.(d)));
        ids.push(subscribe('call.created', (d) => onCallCreatedRef.current?.(d)));
        ids.push(subscribe('message.added', (d) => onMessageAddedRef.current?.(d)));
        ids.push(subscribe('message.delivery', (d) => onMessageDeliveryRef.current?.(d)));
        ids.push(subscribe('conversation.updated', (d) => onConversationUpdatedRef.current?.(d)));
        ids.push(subscribe('contact.read', (d) => onContactReadRef.current?.(d)));
        ids.push(subscribe('transcript.delta', (d) => onTranscriptDeltaRef.current?.(d)));
        ids.push(subscribe('transcript.finalized', (d) => onTranscriptFinalizedRef.current?.(d)));
        ids.push(subscribe('job.updated', (d) => onJobUpdatedRef.current?.(d)));

        // Generic events
        const genericEventTypes = [
            'thread.action_required', 'thread.handled', 'thread.snoozed',
            'thread.unsnoozed', 'thread.assigned', 'timeline.read',
            'timeline.unread', 'contact.unread', 'call.holding',
        ];
        for (const et of genericEventTypes) {
            ids.push(subscribe(et, (d) => onGenericEventRef.current?.(et, d)));
        }

        // Error channel
        ids.push(subscribe('__error', (err) => onErrorRef.current?.(err)));

        return () => {
            unsub();
            ids.forEach(id => unsubscribe(id));
        };
    }, []); // stable — refs handle callback changes

    const disconnect = useCallback(() => manualDisconnect(), []);
    const reconnect = useCallback(() => manualReconnect(), []);

    return { connected, disconnect, reconnect };
}
