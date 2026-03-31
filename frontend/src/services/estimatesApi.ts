/**
 * Estimates API Client
 * Frontend fetch wrapper for /api/estimates endpoints.
 */

import { authedFetch } from './apiClient';

const ESTIMATES_BASE = '/api/estimates';

// ── Types ────────────────────────────────────────────────────────────────────

export interface EstimateItem {
    id: number;
    estimate_id: number;
    sort_order: number;
    name: string;
    description: string | null;
    quantity: string;
    unit: string | null;
    unit_price: string;
    amount: string;
    taxable: boolean;
    metadata: any;
}

export interface Estimate {
    id: number;
    company_id: string;
    estimate_number: string;
    status: 'draft' | 'sent' | 'viewed' | 'accepted' | 'declined' | 'expired' | 'converted';
    contact_id: number | null;
    lead_id: number | null;
    job_id: number | null;
    title: string | null;
    notes: string | null;
    internal_note: string | null;
    subtotal: string;
    tax_rate: string;
    tax_amount: string;
    discount_amount: string;
    total: string;
    currency: string;
    deposit_required: boolean;
    deposit_type: string | null;
    deposit_value: string | null;
    deposit_paid: string;
    signature_required: boolean;
    signed_at: string | null;
    valid_until: string | null;
    sent_at: string | null;
    accepted_at: string | null;
    declined_at: string | null;
    created_by: string | null;
    updated_by: string | null;
    created_at: string;
    updated_at: string;
    items?: EstimateItem[];
    contact_name?: string;
}

export interface EstimateEvent {
    id: number;
    estimate_id: number;
    event_type: string;
    actor_type: string;
    actor_id: string | null;
    metadata: any;
    created_at: string;
}

export interface EstimateRevision {
    id: number;
    estimate_id: number;
    revision_number: number;
    snapshot: any;
    created_by: string | null;
    created_at: string;
}

export interface EstimatesListParams {
    status?: string;
    contact_id?: number;
    lead_id?: number;
    job_id?: number;
    search?: string;
    page?: number;
    limit?: number;
}

export interface EstimatesListResult {
    estimates: Estimate[];
    total: number;
    page: number;
    limit: number;
}

export interface EstimateCreateData {
    contact_id?: number | null;
    lead_id?: number | null;
    job_id?: number | null;
    title?: string;
    notes?: string;
    internal_note?: string;
    tax_rate?: string;
    discount_amount?: string;
    currency?: string;
    deposit_required?: boolean;
    deposit_type?: string | null;
    deposit_value?: string | null;
    signature_required?: boolean;
    valid_until?: string | null;
    items?: Omit<EstimateItem, 'id' | 'estimate_id'>[];
}

export interface EstimateSendData {
    channel: 'email' | 'sms';
    recipient: string;
    message?: string;
}

export interface EstimateItemCreateData {
    name: string;
    description?: string | null;
    quantity: string;
    unit?: string | null;
    unit_price: string;
    taxable?: boolean;
    sort_order?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface ApiResponse<T> {
    ok: boolean;
    data: T;
    error?: { code: string; message: string };
}

async function estimatesRequest<T>(url: string, options?: RequestInit): Promise<T> {
    const res = await authedFetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
    const json: ApiResponse<T> = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.error?.message || `Estimates API error ${res.status}`);
    return json.data;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function fetchEstimates(filters: EstimatesListParams = {}): Promise<EstimatesListResult> {
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.contact_id) params.set('contact_id', String(filters.contact_id));
    if (filters.lead_id) params.set('lead_id', String(filters.lead_id));
    if (filters.job_id) params.set('job_id', String(filters.job_id));
    if (filters.search) params.set('search', filters.search);
    if (filters.page != null) params.set('page', String(filters.page));
    if (filters.limit != null) params.set('limit', String(filters.limit));
    const qs = params.toString();
    const raw = await estimatesRequest<any>(`${ESTIMATES_BASE}${qs ? `?${qs}` : ''}`);
    return {
        estimates: raw.rows ?? raw.estimates ?? [],
        total: raw.total ?? 0,
        page: filters.page ?? 1,
        limit: filters.limit ?? 50,
    };
}

export async function fetchEstimate(id: number): Promise<Estimate> {
    return estimatesRequest<Estimate>(`${ESTIMATES_BASE}/${id}`);
}

export async function createEstimate(data: EstimateCreateData): Promise<Estimate> {
    return estimatesRequest<Estimate>(ESTIMATES_BASE, {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

export async function updateEstimate(id: number, data: Partial<EstimateCreateData>): Promise<Estimate> {
    return estimatesRequest<Estimate>(`${ESTIMATES_BASE}/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
    });
}

export async function deleteEstimate(id: number): Promise<void> {
    await estimatesRequest<void>(`${ESTIMATES_BASE}/${id}`, { method: 'DELETE' });
}

export async function sendEstimate(id: number, data: EstimateSendData): Promise<Estimate> {
    return estimatesRequest<Estimate>(`${ESTIMATES_BASE}/${id}/send`, {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

export async function approveEstimate(id: number): Promise<Estimate> {
    return estimatesRequest<Estimate>(`${ESTIMATES_BASE}/${id}/approve`, { method: 'POST' });
}

export async function declineEstimate(id: number): Promise<Estimate> {
    return estimatesRequest<Estimate>(`${ESTIMATES_BASE}/${id}/decline`, { method: 'POST' });
}

export async function linkJobToEstimate(id: number, jobId: number): Promise<Estimate> {
    return estimatesRequest<Estimate>(`${ESTIMATES_BASE}/${id}/link-job`, {
        method: 'POST',
        body: JSON.stringify({ job_id: jobId }),
    });
}

export async function addEstimateItem(estimateId: number, item: EstimateItemCreateData): Promise<EstimateItem> {
    return estimatesRequest<EstimateItem>(`${ESTIMATES_BASE}/${estimateId}/items`, {
        method: 'POST',
        body: JSON.stringify(item),
    });
}

export async function updateEstimateItem(estimateId: number, itemId: number, data: Partial<EstimateItemCreateData>): Promise<EstimateItem> {
    return estimatesRequest<EstimateItem>(`${ESTIMATES_BASE}/${estimateId}/items/${itemId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
    });
}

export async function deleteEstimateItem(estimateId: number, itemId: number): Promise<void> {
    await estimatesRequest<void>(`${ESTIMATES_BASE}/${estimateId}/items/${itemId}`, { method: 'DELETE' });
}

export async function fetchEstimateEvents(id: number): Promise<EstimateEvent[]> {
    return estimatesRequest<EstimateEvent[]>(`${ESTIMATES_BASE}/${id}/events`);
}

export async function fetchEstimateRevisions(id: number): Promise<EstimateRevision[]> {
    return estimatesRequest<EstimateRevision[]>(`${ESTIMATES_BASE}/${id}/revisions`);
}

export async function convertEstimateToInvoice(id: number): Promise<import('./invoicesApi').Invoice> {
    return estimatesRequest<import('./invoicesApi').Invoice>(`${ESTIMATES_BASE}/${id}/convert`, { method: 'POST' });
}
