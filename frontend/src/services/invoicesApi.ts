/**
 * Invoices API Client
 * Frontend fetch wrapper for /api/invoices endpoints.
 */

import { authedFetch } from './apiClient';
import type { OrderListApiPart } from './estimatesApi';
import type { PaymentTransaction } from './paymentsCanonicalApi';

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
    public_code?: string | null;   // INVOICE-ESTIMATE-NUMBERING-001: durable /invoices/:code
    status: 'draft' | 'sent' | 'viewed' | 'partial' | 'paid' | 'overdue' | 'void' | 'refunded';
    contact_id: number | null;
    lead_id: number | null;
    job_id: number | null;
    estimate_id: number | null;
    title: string | null;
    notes: string | null;
    internal_note: string | null;
    order_list?: OrderListApiPart[] | null;
    subtotal: string;
    tax_rate: string;
    tax_amount: string;
    discount_amount: string;
    /** Percentage discounts round-trip since migration 287 — same shape as estimates. */
    discount_type?: 'fixed' | 'percentage' | null;
    discount_value?: string | null;
    /**
     * OB-70: money on this invoice's job that no invoice is showing — 0 when this is the
     * job's only active invoice, because then it is already counted here. Without it the
     * card says Paid $0.00 while the job says Paid $462.00 and nothing explains the gap.
     */
    job_unapplied_credit?: string | null;
    total: string;
    amount_paid: string;
    balance_due: string;
    /** Native Job-pool money allocated by the live invoice serializer. */
    job_payment_allocated?: string;
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
    contact_email?: string | null;
    contact_phone?: string | null;
    lead_serial_id?: number | string | null;
    job_number?: string | null;
    job_seq?: number | null;
}

export type HydratedInvoice = Invoice & {
    items: InvoiceItem[];
    readonly __itemsHydrated: true;
};

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
    offset?: number;
    limit?: number;
}

export interface InvoicesListResult {
    invoices: Invoice[];
    total: number;
    page: number;
    limit: number;
}

export function invoicePageOffset(page: number, limit: number): number {
    return (Math.max(1, page) - 1) * Math.max(1, limit);
}

export interface InvoiceCreateData {
    contact_id?: number | null;
    lead_id?: number | null;
    job_id?: number | null;
    estimate_id?: number | null;
    /** AI-GEN-LOG-002: set when this document was born from an AI draft. */
    ai_generation_id?: number | null;
    title?: string;
    notes?: string;
    internal_note?: string;
    tax_rate?: string;
    discount_amount?: string;
    discount_type?: 'fixed' | 'percentage' | null;
    discount_value?: string | null;
    currency?: string;
    payment_terms?: string | null;
    due_date?: string | null;
    items?: Omit<InvoiceItem, 'id' | 'invoice_id'>[];
    order_list?: OrderListApiPart[];
}

export interface InvoiceSendData {
    channel: 'email' | 'sms';
    recipient: string;
    message?: string;
    includePaymentLink?: boolean;
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
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...options?.headers,
        },
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
    if (filters.offset != null) params.set('offset', String(filters.offset));
    if (filters.limit != null) params.set('limit', String(filters.limit));
    const qs = params.toString();
    const raw = await invoicesRequest<any>(`${INVOICES_BASE}${qs ? `?${qs}` : ''}`);
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;
    return {
        invoices: raw.rows ?? raw.invoices ?? [],
        total: raw.total ?? 0,
        page: Math.floor(offset / limit) + 1,
        limit,
    };
}

export async function fetchInvoice(id: number): Promise<Invoice> {
    return invoicesRequest<Invoice>(`${INVOICES_BASE}/${id}`);
}

/** Resolve a durable global invoice code → the invoice (INVOICE-ESTIMATE-NUMBERING-001). */
export async function getInvoiceByCode(code: string): Promise<Invoice> {
    return invoicesRequest<Invoice>(`${INVOICES_BASE}/by-code/${encodeURIComponent(code)}`);
}

export class InvoiceItemsNotHydratedError extends Error {
    constructor() {
        super('Reload the full invoice before replacing its line items.');
        this.name = 'InvoiceItemsNotHydratedError';
    }
}

export function isHydratedInvoice(invoice: Invoice | null | undefined): invoice is HydratedInvoice {
    return !!invoice
        && Array.isArray(invoice.items)
        && (invoice as Partial<HydratedInvoice>).__itemsHydrated === true;
}

function markInvoiceHydrated(invoice: Invoice): HydratedInvoice {
    if (!Array.isArray(invoice.items)) throw new InvoiceItemsNotHydratedError();
    return { ...invoice, items: invoice.items, __itemsHydrated: true };
}

/** The detail endpoint is the only invoice read contract that includes line items. */
export async function fetchHydratedInvoice(id: number): Promise<HydratedInvoice> {
    const invoice = await fetchInvoice(id);
    return markInvoiceHydrated(invoice);
}

/** Reuse an already-hydrated invoice; otherwise replace a list summary with detail. */
export async function hydrateInvoice(invoice: Invoice): Promise<HydratedInvoice> {
    return isHydratedInvoice(invoice) ? invoice : fetchHydratedInvoice(invoice.id);
}

export async function createInvoice(data: InvoiceCreateData): Promise<Invoice> {
    return invoicesRequest<Invoice>(INVOICES_BASE, {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

export async function updateInvoice(id: number, data: Partial<InvoiceCreateData>): Promise<HydratedInvoice> {
    if (Array.isArray(data.items)) throw new InvoiceItemsNotHydratedError();
    const updated = await invoicesRequest<Invoice>(`${INVOICES_BASE}/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
    });
    return markInvoiceHydrated(updated);
}

/**
 * Whole-array item replacement is intentionally reachable only through a full
 * invoice. The matching request header is enforced again by the backend route.
 */
export async function updateHydratedInvoice(
    invoice: HydratedInvoice,
    data: Partial<InvoiceCreateData>,
): Promise<HydratedInvoice> {
    if (!isHydratedInvoice(invoice)) throw new InvoiceItemsNotHydratedError();
    const updated = await invoicesRequest<Invoice>(`${INVOICES_BASE}/${invoice.id}`, {
        method: 'PUT',
        headers: { 'X-Invoice-Items-Hydrated': 'true' },
        body: JSON.stringify(data),
    });
    return markInvoiceHydrated(updated);
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

/**
 * OB-70 — taking an invoice off a job without losing the money.
 *
 * Two calls on purpose. The confirm has to state the figure that would be detached and
 * name the invoice it could go to instead, so it asks the server first; only then does
 * it act, carrying the dispatcher's answer. The server never picks the destination.
 */
export interface InvoiceRemovalCandidate {
    id: number;
    invoice_number: string;
    balance_due: string;
}

export interface InvoiceRemovalPreview {
    /** What removing it does to the record: a pristine draft goes, anything else is voided. */
    disposition: 'deleted' | 'voided';
    /** Money currently applied to this invoice, refunds netted. */
    payments_total: string;
    payments_count: number;
    /** The one invoice the money could move to instead, or null — never applied without an answer. */
    candidate: InvoiceRemovalCandidate | null;
    /** Echoed back on remove; a stale one is refused rather than acted on. */
    preview_version: string;
}

export interface InvoiceRemovalChoice {
    payment_action: 'leave_unapplied' | 'apply';
    target_invoice_id?: number;
    preview_version: string;
    /** Client-generated, so a double submit removes once. */
    request_id: string;
}

export async function previewInvoiceRemoval(id: number): Promise<InvoiceRemovalPreview> {
    return invoicesRequest<InvoiceRemovalPreview>(`${INVOICES_BASE}/${id}/removal-preview`);
}

export async function removeInvoice(id: number, choice: InvoiceRemovalChoice): Promise<void> {
    await invoicesRequest<void>(`${INVOICES_BASE}/${id}/remove`, {
        method: 'POST',
        body: JSON.stringify(choice),
    });
}

export async function ensureInvoicePublicLink(id: number): Promise<{ token: string; url: string }> {
    return invoicesRequest<{ token: string; url: string }>(`${INVOICES_BASE}/${id}/public-link`, {
        method: 'POST',
    });
}

export async function syncItemsFromEstimate(id: number): Promise<Invoice> {
    return invoicesRequest<Invoice>(`${INVOICES_BASE}/${id}/sync-items`, { method: 'POST' });
}

export async function addInvoiceItem(invoiceId: number, item: InvoiceItemCreateData): Promise<InvoiceItem> {
    return invoicesRequest<InvoiceItem>(`${INVOICES_BASE}/${invoiceId}/items`, {
        method: 'POST',
        body: JSON.stringify(item),
    });
}

// PRICEBOOK-001: bulk add (a Price Book group expanded into its items) — one call.
export async function addInvoiceItemsBulk(invoiceId: number, items: InvoiceItemCreateData[]): Promise<{ added: number }> {
    return invoicesRequest<{ added: number }>(`${INVOICES_BASE}/${invoiceId}/items/bulk`, {
        method: 'POST',
        body: JSON.stringify({ items }),
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

export async function fetchInvoicePayments(id: number): Promise<PaymentTransaction[]> {
    return invoicesRequest<PaymentTransaction[]>(`${INVOICES_BASE}/${id}/payments`);
}

/** OB-31: void a manually recorded payment — it stays in history (grayed, listed
 *  last) but no longer counts toward amount_paid/balance. Manual-origin only;
 *  Stripe/Zenbooker-sourced rows are refused by the backend. */
export async function voidInvoicePayment(invoiceId: number, paymentId: number | string, reason?: string): Promise<void> {
    const trimmed = reason?.trim();
    await invoicesRequest(`${INVOICES_BASE}/${invoiceId}/payments/${paymentId}/void`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(trimmed ? { reason: trimmed } : {}),
    });
}
