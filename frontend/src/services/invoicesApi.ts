/**
 * Invoices API Client
 * Frontend fetch wrapper for /api/invoices endpoints.
 */

import { authedFetch } from './apiClient';

const INVOICES_BASE = '/api/invoices';

// ── Types ────────────────────────────────────────────────────────────────────

export interface InvoiceItem {
    id: number;
    invoice_id: number;
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

export interface Invoice {
    id: number;
    company_id: string;
    invoice_number: string;
    status: 'draft' | 'sent' | 'viewed' | 'partial' | 'paid' | 'overdue' | 'void' | 'refunded';
    contact_id: number | null;
    lead_id: number | null;
    job_id: number | null;
    estimate_id: number | null;
    title: string | null;
    notes: string | null;
    internal_note: string | null;
    subtotal: string;
    tax_rate: string;
    tax_amount: string;
    discount_amount: string;
    total: string;
    amount_paid: string;
    balance_due: string;
    currency: string;
    payment_terms: string | null;
    due_date: string | null;
    sent_at: string | null;
    paid_at: string | null;
    voided_at: string | null;
    created_by: string | null;
    updated_by: string | null;
    created_at: string;
    updated_at: string;
    items?: InvoiceItem[];
    contact_name?: string;
}

export interface InvoiceEvent {
    id: number;
    invoice_id: number;
    event_type: string;
    actor_type: string;
    actor_id: string | null;
    metadata: any;
    created_at: string;
}

export interface InvoiceRevision {
    id: number;
    invoice_id: number;
    revision_number: number;
    snapshot: any;
    created_by: string | null;
    created_at: string;
}

export interface InvoicesListParams {
    status?: string;
    contact_id?: number;
    lead_id?: number;
    job_id?: number;
    estimate_id?: number;
    search?: string;
    page?: number;
    limit?: number;
}

export interface InvoicesListResult {
    invoices: Invoice[];
    total: number;
    page: number;
    limit: number;
}

export interface InvoiceCreateData {
    contact_id?: number | null;
    lead_id?: number | null;
    job_id?: number | null;
    estimate_id?: number | null;
    title?: string;
    notes?: string;
    internal_note?: string;
    tax_rate?: string;
    discount_amount?: string;
    currency?: string;
    payment_terms?: string | null;
    due_date?: string | null;
    items?: Omit<InvoiceItem, 'id' | 'invoice_id'>[];
}

export interface InvoiceSendData {
    channel: 'email' | 'sms';
    recipient: string;
    message?: string;
}

export interface RecordPaymentData {
    amount: string;
    payment_method?: string;
    reference?: string;
}

export interface InvoiceItemCreateData {
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

async function invoicesRequest<T>(url: string, options?: RequestInit): Promise<T> {
    const res = await authedFetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
    const json: ApiResponse<T> = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.error?.message || `Invoices API error ${res.status}`);
    return json.data;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function fetchInvoices(filters: InvoicesListParams = {}): Promise<InvoicesListResult> {
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.contact_id) params.set('contact_id', String(filters.contact_id));
    if (filters.lead_id) params.set('lead_id', String(filters.lead_id));
    if (filters.job_id) params.set('job_id', String(filters.job_id));
    if (filters.estimate_id) params.set('estimate_id', String(filters.estimate_id));
    if (filters.search) params.set('search', filters.search);
    if (filters.page != null) params.set('page', String(filters.page));
    if (filters.limit != null) params.set('limit', String(filters.limit));
    const qs = params.toString();
    const raw = await invoicesRequest<any>(`${INVOICES_BASE}${qs ? `?${qs}` : ''}`);
    return {
        invoices: raw.rows ?? raw.invoices ?? [],
        total: raw.total ?? 0,
        page: filters.page ?? 1,
        limit: filters.limit ?? 50,
    };
}

export async function fetchInvoice(id: number): Promise<Invoice> {
    return invoicesRequest<Invoice>(`${INVOICES_BASE}/${id}`);
}

export async function createInvoice(data: InvoiceCreateData): Promise<Invoice> {
    return invoicesRequest<Invoice>(INVOICES_BASE, {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

export async function updateInvoice(id: number, data: Partial<InvoiceCreateData>): Promise<Invoice> {
    return invoicesRequest<Invoice>(`${INVOICES_BASE}/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
    });
}

export async function deleteInvoice(id: number): Promise<void> {
    await invoicesRequest<void>(`${INVOICES_BASE}/${id}`, { method: 'DELETE' });
}

export async function sendInvoice(id: number, data: InvoiceSendData): Promise<Invoice> {
    return invoicesRequest<Invoice>(`${INVOICES_BASE}/${id}/send`, {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

export async function voidInvoice(id: number): Promise<Invoice> {
    return invoicesRequest<Invoice>(`${INVOICES_BASE}/${id}/void`, { method: 'POST' });
}

export async function recordPayment(id: number, data: RecordPaymentData): Promise<Invoice> {
    return invoicesRequest<Invoice>(`${INVOICES_BASE}/${id}/payments`, {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

export async function syncItemsFromEstimate(id: number): Promise<Invoice> {
    return invoicesRequest<Invoice>(`${INVOICES_BASE}/${id}/sync-estimate`, { method: 'POST' });
}

export async function addInvoiceItem(invoiceId: number, item: InvoiceItemCreateData): Promise<InvoiceItem> {
    return invoicesRequest<InvoiceItem>(`${INVOICES_BASE}/${invoiceId}/items`, {
        method: 'POST',
        body: JSON.stringify(item),
    });
}

export async function updateInvoiceItem(invoiceId: number, itemId: number, data: Partial<InvoiceItemCreateData>): Promise<InvoiceItem> {
    return invoicesRequest<InvoiceItem>(`${INVOICES_BASE}/${invoiceId}/items/${itemId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
    });
}

export async function deleteInvoiceItem(invoiceId: number, itemId: number): Promise<void> {
    await invoicesRequest<void>(`${INVOICES_BASE}/${invoiceId}/items/${itemId}`, { method: 'DELETE' });
}

export async function fetchInvoiceEvents(id: number): Promise<InvoiceEvent[]> {
    return invoicesRequest<InvoiceEvent[]>(`${INVOICES_BASE}/${id}/events`);
}

export async function fetchInvoiceRevisions(id: number): Promise<InvoiceRevision[]> {
    return invoicesRequest<InvoiceRevision[]>(`${INVOICES_BASE}/${id}/revisions`);
}

export async function fetchInvoicePayments(id: number): Promise<any[]> {
    return invoicesRequest<any[]>(`${INVOICES_BASE}/${id}/payments`);
}
