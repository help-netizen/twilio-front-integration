import { authedFetch } from './apiClient';

/**
 * LEAD-CHANNEL-ANALYTICS-001 chunk 1b — Google Ads connector status/sync client.
 * The response never carries the refresh token or the full customer id
 * (customer_id_masked is the last 4 digits only).
 */

export type GoogleAdsStatus = 'connected' | 'reconnect_required' | 'disconnected';

export interface GoogleAdsConnection {
    connected: boolean;
    status: GoogleAdsStatus;
    customer_id_masked: string | null;
    currency_code: string | null;
    account_timezone: string | null;
    synced_from_date: string | null;
    synced_through_date: string | null;
    last_sync_status: string | null;
    last_synced_at: string | null;
    last_error_code: string | null;
}

const BASE = '/api/marketplace/apps/google-ads';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
    const res = await authedFetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
    if (!res.ok) {
        const body = await res.json().catch(() => ({} as Record<string, unknown>));
        const err = body as { error?: { message?: string }; message?: string };
        throw new Error(err.error?.message || err.message || `Request failed: ${res.status}`);
    }
    return res.json() as Promise<T>;
}

export function fetchGoogleAdsConnection(): Promise<GoogleAdsConnection> {
    return request<GoogleAdsConnection>(`${BASE}/connection`);
}

export function syncGoogleAds(): Promise<{ status?: string }> {
    return request<{ status?: string }>(`${BASE}/sync`, { method: 'POST' });
}

export function disconnectGoogleAds(): Promise<{ status?: string }> {
    return request<{ status?: string }>(`${BASE}/disconnect`, { method: 'POST' });
}
