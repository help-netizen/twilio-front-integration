import { authedFetch } from './apiClient';

const API_BASE = '/api/stripe-payments';

export type StripeReadiness =
    | 'not_connected'
    | 'onboarding_incomplete'
    | 'action_required'
    | 'payments_disabled'
    | 'payouts_disabled'
    | 'connected_ready'
    | 'disconnected';

export interface StripeChecklistItem {
    key: string;
    label: string;
    done: boolean;
    deferred?: boolean;
}

export interface StripeAccountStatus {
    charges_enabled: boolean;
    payouts_enabled: boolean;
    details_submitted: boolean;
    requirements_currently_due: string[];
    requirements_past_due: string[];
    capabilities: Record<string, string>;
    status: string;
}

export interface StripePaymentsStatus {
    configured: boolean;
    connected: boolean;
    readiness: StripeReadiness;
    can_collect: boolean;
    livemode?: boolean;
    account: StripeAccountStatus | null;
    checklist: StripeChecklistItem[];
}

export interface ManualCardSessionResult {
    status: string;
    amount: number;
    brand: string | null;
    last4: string | null;
}

export interface ManualCardReceiptResult {
    sent: boolean;
    receipt_url: string | null;
    contact_email_saved: boolean;
}

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
    const res = await authedFetch(`${API_BASE}${path}`, {
        ...opts,
        headers: { 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
    });
    const json = await res.json();
    if (!res.ok || json.success === false) {
        throw new Error(json.message || json.error || `Request failed: ${res.status}`);
    }
    return json;
}

async function getManualCardSessionResult(sessionId: number): Promise<ManualCardSessionResult> {
    const res = await authedFetch(`/api/payments/manual-card-sessions/${sessionId}/result`);
    const json = await res.json();
    if (!res.ok) {
        const message = typeof json?.error === 'string' ? json.error : json?.error?.message;
        throw new Error(message || `Request failed: ${res.status}`);
    }
    return {
        status: json.status,
        amount: json.amount,
        brand: json.brand ?? null,
        last4: json.last4 ?? null,
    };
}

async function sendManualCardReceipt(sessionId: number, email: string): Promise<ManualCardReceiptResult> {
    const res = await authedFetch(`/api/payments/manual-card-sessions/${sessionId}/receipt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
    });
    const json = await res.json();
    if (!res.ok) {
        const message = typeof json?.error === 'string' ? json.error : json?.error?.message;
        throw new Error(message || `Request failed: ${res.status}`);
    }
    return {
        sent: json.sent === true,
        receipt_url: json.receipt_url ?? null,
        contact_email_saved: json.contact_email_saved === true,
    };
}

export const stripePaymentsApi = {
    getStatus: (): Promise<{ status: StripePaymentsStatus }> => apiFetch('/status'),
    connect: (): Promise<{ account_id: string; onboarding_url: string }> =>
        apiFetch('/connect', { method: 'POST' }),
    getOnboardingLink: (): Promise<{ url: string }> =>
        apiFetch('/onboarding-link', { method: 'POST' }),
    refreshStatus: (): Promise<{ status: StripePaymentsStatus }> =>
        apiFetch('/refresh-status', { method: 'POST' }),
    disconnect: (): Promise<{ disconnected: boolean }> =>
        apiFetch('/disconnect', { method: 'POST' }),
    getManualCardSessionResult,
    sendManualCardReceipt,
};

// Invoice payment links (mounted under /api/invoices/:id/...)
export interface InvoicePaymentLink {
    active: { url: string; expires_at: string | null; amount: number } | null;
    history: Array<{ id: number; status: string; amount: number; surface: string; failure_reason: string | null; created_at: string }>;
}

export interface ManualCardSession {
    session_id: number;
    client_secret: string;
    payment_intent_id: string;
    account_id: string;
    amount: number;
}

async function postData<T>(url: string, body?: unknown): Promise<T> {
    const res = await authedFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.error?.message || `Request failed: ${res.status}`);
    return json.data;
}

export const invoiceStripeApi = {
    createLink: async (invoiceId: number | string, amount?: number): Promise<{ url: string; expires_at: string | null; reused: boolean }> => {
        const res = await authedFetch(`/api/invoices/${invoiceId}/stripe-payment-link`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount }),
        });
        const json = await res.json();
        if (!res.ok || json.ok === false) throw new Error(json.error?.message || `Request failed: ${res.status}`);
        return json.data;
    },
    manualCardSession: (invoiceId: number | string, amount?: number): Promise<ManualCardSession> =>
        postData(`/api/invoices/${invoiceId}/stripe-manual-card-session`, { amount }),
    refund: (transactionId: number | string, amount?: number, reason?: string): Promise<{ refund_id: string }> =>
        postData(`/api/payments/${transactionId}/stripe-refund`, { amount, reason }),
    getLink: async (invoiceId: number | string): Promise<InvoicePaymentLink> => {
        const res = await authedFetch(`/api/invoices/${invoiceId}/stripe-payment-link`);
        const json = await res.json();
        if (!res.ok || json.ok === false) throw new Error(json.error?.message || `Request failed: ${res.status}`);
        return json.data;
    },
    sendLink: async (invoiceId: number | string, body: { channel?: string; message?: string }): Promise<{ sent: boolean; url: string }> => {
        const res = await authedFetch(`/api/invoices/${invoiceId}/send-payment-link`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const json = await res.json();
        if (!res.ok || json.ok === false) throw new Error(json.error?.message || `Request failed: ${res.status}`);
        return json.data;
    },
};

// Job (ad-hoc) payment links (mounted under /api/jobs/:id/...). Mirrors invoiceStripeApi;
// `amount` is dollars (number), passed through verbatim exactly like the invoice API.
export const jobStripeApi = {
    createLink: async (jobId: number | string, amount?: number): Promise<{ url: string; expires_at: string | null; reused: boolean }> => {
        const res = await authedFetch(`/api/jobs/${jobId}/stripe-payment-link`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount }),
        });
        const json = await res.json();
        if (!res.ok || json.ok === false) throw new Error(json.error?.message || `Request failed: ${res.status}`);
        return json.data;
    },
    getLink: async (jobId: number | string): Promise<InvoicePaymentLink> => {
        const res = await authedFetch(`/api/jobs/${jobId}/stripe-payment-link`);
        const json = await res.json();
        if (!res.ok || json.ok === false) throw new Error(json.error?.message || `Request failed: ${res.status}`);
        return json.data;
    },
    sendLink: async (jobId: number | string, body: { channel?: string; amount?: number; message?: string }): Promise<{ sent: boolean; url: string; channel?: string }> => {
        const res = await authedFetch(`/api/jobs/${jobId}/send-payment-link`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const json = await res.json();
        if (!res.ok || json.ok === false) throw new Error(json.error?.message || `Request failed: ${res.status}`);
        return json.data;
    },
    manualCardSession: (jobId: number | string, amount?: number): Promise<ManualCardSession> =>
        postData(`/api/jobs/${jobId}/stripe-manual-card-session`, { amount }),
};
