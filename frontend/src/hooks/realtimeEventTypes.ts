export interface SSEInvalidationEvent {
    type: string;
    company_id: string;
    resource: string;
    invalidate: true;
}

export interface SSEConnectionEvent { connectionId: number; timestamp: string; }
export type SSECallEvent = SSEInvalidationEvent;
export type SSEMessageAddedEvent = SSEInvalidationEvent;
export type SSEMessageDeliveryEvent = SSEInvalidationEvent;
export type SSEConversationUpdatedEvent = SSEInvalidationEvent;
export type SSEContactReadEvent = SSEInvalidationEvent;
export type SSEJobUpdatedEvent = SSEInvalidationEvent;
export type SSETranscriptDeltaEvent = SSEInvalidationEvent;
export type SSETranscriptFinalizedEvent = SSEInvalidationEvent;

export interface UseRealtimeEventsOptions {
    onCallUpdate?: (event: SSECallEvent) => void;
    onCallCreated?: (event: SSECallEvent) => void;
    onMessageAdded?: (event: SSEMessageAddedEvent) => void;
    onMessageDelivery?: (event: SSEMessageDeliveryEvent) => void;
    onConversationUpdated?: (event: SSEConversationUpdatedEvent) => void;
    onContactRead?: (event: SSEContactReadEvent) => void;
    onTranscriptDelta?: (event: SSETranscriptDeltaEvent) => void;
    onTranscriptFinalized?: (event: SSETranscriptFinalizedEvent) => void;
    onJobUpdated?: (event: SSEJobUpdatedEvent) => void;
    onGenericEvent?: (eventType: string, data: any) => void;
    onConnected?: (event: SSEConnectionEvent) => void;
    onError?: (error: Error) => void;
    autoReconnect?: boolean;
    reconnectDelay?: number;
}
