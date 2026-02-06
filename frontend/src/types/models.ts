// Front-compatible data models

export type CallStatus = 'completed' | 'busy' | 'no-answer' | 'canceled' | 'failed' | 'in-progress' | 'ringing' | 'initiated' | 'queued';
export type CallDirection = 'inbound' | 'outbound' | 'inbound-api' | 'outbound-api';

export interface Contact {
    id: string;
    handle: string;                   // Phone number
    name?: string;
    avatar_url?: string;

    metadata: {
        formatted_number: string;       // "+1 (415) 555-1234"
        country_code?: string;
        is_mobile?: boolean;
    };

    created_at: number;
    updated_at: number;
}

export interface Call {
    sid: string;
    from: string;
    to: string;
    duration: number;                 // seconds
    status: CallStatus;
    direction: CallDirection;
    recording_url?: string;
    price?: string;
    answered_by?: string;
    start_time: string;
    end_time?: string;
}

export interface Message {
    id: string;
    external_id: string;              // Twilio Call SID
    type: 'call';
    direction: CallDirection;
    created_at: number;

    // Call-specific fields
    call: Call;

    // Display fields
    subject: string;
    body: string;
    blurb: string;

    // Relations
    conversation_id: string;
    contact: Contact;

    // Metadata with call status and details
    metadata: {
        call_sid: string;
        duration: number;
        status: CallStatus;
        recording_url?: string;
        from_number: string;
        to_number: string;
        parent_call_sid?: string;
        total_duration?: number;
        talk_time?: number;
        wait_time?: number;
        merged_from_parent?: boolean;
        [key: string]: any;
    };
}

export interface Conversation {
    id: string;
    external_id: string;              // Phone number
    subject: string;
    status: 'active' | 'archived';
    last_message: Message | null;
    last_message_at: number;
    unread_count: number;
    contact: Contact;

    metadata: {
        total_calls: number;
        total_duration: number;
        last_call_direction: CallDirection;
    };

    created_at: number;
    updated_at: number;
}

// API Response types
export interface ConversationsResponse {
    conversations: Conversation[];
    total: number;
}

export interface MessagesResponse {
    messages: Message[];
    total: number;
}
