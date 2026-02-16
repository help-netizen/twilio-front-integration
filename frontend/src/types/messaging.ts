export interface Conversation {
    id: string;
    twilio_conversation_sid: string | null;
    service_sid: string | null;
    channel_type: string;
    state: 'active' | 'inactive' | 'closed';
    customer_e164: string | null;
    proxy_e164: string | null;
    friendly_name: string | null;
    attributes: Record<string, unknown>;
    source: string;
    first_message_at: string | null;
    last_message_at: string | null;
    last_message_preview: string | null;
    last_message_direction: 'inbound' | 'outbound' | null;
    closed_at: string | null;
    company_id: string | null;
    has_unread: boolean;
    last_read_at: string | null;
    last_incoming_at: string | null;
    created_at: string;
    updated_at: string;
}

export interface ConversationsResponse {
    conversations: Conversation[];
    nextCursor: string | null;
}

export interface MessageMedia {
    id: string;
    twilio_media_sid: string | null;
    filename: string | null;
    content_type: string | null;
    size_bytes: number | null;
    preview_kind: 'image' | 'video' | 'audio' | 'pdf' | 'generic' | null;
}

export interface Message {
    id: string;
    twilio_message_sid: string | null;
    conversation_id: string;
    conversation_sid: string | null;
    author: string | null;
    author_type: 'external' | 'agent' | 'system';
    direction: 'inbound' | 'outbound';
    transport: string;
    body: string | null;
    attributes: Record<string, unknown>;
    delivery_status: string | null;
    error_code: number | null;
    error_message: string | null;
    index_in_conversation: number | null;
    date_created_remote: string | null;
    date_updated_remote: string | null;
    date_sent_remote: string | null;
    media: MessageMedia[];
    created_at: string;
    updated_at: string;
}

export interface MessagesResponse {
    messages: Message[];
    hasMore: boolean;
}

export interface SendMessageRequest {
    body?: string;
    mediaUrl?: string;
    author?: string;
}

export interface StartConversationRequest {
    customerE164: string;
    proxyE164: string;
    initialMessage?: string;
}

export interface MediaUrlResponse {
    url: string;
    expiresAt: string;
}
