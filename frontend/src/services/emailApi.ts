/**
 * Email API Client (EMAIL-001)
 * Typed wrapper for /api/settings/email and /api/email endpoints.
 */
import { authedFetch } from './apiClient';

// ─── Types ───────────────────────────────────────────────────────────────

export interface EmailMailbox {
    id?: string;
    provider: string;
    email_address: string;
    display_name?: string;
    status: 'connected' | 'reconnect_required' | 'sync_error' | 'disconnected';
    last_synced_at: string | null;
    last_sync_status: string | null;
    last_sync_error: string | null;
    created_at?: string;
}

export interface EmailThread {
    id: number;
    company_id: string;
    mailbox_id: string;
    provider_thread_id: string;
    subject: string | null;
    participants_json: { name?: string; email: string }[];
    last_message_at: string | null;
    last_message_preview: string | null;
    last_message_direction: 'inbound' | 'outbound' | null;
    last_message_from: string | null;
    unread_count: number;
    has_attachments: boolean;
    message_count: number;
    created_at: string;
    updated_at: string;
}

export interface EmailMessage {
    id: number;
    thread_id: number;
    provider_message_id: string;
    direction: 'inbound' | 'outbound';
    from_name: string | null;
    from_email: string | null;
    to_recipients_json: { name?: string; email: string }[];
    cc_recipients_json: { name?: string; email: string }[];
    subject: string | null;
    snippet: string | null;
    body_text: string | null;
    body_html: string | null;
    has_attachments: boolean;
    gmail_internal_at: string | null;
    sent_by_user_id: string | null;
    sent_by_user_email: string | null;
    attachments: EmailAttachment[];
    created_at: string;
}

export interface EmailAttachment {
    id: number;
    provider_attachment_id: string | null;
    file_name: string | null;
    content_type: string | null;
    file_size: number | null;
    is_inline: boolean;
}

// ─── Settings API ────────────────────────────────────────────────────────

export async function getMailboxSettings(): Promise<EmailMailbox | null> {
    const res = await authedFetch('/api/settings/email');
    const data = await res.json();
    return data.data?.mailbox || null;
}

export async function startGoogleConnect(): Promise<string> {
    const res = await authedFetch('/api/settings/email/google/start', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Failed to start OAuth');
    return data.data.auth_url;
}

export async function disconnectMailbox(): Promise<void> {
    const res = await authedFetch('/api/settings/email/disconnect', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Failed to disconnect');
}

export async function triggerManualSync(): Promise<void> {
    const res = await authedFetch('/api/settings/email/sync', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Failed to trigger sync');
}

// ─── Workspace API ───────────────────────────────────────────────────────

export async function getWorkspaceMailbox(): Promise<EmailMailbox | null> {
    const res = await authedFetch('/api/email/mailbox');
    const data = await res.json();
    return data.data?.mailbox || null;
}

export async function getThreads(params: {
    view?: string;
    q?: string;
    cursor?: string;
    limit?: number;
}): Promise<{ threads: EmailThread[]; nextCursor: string | null; hasMore: boolean }> {
    const qs = new URLSearchParams();
    if (params.view) qs.set('view', params.view);
    if (params.q) qs.set('q', params.q);
    if (params.cursor) qs.set('cursor', params.cursor);
    if (params.limit) qs.set('limit', String(params.limit));

    const res = await authedFetch(`/api/email/threads?${qs.toString()}`);
    const data = await res.json();
    return data.data || { threads: [], nextCursor: null, hasMore: false };
}

export async function getThreadDetail(threadId: number): Promise<{ thread: EmailThread; messages: EmailMessage[] }> {
    const res = await authedFetch(`/api/email/threads/${threadId}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Failed to load thread');
    return data.data;
}

export async function markThreadRead(threadId: number): Promise<void> {
    await authedFetch(`/api/email/threads/${threadId}/read`, { method: 'POST' });
}

export async function composeEmail(formData: FormData): Promise<{ provider_message_id: string; provider_thread_id: string }> {
    const res = await authedFetch('/api/email/threads/compose', {
        method: 'POST',
        body: formData,
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Failed to send email');
    return data.data;
}

export async function replyToThread(threadId: number, formData: FormData): Promise<{ provider_message_id: string }> {
    const res = await authedFetch(`/api/email/threads/${threadId}/reply`, {
        method: 'POST',
        body: formData,
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Failed to send reply');
    return data.data;
}

export function getAttachmentDownloadUrl(attachmentId: number): string {
    return `/api/email/attachments/${attachmentId}/download`;
}
