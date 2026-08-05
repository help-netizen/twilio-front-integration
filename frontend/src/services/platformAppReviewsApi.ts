import { authedFetch } from './apiClient';

const API_BASE = '/api/platform/app-reviews';

export type AppVersionQueueStatus = 'pending' | 'published' | 'rejected' | 'revoked';

/** The capability surface a version declares — what moderation reviews. */
export type AppCadence =
    | { kind: 'every_minutes'; n: number }
    | { kind: 'hourly'; minute: number }
    | { kind: 'daily'; at: string }
    | { kind: 'weekly'; dow: number; at: string }
    | { kind: 'monthly'; dom: number; at: string };
export interface AppDataCollection { name: string; key_fields: string[]; columns: Array<{ key: string; type: string }> }
export interface AppConnection { name: string; base_url: string; auth: { kind: string; header?: string } }
export interface AppSettingField { key: string; label: string; type: string; required?: boolean; options?: string[] }
export type AppVersionStatus =
    | 'draft'
    | 'submitted'
    | 'in_review'
    | 'approved'
    | 'rejected'
    | 'published'
    | 'revoked';

export interface AppVersionReviewRequest {
    version_id: string;
    app_id: string;
    version_number: string;
    status: AppVersionStatus;
    submitted_at: string | null;
    created_at: string;
    reviewed_at: string | null;
    published_at: string | null;
    rejection_reason: string | null;
    app_key: string;
    app_name: string;
    app_type: string;
    company_id: string;
    company_name: string;
    company_timezone: string;
}

export interface AppVersionTransitionResult {
    id: string;
    app_id: string;
    version_number: string;
    status: AppVersionStatus;
}

export interface AppVersionReviewDetail {
    version: AppVersionTransitionResult & {
        source_sha256: string;
        scanner_report: Record<string, unknown>;
        sandbox_run: Record<string, unknown> | null;
        created_at: string;
        submitted_at: string | null;
        reviewed_at: string | null;
        published_at: string | null;
        rejection_reason: string | null;
        // A tool carries its kind now (read vs write) so moderation can flag
        // the writes; the backend started returning objects when create_task
        // landed, and this type trailed it.
        tools: Array<{ name: string; kind: 'read' | 'write' }>;
        suggested_schedule: AppCadence | null;
        data_collections: AppDataCollection[];
        actions: Array<{ id: string; label: string }>;
        subscribes: string[];
        connections: AppConnection[];
        settings: AppSettingField[];
        source_code?: string;
    };
    app: {
        id: string;
        app_key: string;
        name: string;
        provider_name: string;
        category: string;
        app_type: string;
        short_description: string;
        long_description: string | null;
        logo_url: string | null;
        requested_scopes: unknown[];
        metadata: Record<string, unknown>;
    };
    company: { id: string; name: string; timezone: string };
    previous_version: {
        id: string;
        version_number: string;
        status: AppVersionStatus;
        source_sha256: string;
    } | null;
    source_diff: {
        lines: Array<{
            type: 'context' | 'removed' | 'added';
            old_line: number | null;
            new_line: number | null;
            text: string;
        }>;
        truncated: boolean;
        added_lines: number;
        removed_lines: number;
    };
    chats: Array<{
        id: string;
        title: string;
        created_at: string;
        messages: Array<{
            id: string;
            role: 'user' | 'assistant';
            text: string;
            model: string | null;
            token_usage: Record<string, number>;
            version_id: string | null;
            created_at: string;
        }>;
    }>;
}

interface ErrorPayload {
    message?: string;
    code?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await authedFetch(`${API_BASE}${path}`, {
        ...init,
        headers: {
            'Content-Type': 'application/json',
            ...(init?.headers || {}),
        },
    });
    const payload = await response.json().catch(() => ({} as ErrorPayload));
    if (!response.ok) {
        throw new Error((payload as ErrorPayload).message || `Request failed: ${response.status}`);
    }
    return payload as T;
}

export async function listAppVersionReviews(status: AppVersionQueueStatus): Promise<{
    requests: AppVersionReviewRequest[];
    total: number;
}> {
    return request(`?status=${status}`);
}

export async function getAppVersionReview(
    versionId: string,
    includeCode = false,
): Promise<AppVersionReviewDetail> {
    const payload = await request<{ review: AppVersionReviewDetail }>(
        `/${encodeURIComponent(versionId)}${includeCode ? '?include_code=true' : ''}`,
    );
    return payload.review;
}

async function transition(
    versionId: string,
    action: 'start-review' | 'approve' | 'reject' | 'revoke',
    reason?: string,
): Promise<AppVersionTransitionResult> {
    const payload = await request<{ version: AppVersionTransitionResult }>(
        `/${encodeURIComponent(versionId)}/${action}`,
        {
            method: 'POST',
            body: JSON.stringify(reason === undefined ? {} : { reason }),
        },
    );
    return payload.version;
}

export const startAppVersionReview = (versionId: string) => transition(versionId, 'start-review');
export const approveAppVersion = (versionId: string) => transition(versionId, 'approve');
export const rejectAppVersion = (versionId: string, reason: string) => (
    transition(versionId, 'reject', reason)
);
export const revokeAppVersion = (versionId: string) => transition(versionId, 'revoke');
