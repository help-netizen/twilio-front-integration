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
    item_type?: string | null;
    category_id?: number | null;
    price_book_item_id?: number | null;
}

export type EstimateStatus = 'draft' | 'sent' | 'viewed' | 'approved' | 'declined';
export type EstimateDiscountType = 'fixed' | 'percentage' | null;

export interface Estimate {
    id: number;
    company_id: string;
    estimate_number: string;
    status: EstimateStatus;
    contact_id: number | null;
    lead_id: number | null;
    job_id: number | null;
    title: string | null;
    summary: string | null;
    notes: string | null;
    internal_note: string | null;
    subtotal: string;
    tax_rate: string;
    tax_amount: string;
    discount_amount: string;
    discount_type: EstimateDiscountType;
    discount_value: string;
    total: string;
    currency: string;
    deposit_required: boolean;
    deposit_type: string | null;
    deposit_value: string | null;
    deposit_paid: string;
    signature_required: boolean;
    signature_name?: string | null;
    signature_consented_at?: string | null;
    approved_snapshot?: any;
    signed_at: string | null;
    valid_until: string | null;
    sent_at: string | null;
    accepted_at: string | null;
    declined_at: string | null;
    created_by: string | null;
    updated_by: string | null;
    created_at: string;
    updated_at: string;
    archived_at?: string | null;
    archived_by?: string | null;
    estimate_sequence?: number;
    items?: EstimateItem[];
    contact_name?: string;
    contact_email?: string | null;
    contact_phone?: string | null;
    billing_address?: string | null;
    service_address?: string | null;
    job_number?: string | null;
    invoice_id?: number | null;
    invoice_number?: string | null;
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
    include_archived?: boolean;
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
    summary?: string | null;
    notes?: string;
    internal_note?: string;
    tax_rate?: string;
    discount_type?: EstimateDiscountType;
    discount_value?: string;
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
    message: string;
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

/**
 * Error carrying the server-supplied `code`/`status` so the send dialog can branch
 * (409 MAILBOX_NOT_CONNECTED, 402 WALLET_BLOCKED, 422 NO_PROXY|NO_PHONE, 400 VALIDATION).
 */
export class EstimateApiError extends Error {
    code: string;
    status: number;
    constructor(message: string, code: string, status: number) {
        super(message);
        this.name = 'EstimateApiError';
        this.code = code;
        this.status = status;
    }
}

/**
 * Like `estimatesRequest`, but throws an `EstimateApiError` that preserves the
 * server `error.code` (the plain helper collapses everything to a generic Error,
 * losing the code the send dialog needs to map 409/402/422 → the right toast).
 */
async function estimatesRequestTyped<T>(url: string, options?: RequestInit): Promise<T> {
    const res = await authedFetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* non-JSON error body */ }
    if (!res.ok || !json?.ok) {
        const code = json?.error?.code ?? 'INTERNAL';
        const message = json?.error?.message ?? `Estimates API error ${res.status}`;
        throw new EstimateApiError(message, code, res.status);
    }
    return json.data as T;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function fetchEstimates(filters: EstimatesListParams = {}): Promise<EstimatesListResult> {
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.contact_id) params.set('contact_id', String(filters.contact_id));
    if (filters.lead_id) params.set('lead_id', String(filters.lead_id));
    if (filters.job_id) params.set('job_id', String(filters.job_id));
    if (filters.search) params.set('search', filters.search);
    if (filters.include_archived) params.set('include_archived', 'true');
    if (filters.limit != null) params.set('limit', String(filters.limit));
    if (filters.page != null && filters.limit != null) {
        params.set('offset', String(Math.max(filters.page - 1, 0) * filters.limit));
    }
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

export async function archiveEstimate(id: number): Promise<Estimate> {
    return estimatesRequest<Estimate>(`${ESTIMATES_BASE}/${id}/archive`, { method: 'POST' });
}

export async function restoreEstimate(id: number): Promise<Estimate> {
    return estimatesRequest<Estimate>(`${ESTIMATES_BASE}/${id}/restore`, { method: 'POST' });
}

export async function sendEstimate(id: number, data: EstimateSendData): Promise<Estimate> {
    // Typed request so the dialog can surface 409/402/422 via EstimateApiError.code.
    return estimatesRequestTyped<Estimate>(`${ESTIMATES_BASE}/${id}/send`, {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

/**
 * Mint (or fetch) the tokenized public link for an estimate — `POST /api/estimates/:id/public-link`
 * → `{ url }`. Idempotent on the backend (re-send reuses the same token). Mirrors `ensureInvoicePublicLink`.
 */
export async function ensureEstimatePublicLink(id: number): Promise<{ token: string; url: string }> {
    return estimatesRequestTyped<{ token: string; url: string }>(`${ESTIMATES_BASE}/${id}/public-link`, {
        method: 'POST',
    });
}

export async function approveEstimate(id: number, data: { actor_type?: string; signature_name?: string; signature_consent?: boolean } = {}): Promise<Estimate> {
    return estimatesRequest<Estimate>(`${ESTIMATES_BASE}/${id}/approve`, {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

export async function declineEstimate(id: number, reason: string): Promise<Estimate> {
    return estimatesRequest<Estimate>(`${ESTIMATES_BASE}/${id}/decline`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
    });
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

// PRICEBOOK-001: bulk add (a Price Book group expanded into its items) — one call.
export async function addEstimateItemsBulk(estimateId: number, items: EstimateItemCreateData[]): Promise<{ added: number }> {
    return estimatesRequest<{ added: number }>(`${ESTIMATES_BASE}/${estimateId}/items/bulk`, {
        method: 'POST',
        body: JSON.stringify({ items }),
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
