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

export type TimelineItemType = 'call' | 'sms' | 'financial' | 'email';

// EMAIL-TIMELINE-001 §6 — an email projected onto a contact's timeline.
// Backend (buildTimeline) already quote-strips body_text for display.
export interface EmailTimelineItem {
    id: string;
    type: 'email';
    direction: 'inbound' | 'outbound';
    is_outbound: boolean;
    from_email: string | null;
    from_name: string | null;
    to_email: string | string[] | null; // raw to_recipients_json
    subject: string | null;
    body_text: string | null; // plain text, already quote-stripped server-side
    body_html: string | null; // raw HTML body — sanitized client-side (SafeEmailHtml)
    sent_at: string; // gmail_internal_at (ISO8601) — timeline sort timestamp
    thread_id: string | null;
    sent_by_user_email: string | null; // outbound attribution (nullable)
}

export interface FinancialEvent {
    id: string;
    type: 'estimate_created' | 'estimate_sent' | 'estimate_accepted' | 'estimate_declined'
        | 'invoice_created' | 'invoice_sent' | 'invoice_paid' | 'invoice_partial_payment';
    reference: string;
    status: string;
    amount: string;
    occurred_at: string;
    contact_id: number;
}

export interface TimelineItem {
    type: TimelineItemType;
    timestamp: Date;
    data: CallData | SmsMessage | FinancialEvent | EmailTimelineItem;
}

export interface PulseTimelineResponse {
    calls: any[]; // raw API call objects
    messages: SmsMessage[];
    conversations: SmsConversation[];
    financial_events?: FinancialEvent[];
    email_messages?: EmailTimelineItem[];
}

// Action Required types
export interface PulseTask {
    id: number;
    title: string;
    due_at: string | null;
    priority: 'p1' | 'p2' | 'p3';
}

export interface ActionRequiredState {
    is_action_required: boolean;
    action_required_reason: string | null;
    action_required_set_at: string | null;
    snoozed_until: string | null;
    owner_user_id: string | null;
    open_task: PulseTask | null;
}
