declare global {
    interface Window { __suppressSSENotifications?: boolean; }
}

export interface SSECallEvent {
    id?: number; call_sid: string; parent_call_sid?: string; direction?: string;
    from_number?: string; to_number?: string; status: string; is_final?: boolean;
    started_at?: string; answered_at?: string; ended_at?: string; duration_sec?: number;
    answered_by?: string; contact_id?: number; timeline_id?: number;
    contact?: { id: number; phone_e164: string; full_name?: string };
    updated_at?: string; created_at?: string;
}

export interface SSEConnectionEvent { connectionId: number; timestamp: string; }
export interface SSEMessageAddedEvent { message: any; conversationId: string; timelineId?: number | null; }
export interface SSEMessageDeliveryEvent { messageSid: string; status: string; errorCode: number | null; }
export interface SSEConversationUpdatedEvent { conversation: any; }
export interface SSEContactReadEvent { contactId: number; }
export interface SSEJobUpdatedEvent { job: any; }

export interface SSETranscriptDeltaEvent {
    callSid: string; track: string; speaker: 'customer' | 'agent';
    text: string; isFinal: boolean; turnOrder: number;
    startMs?: number; endMs?: number; receivedAt: string;
}

export interface SSETranscriptFinalizedEvent { callSid: string; text: string; segmentCount: number; finalizedAt: string; }

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
