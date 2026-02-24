/**
 * Jobs API Client — Local Blanc Jobs
 * Frontend fetch wrapper for /api/jobs endpoints (local DB).
 */

import { authedFetch } from './apiClient';

const JOBS_BASE = '/api/jobs';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface JobTag {
    id: number;
    name: string;
    color: string;
    is_active: boolean;
    sort_order?: number;
    archived_at?: string | null;
}

export interface LocalJob {
    id: number;
    lead_id: number | null;
    contact_id: number | null;
    zenbooker_job_id: string | null;

    blanc_status: string;
    zb_status: string;
    zb_rescheduled: boolean;
    zb_canceled: boolean;

    job_number?: string;
    service_name?: string;
    start_date?: string;
    end_date?: string;
    customer_name?: string;
    customer_phone?: string;
    customer_email?: string;
    address?: string;
    territory?: string;
    invoice_total?: string;
    invoice_status?: string;
    assigned_techs?: Array<{ id: string; name: string }>;
    notes?: Array<{ text: string; created: string }>;
    tags?: JobTag[];

    // Lead-like fields (unified)
    job_type?: string;
    job_source?: string;
    description?: string;
    metadata?: Record<string, string>;
    comments?: string;

    company_id?: string;
    created_at?: string;
    updated_at?: string;
}

export interface JobsListResult {
    results: LocalJob[];
    total: number;
    offset: number;
    limit: number;
    has_more: boolean;
}

export interface JobsListParams {
    blanc_status?: string;
    canceled?: string;
    search?: string;
    offset?: number;
    limit?: number;
    contact_id?: number;
    sort_by?: string;
    sort_order?: 'asc' | 'desc';
    only_open?: boolean;
    start_date?: string;
    end_date?: string;
    service_name?: string;
    provider?: string;
    tag_ids?: string;
    tag_match?: 'any' | 'all';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function jobsRequest<T>(url: string, options?: RequestInit): Promise<T> {
    const res = await authedFetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
    const json = await res.json();
    if (!res.ok || !json.ok) {
        throw new Error(json.error || `Request failed (${res.status})`);
    }
    return json.data as T;
}

// ─── API calls ────────────────────────────────────────────────────────────────

export async function listJobs(params: JobsListParams = {}): Promise<JobsListResult> {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== '' && value !== null) {
            qs.set(key, String(value));
        }
    }
    const query = qs.toString();
    return jobsRequest<JobsListResult>(`${JOBS_BASE}${query ? '?' + query : ''}`);
}

export async function getJob(id: number): Promise<LocalJob> {
    return jobsRequest<LocalJob>(`${JOBS_BASE}/${id}`);
}

export async function updateBlancStatus(id: number, blancStatus: string): Promise<LocalJob> {
    return jobsRequest<LocalJob>(`${JOBS_BASE}/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ blanc_status: blancStatus }),
    });
}

export async function cancelJob(id: number): Promise<void> {
    await jobsRequest(`${JOBS_BASE}/${id}/cancel`, { method: 'POST' });
}

export async function addJobNote(id: number, text: string): Promise<void> {
    await jobsRequest(`${JOBS_BASE}/${id}/notes`, {
        method: 'POST',
        body: JSON.stringify({ text }),
    });
}

export async function markEnroute(id: number): Promise<void> {
    await jobsRequest(`${JOBS_BASE}/${id}/enroute`, { method: 'POST' });
}

export async function markInProgress(id: number): Promise<void> {
    await jobsRequest(`${JOBS_BASE}/${id}/start`, { method: 'POST' });
}

export async function markComplete(id: number): Promise<void> {
    await jobsRequest(`${JOBS_BASE}/${id}/complete`, { method: 'POST' });
}

export async function updateJobTags(id: number, tagIds: number[]): Promise<LocalJob> {
    return jobsRequest<LocalJob>(`${JOBS_BASE}/${id}/tags`, {
        method: 'PATCH',
        body: JSON.stringify({ tag_ids: tagIds }),
    });
}

// ─── Tag Settings API ─────────────────────────────────────────────────────────

const TAGS_BASE = '/api/settings/job-tags';

export async function listJobTags(): Promise<JobTag[]> {
    return jobsRequest<JobTag[]>(TAGS_BASE);
}

export async function createJobTag(name: string, color: string): Promise<JobTag> {
    return jobsRequest<JobTag>(TAGS_BASE, {
        method: 'POST',
        body: JSON.stringify({ name, color }),
    });
}

export async function updateJobTag(id: number, data: Partial<{ name: string; color: string; is_active: boolean }>): Promise<JobTag> {
    return jobsRequest<JobTag>(`${TAGS_BASE}/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
    });
}

export async function reorderJobTags(orderedIds: number[]): Promise<JobTag[]> {
    return jobsRequest<JobTag[]>(`${TAGS_BASE}/reorder`, {
        method: 'POST',
        body: JSON.stringify({ ordered_ids: orderedIds }),
    });
}

export async function archiveJobTag(id: number): Promise<JobTag> {
    return jobsRequest<JobTag>(`${TAGS_BASE}/${id}`, {
        method: 'DELETE',
    });
}

// ─── Jobs List Fields (column config) API ─────────────────────────────────────

const FIELDS_BASE = '/api/settings/jobs-list-fields';

export async function getJobsListFields(): Promise<string[]> {
    const res = await authedFetch(FIELDS_BASE);
    const json = await res.json();
    return json.ordered_visible_fields || [];
}

export async function saveJobsListFields(fields: string[]): Promise<string[]> {
    const res = await authedFetch(FIELDS_BASE, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ordered_visible_fields: fields }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Failed to save');
    return json.ordered_visible_fields;
}
