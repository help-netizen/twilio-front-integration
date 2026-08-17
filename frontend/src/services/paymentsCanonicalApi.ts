/**
 * Canonical Payments API Client (PF004)
 * Frontend fetch wrapper for /api/payments endpoints.
 * Canonical payment transactions and actions share the Payments API surface.
 */

import { authedFetch } from './apiClient';

const PAYMENTS_BASE = '/api/payments';

// -- Types --------------------------------------------------------------------

export interface PaymentTransaction {
    id: number;
    company_id: string;
    contact_id: number | null;
    estimate_id: number | null;
    invoice_id: number | null;
    job_id: number | null;
    job_seq?: number | null;
    transaction_type: 'payment' | 'refund' | 'adjustment';
    payment_method:
        | 'credit_card'
        | 'ach'
        | 'check'
        | 'cash'
        | 'other'
        | 'zenbooker_sync'
        | 'zb_card'
        | 'zb_check'
        | 'zb_cash'
        | 'zb_ach'
        | 'zb_venmo'
        | 'zb_zelle'
        | 'zb_other';
    status: 'pending' | 'processing' | 'completed' | 'failed' | 'refunded' | 'voided';
    amount: string;
    currency: string;
    reference_number: string | null;
    external_id: string | null;
    external_source: string | null;
    memo: string | null;
    metadata: any;
    processed_at: string | null;
    recorded_by: string | null;
    created_at: string;
    updated_at: string;
    voided_at?: string | null;
    voided_by?: string | null;
    void_reason?: string | null;
    // RECEIPT-REVIEW-001: enriched fields (present on GET /api/payments/:id detail).
    voided_by_name?: string | null;
    brand?: string | null;
    last4?: string | null;
    invoice_number?: string | null;
    customer_name?: string | null;
    created_by_name?: string | null;
    territory?: string | null;
    stripe_payment_id?: string | null;
    stripe_customer_id?: string | null;
    stripe_livemode?: boolean | null;
    receipt_history?: Array<{ to: string | null; sent_at: string; channel: 'email' | 'sms' | 'portal' }>;
}

export interface PaymentReceipt {
    id: number;
    transaction_id: number;
    receipt_number: string;
    sent_to_email: string | null;
    sent_to_phone: string | null;
    sent_via: 'email' | 'sms' | 'portal' | null;
    pdf_storage_key: string | null;
    sent_at: string | null;
    created_at: string;
}

export interface PaymentSummary {
    total_collected: string;
    total_refunded: string;
    total_pending: string;
    net_amount: string;
}

export interface TransactionsListParams {
    status?: string;
    transaction_type?: string;
    payment_method?: string;
    source?: string;
    contact_id?: number;
    invoice_id?: number;
    job_id?: number | null;
    search?: string;
    page?: number;
    limit?: number;
}

export interface TransactionsListResult {
    transactions: PaymentTransaction[];
    total: number;
    page: number;
    limit: number;
}

export interface RecordJobPaymentData {
    amount: number;
    payment_method: 'cash' | 'check';
    reference_number?: string;
    payment_date?: string;
    memo?: string;
}

export interface RefundData {
    amount: string;
    reason?: string;
}

export interface SendReceiptData {
    channel: 'email' | 'sms';
    recipient: string;
}

// -- Helpers ------------------------------------------------------------------

interface ApiResponse<T> {
    ok: boolean;
    data: T;
    error?: { code: string; message: string };
}

async function paymentsRequest<T>(url: string, options?: RequestInit): Promise<T> {
    const res = await authedFetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
    const json: ApiResponse<T> = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.error?.message || `Payments API error ${res.status}`);
    return json.data;
}

// -- Public API ---------------------------------------------------------------

export async function fetchTransactions(filters: TransactionsListParams = {}): Promise<TransactionsListResult> {
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.transaction_type) params.set('transaction_type', filters.transaction_type);
    if (filters.payment_method) params.set('payment_method', filters.payment_method);
    if (filters.source) params.set('source', filters.source);
    if (filters.contact_id) params.set('contact_id', String(filters.contact_id));
    if (filters.invoice_id) params.set('invoice_id', String(filters.invoice_id));
    if (filters.job_id != null) params.set('job_id', String(filters.job_id));
    if (filters.search) params.set('search', filters.search);
    if (filters.page != null) params.set('page', String(filters.page));
    if (filters.limit != null) params.set('limit', String(filters.limit));
    const qs = params.toString();
    const raw = await paymentsRequest<any>(`${PAYMENTS_BASE}${qs ? `?${qs}` : ''}`);
    return {
        transactions: raw.rows ?? raw.transactions ?? [],
        total: raw.total ?? 0,
        page: filters.page ?? 1,
        limit: filters.limit ?? 25,
    };
}

export async function fetchTransaction(id: number): Promise<PaymentTransaction> {
    return paymentsRequest<PaymentTransaction>(`${PAYMENTS_BASE}/${id}`);
}

/** PROVIDER-CARD-COLLECT-001: Stripe collect-readiness reachable by any collector
 * (the canonical /api/stripe-payments/status is admin-gated), so a Provider's Pay-by-Card
 * button can render. Same shape as the admin status endpoint's `status`. */
export interface StripeReadiness {
    configured: boolean;
    can_collect: boolean;
    readiness?: string | null;
    /** Connect account that owns the charges — dashboard links are scoped by it. */
    account?: { id?: string | null } | null;
}
export async function fetchStripeReadiness(): Promise<StripeReadiness> {
    return paymentsRequest<StripeReadiness>(`${PAYMENTS_BASE}/stripe-readiness`);
}

export async function recordJobPayment(
    jobId: number | string,
    data: RecordJobPaymentData,
): Promise<PaymentTransaction> {
    return paymentsRequest<PaymentTransaction>(`/api/jobs/${jobId}/record-payment`, {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

export async function recordInvoicePayment(
    invoiceId: number | string,
    data: RecordJobPaymentData,
): Promise<PaymentTransaction> {
    return paymentsRequest<PaymentTransaction>(`/api/invoices/${invoiceId}/record-payment`, {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

export async function refundTransaction(id: number, data: RefundData): Promise<PaymentTransaction> {
    return paymentsRequest<PaymentTransaction>(`${PAYMENTS_BASE}/${id}/refund`, {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

export interface VoidTransactionResult {
    payment: PaymentTransaction;
    invoice: unknown | null;
    idempotent: boolean;
}

export async function voidTransaction(id: number, reason?: string): Promise<VoidTransactionResult> {
    const trimmed = reason?.trim();
    return paymentsRequest<VoidTransactionResult>(`${PAYMENTS_BASE}/${id}/void`, {
        method: 'POST',
        body: JSON.stringify(trimmed ? { reason: trimmed } : {}),
    });
}

export async function fetchReceipt(transactionId: number): Promise<PaymentReceipt> {
    return paymentsRequest<PaymentReceipt>(`${PAYMENTS_BASE}/${transactionId}/receipt`);
}

export async function sendReceipt(transactionId: number, data: SendReceiptData): Promise<PaymentReceipt> {
    return paymentsRequest<PaymentReceipt>(`${PAYMENTS_BASE}/${transactionId}/receipt/send`, {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

// RECEIPT-REVIEW-001 — send our own branded receipt (Stripe hosted receipt removed).

export interface EmailReceiptResult {
    sent: boolean;
    delivery: string;
    contact_email_saved: boolean;
    idempotent: boolean;
    receipt_history_entry: { to: string | null; sent_at: string; channel: 'email' | 'sms' | 'portal' } | null;
}

/** Email the customer our branded payment receipt (backend falls back to the on-file
 *  email when omitted). Pass a stable idempotencyKey per user send action. */
export async function emailTransactionReceipt(
    transactionId: number,
    email?: string,
    idempotencyKey?: string,
): Promise<EmailReceiptResult> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    return paymentsRequest<EmailReceiptResult>(`${PAYMENTS_BASE}/${transactionId}/receipt/email`, {
        method: 'POST',
        headers,
        body: JSON.stringify(email ? { email } : {}),
    });
}

export async function fetchTransactionsForInvoice(invoiceId: number): Promise<PaymentTransaction[]> {
    return paymentsRequest<PaymentTransaction[]>(`${PAYMENTS_BASE}/invoice/${invoiceId}`);
}

export async function fetchPaymentSummary(): Promise<PaymentSummary> {
    return paymentsRequest<PaymentSummary>(`${PAYMENTS_BASE}/summary`);
}
