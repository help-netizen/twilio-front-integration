/**
 * billingApi.ts — BILLING-UI. Subscription cabinet API client (tenant-admin).
 */
import { authedFetch } from './apiClient';

const BASE = '/api/billing';

export interface Subscription {
    plan_id: string | null;
    plan_name: string | null;
    status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'incomplete';
    trial_ends_at: string | null;
    current_period_end: string | null;
    seats: number;
}

export interface Plan {
    id: string;
    name: string;
    monthly_base_usd: number;
    included_seats: number;
    per_seat_usd: number;
    metered: Record<string, number>;
    included_units: Record<string, number>;
    max_phone_numbers: number | null;
}

export interface Invoice {
    date: string;
    amount: number;
    status: string | null;
    hosted_url: string | null;
}

export interface BillingOverview {
    subscription: Subscription | null;
    usage: Record<string, number>;
    plans: Plan[];
    invoices: Invoice[];
    billing_enabled: boolean;
}

export interface WalletLedgerEntry {
    amount_usd: number;
    type: string;
    description: string | null;
    balance_after: number;
    ref: string | null;
    created_at: string;
}

export interface WalletInfo {
    balance_usd: number;
    blocked: boolean;
    grace_floor_usd: number;
    min_topup_usd: number;
    auto_recharge: { enabled: boolean; threshold_usd: number; amount_usd: number };
    has_card: boolean;
    ledger: WalletLedgerEntry[];
}

async function json<T>(p: Promise<Response>): Promise<T> {
    const r = await p;
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) {
        const err: any = new Error(j.error || `HTTP ${r.status}`);
        err.code = j.code;
        throw err;
    }
    return j;
}

export const billingApi = {
    overview: () => json<{ ok: true } & BillingOverview>(authedFetch(BASE)),
    checkout: (planId: string) =>
        json<{ url?: string; activated?: boolean }>(authedFetch(`${BASE}/checkout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ plan_id: planId }),
        })),
    portal: () =>
        json<{ url: string }>(authedFetch(`${BASE}/portal`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })),
    wallet: () => json<{ ok: true } & WalletInfo>(authedFetch(`${BASE}/wallet`)),
    topup: (amount: number) =>
        json<{ url?: string }>(authedFetch(`${BASE}/wallet/topup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount }),
        })),
    setAutoRecharge: (s: { enabled?: boolean; threshold?: number; amount?: number }) =>
        json<{ ok: true }>(authedFetch(`${BASE}/wallet/auto-recharge`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(s),
        })),
};
