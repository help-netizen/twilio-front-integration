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

// ─── Timeline composer (EMAIL-TIMELINE-001 / ET-8) ─────────────────────────

/**
 * Lightweight mailbox-connection status for the timeline composer.
 * GET /api/email/timeline/mailbox-status → { ok, data:{ connected, email_address } }.
 * Needs only `messages.send` (unlike getWorkspaceMailbox, which requires
 * `messages.view_internal`), so a send-only agent sees the real connect state.
 * Never throws — any failure degrades to { connected:false } (shows the connect-CTA).
 */
export async function getTimelineMailboxStatus(): Promise<{ connected: boolean; email_address: string | null }> {
    try {
        const res = await authedFetch('/api/email/timeline/mailbox-status');
        const data = await res.json();
        if (!res.ok || !data?.ok) return { connected: false, email_address: null };
        return {
            connected: data.data?.connected === true,
            email_address: data.data?.email_address ?? null,
        };
    } catch {
        return { connected: false, email_address: null };
    }
}



/** Error carrying the server-supplied `code` so callers can branch (e.g. 409 → connect Gmail). */
export class TimelineEmailError extends Error {
    code: string;
    status: number;
    constructor(message: string, code: string, status: number) {
        super(message);
        this.name = 'TimelineEmailError';
        this.code = code;
        this.status = status;
    }
}

/**
 * Send an email from the contact timeline composer.
 * POST /api/email/timeline/contacts/:contactId/send → { ok, data:<emailItem> }.
 * Throws TimelineEmailError with the server `code` on failure
 * (409 MAILBOX_NOT_CONNECTED, 404, 422 EMAIL_NOT_ON_CONTACT).
 */
export async function sendTimelineEmail(
    contactId: number,
    payload: { body: string; toEmail: string },
): Promise<EmailMessage> {
    const res = await authedFetch(`/api/email/timeline/contacts/${contactId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    let data: any = null;
    try { data = await res.json(); } catch { /* non-JSON error body */ }
    if (!res.ok || !data?.ok) {
        // Backend returns the nested envelope { ok:false, error:{ code, message } }.
        // Parse it (with flat/string fallbacks) so the real server code reaches callers
        // (e.g. 409 MAILBOX_NOT_CONNECTED → the "connect Google email" toast).
        const code = data?.error?.code ?? data?.code ?? 'EMAIL_SEND_FAILED';
        const message =
            data?.error?.message ??
            (typeof data?.error === 'string' ? data.error : undefined) ??
            data?.message ??
            'Failed to send email';
        throw new TimelineEmailError(message, code, res.status);
    }
    return data.data;
}
