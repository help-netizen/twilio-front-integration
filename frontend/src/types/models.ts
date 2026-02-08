// V3 data models — calls-first architecture

export type CallStatus = 'completed' | 'busy' | 'no-answer' | 'canceled' | 'failed' | 'in-progress' | 'ringing' | 'initiated' | 'queued';
export type CallDirection = 'inbound' | 'outbound' | 'outbound-dial' | 'outbound-api' | 'internal';

export interface Contact {
    id: number;
    phone_e164: string;
    full_name: string | null;
    email: string | null;
    created_at: string;
    updated_at: string;
}

export interface Call {
    id: number;
    call_sid: string;
    parent_call_sid: string | null;
    direction: CallDirection;
    from_number: string;
    to_number: string;
    status: CallStatus;
    is_final: boolean;
    started_at: string | null;
    answered_at: string | null;
    ended_at: string | null;
    duration_sec: number | null;
    price: string | null;
    price_unit: string | null;
    created_at: string;
    updated_at: string;
    contact?: Contact;
    call_count?: number;  // present in by-contact response
    recording?: {
        recording_sid: string;
        status: string;
        playback_url: string | null;
        duration_sec: number | null;
    };
    transcript?: {
        status: string;
        text: string | null;
    };
}

export interface Recording {
    id: number;
    recording_sid: string;
    call_sid: string;
    status: string;
    recording_url: string | null;
    duration_sec: number | null;
    created_at: string;
}

export interface Transcript {
    id: number;
    transcription_sid: string | null;
    call_sid: string | null;
    status: string;
    text: string | null;
    confidence: number | null;
    language_code: string | null;
    created_at: string;
}

export interface CallEvent {
    id: number;
    call_sid: string;
    event_type: string;
    event_time: string;
    payload: Record<string, any>;
    created_at: string;
}

export interface CallMedia {
    recordings: Recording[];
    transcripts: Transcript[];
}

// API Response types
export interface CallsResponse {
    calls: Call[];
    next_cursor: number | null;
    count: number;
}

export interface ActiveCallsResponse {
    active_calls: Call[];
    count: number;
}

export interface ByContactResponse {
    conversations: Call[];
    total: number;
    limit: number;
    offset: number;
}

export interface CallEventsResponse {
    events: CallEvent[];
    count: number;
}

export interface CallMediaResponse {
    media: CallMedia;
}
