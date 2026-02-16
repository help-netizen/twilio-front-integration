// Pulse timeline types

import type { CallData } from '../components/call-list-item';

export interface SmsMediaItem {
    id: string;
    twilio_media_sid: string;
    filename: string | null;
    content_type: string | null;
    size_bytes: number | null;
    preview_kind: string | null;
}

export interface SmsMessage {
    id: string;
    twilio_message_sid: string;
    conversation_id: string;
    direction: 'inbound' | 'outbound';
    body: string | null;
    delivery_status: string | null;
    from_number: string | null;
    to_number: string | null;
    date_created_remote: string | null;
    created_at: string;
    media: SmsMediaItem[];
}

export interface SmsConversation {
    id: string;
    customer_e164: string;
    proxy_e164: string;
    state: string;
}

export type TimelineItemType = 'call' | 'sms';

export interface TimelineItem {
    type: TimelineItemType;
    timestamp: Date;
    data: CallData | SmsMessage;
}

export interface PulseTimelineResponse {
    calls: any[]; // raw API call objects
    messages: SmsMessage[];
    conversations: SmsConversation[];
}
