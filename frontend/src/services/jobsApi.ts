/**
 * Jobs API Client — Local Blanc Jobs
 * Frontend fetch wrapper for /api/jobs endpoints (local DB).
 */

import { authedFetch } from './apiClient';

const JOBS_BASE = '/api/jobs';

// ─── Types ────────────────────────────────────────────────────────────────────

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
