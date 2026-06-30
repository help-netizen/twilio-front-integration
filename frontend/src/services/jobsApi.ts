/**
 * Jobs API Client — Local Albusto Jobs
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
    lead_serial_id?: number | null;
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
    city?: string | null;
    territory?: string;
    invoice_total?: string;
    invoice_status?: string;
    amount_paid?: string | null;
    balance_due?: string | null;
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

    /** Coordinates from Zenbooker service_address */
    lat?: number | null;
    lng?: number | null;

    /** Full Zenbooker job data for territory / timeslot access */
    zb_raw?: Record<string, any> | null;
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

// ─── Create Job (direct, no lead) ─────────────────────────────────────────────

export interface CreateJobBody {
    contact: { contact_id: number } | { name: string; phone: string; email?: string };
    address: {
        line1?: string;
        line2?: string;
        city?: string;
        state?: string;
        postal_code?: string;
        lat?: number | null;
        lng?: number | null;
    };
    slot: { start: string; end: string; tech_id?: string | null };
    job_type: string;
    description?: string;
    /** Lead source — shared with the New Lead form; stored in job.metadata.lead_source. */
    lead_source?: string;
    /** Additional-info custom fields — shared with New Lead; merged into job.metadata. */
    metadata?: Record<string, string>;
}

export interface CreateJobResult {
    job_id: number;
    zenbooker_job_id?: string;
    zb_warning?: string;
}

/** Create a job directly (without a lead). POST /api/jobs. */
export async function createJob(body: CreateJobBody): Promise<CreateJobResult> {
    return jobsRequest<CreateJobResult>(JOBS_BASE, {
        method: 'POST',
        body: JSON.stringify(body),
    });
}

export async function updateBlancStatus(id: number, blancStatus: string, options: { cancelReason?: string } = {}): Promise<LocalJob> {
    return jobsRequest<LocalJob>(`${JOBS_BASE}/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ blanc_status: blancStatus, cancel_reason: options.cancelReason }),
    });
}

export async function cancelJob(id: number, reason: string): Promise<void> {
    await jobsRequest(`${JOBS_BASE}/${id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
    });
}

// ─── ONWAY-001: "On the way" ETA estimate + notify ─────────────────────────────

/** Error carrying the backend `code` so the modal can map it to a friendly toast. */
export class EtaNotifyError extends Error {
    code: string | null;
    constructor(message: string, code: string | null) {
        super(message);
        this.name = 'EtaNotifyError';
        this.code = code;
    }
}

export interface EtaEstimateResult {
    eta_minutes: number | null;
}

export interface EtaNotifyResult {
    sent?: boolean;
    status?: string;
    /** Present (= 'status_not_advanced') when the SMS sent but the status didn't update. */
    warning?: string;
}

/**
 * Estimate the technician's travel-time ETA to the job address.
 * Posts device coords when available; with no fix the server still returns
 * `eta_minutes: null` (we send `{}`), so the modal can stay in state (c).
 */
export async function estimateEta(id: number, origin: { lat: number; lng: number } | null): Promise<EtaEstimateResult> {
    const data = await jobsRequest<{ eta_minutes: number | null }>(`${JOBS_BASE}/${id}/eta/estimate`, {
        method: 'POST',
        body: JSON.stringify(origin ? { origin } : {}),
    });
    return { eta_minutes: data?.eta_minutes ?? null };
}

/**
 * Notify the customer (outbound SMS) that the technician is on the way and
 * advance the job to "On the way". Returns `data` plus any non-blocking
 * `warning`. On failure throws an {@link EtaNotifyError} carrying the backend
 * `code` (NO_PHONE / NO_PROXY / WALLET_BLOCKED / SMS_FAILED / invalid_eta).
 */
export async function notifyEta(id: number, etaMinutes: number): Promise<EtaNotifyResult> {
    const res = await authedFetch(`${JOBS_BASE}/${id}/eta/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eta_minutes: etaMinutes }),
    });
    let json: any = {};
    try { json = await res.json(); } catch { /* non-JSON body */ }
    if (!res.ok || !json.ok) {
        const code = (json.code as string) || (json.error as string) || null;
        const message = (json.message as string) || (json.error as string) || `Request failed (${res.status})`;
        throw new EtaNotifyError(message, code);
    }
    return { ...(json.data || {}), warning: json.warning };
}

export async function rescheduleJob(id: number, data: { start_date: string; arrival_window_minutes?: number; tech_id?: string }): Promise<LocalJob> {
    return jobsRequest<LocalJob>(`${JOBS_BASE}/${id}/reschedule`, {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

/** Persist geocoded coordinates for a job */
export async function updateJobCoords(id: number | string, lat: number, lng: number): Promise<void> {
    await jobsRequest(`${JOBS_BASE}/${id}/coords`, {
        method: 'PATCH',
        body: JSON.stringify({ lat, lng }),
    });
}

// SCHED-ROUTE-001 FR-002: edit a job's service address (+ optional coords from
// AddressAutocomplete). Server re-geocodes if needed and recalcs route segments.
export async function updateJobLocation(
    id: number | string,
    data: { address?: string; lat?: number | null; lng?: number | null; normalized_address?: string | null; place_id?: string | null },
): Promise<LocalJob> {
    return jobsRequest<LocalJob>(`${JOBS_BASE}/${id}/location`, {
        method: 'PATCH',
        body: JSON.stringify(data),
    });
}

export async function addJobNote(id: number, text: string, files?: File[]): Promise<void> {
    if (files && files.length > 0) {
        const formData = new FormData();
        formData.append('text', text);
        files.forEach(f => formData.append('attachments', f));
        const res = await authedFetch(`${JOBS_BASE}/${id}/notes`, {
            method: 'POST',
            body: formData,
            // Don't set Content-Type — browser sets it with boundary for multipart
        });
        const json = await res.json();
        if (!res.ok || !json.ok) {
            throw new Error(json.error || `Upload failed (${res.status})`);
        }
    } else {
        await jobsRequest(`${JOBS_BASE}/${id}/notes`, {
            method: 'POST',
            body: JSON.stringify({ text }),
        });
    }
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
