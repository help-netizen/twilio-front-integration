/**
 * Canonical Payments API Client (PF004)
 * Frontend fetch wrapper for /api/payments endpoints.
 * This is SEPARATE from the Zenbooker PaymentsPage — these are the canonical payment transactions.
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
    transaction_type: 'payment' | 'refund' | 'adjustment';
    payment_method: 'credit_card' | 'ach' | 'check' | 'cash' | 'other' | 'zenbooker_sync';
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
    contact_id?: number;
    invoice_id?: number;
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

export interface CreateTransactionData {
    contact_id?: number | null;
    invoice_id?: number | null;
    estimate_id?: number | null;
    job_id?: number | null;
    transaction_type: 'payment' | 'refund' | 'adjustment';
    payment_method: 'credit_card' | 'ach' | 'check' | 'cash' | 'other';
    amount: string;
    currency?: string;
    reference_number?: string;
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
    if (filters.contact_id) params.set('contact_id', String(filters.contact_id));
    if (filters.invoice_id) params.set('invoice_id', String(filters.invoice_id));
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

export async function createTransaction(data: CreateTransactionData): Promise<PaymentTransaction> {
    return paymentsRequest<PaymentTransaction>(PAYMENTS_BASE, {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

export async function recordManualPayment(data: CreateTransactionData): Promise<PaymentTransaction> {
    return paymentsRequest<PaymentTransaction>(`${PAYMENTS_BASE}/manual`, {
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

export async function voidTransaction(id: number): Promise<PaymentTransaction> {
    return paymentsRequest<PaymentTransaction>(`${PAYMENTS_BASE}/${id}/void`, {
        method: 'POST',
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

export async function fetchTransactionsForInvoice(invoiceId: number): Promise<PaymentTransaction[]> {
    return paymentsRequest<PaymentTransaction[]>(`${PAYMENTS_BASE}/invoice/${invoiceId}`);
}

export async function fetchPaymentSummary(): Promise<PaymentSummary> {
    return paymentsRequest<PaymentSummary>(`${PAYMENTS_BASE}/summary`);
}
