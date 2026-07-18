import { authedFetch } from './apiClient';

const API_BASE = import.meta.env.VITE_API_URL || '';
const SYNC_URL = `${API_BASE}/api/zenbooker/payments/sync`;

export type ZenbookerSyncCursor = string | number;

export interface ZenbookerPaymentSyncResult {
    mode: 'range' | 'full_history';
    synced: number;
    total_transactions: number;
    imported: number;
    skipped_existing: number;
    remaining: boolean;
    cursor: ZenbookerSyncCursor | null;
    last_range: { from: string; to: string } | null;
    unlinked: number;
    unresolved_job_id: number;
    job_fetch_failed: number;
}

export function zenbookerSyncResultMessage(result: ZenbookerPaymentSyncResult): string {
    if (result.remaining) return 'Progress saved — run again to continue';
    return `Sync complete — ${result.imported} imported, ${result.skipped_existing} already imported`;
}

interface SyncEnvelope {
    ok: boolean;
    data?: ZenbookerPaymentSyncResult;
    error?: string | { message?: string };
}

async function postSync(body: Record<string, unknown>): Promise<ZenbookerPaymentSyncResult> {
    const response = await authedFetch(SYNC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    let json: SyncEnvelope;
    try {
        json = await response.json();
    } catch {
        throw new Error(`Sync failed (${response.status})`);
    }
    if (!response.ok || !json.ok || !json.data) {
        const message = typeof json.error === 'string' ? json.error : json.error?.message;
        throw new Error(message || `Sync failed (${response.status})`);
    }
    return json.data;
}

export const zenbookerPaymentsApi = {
    syncRange(dateFrom: string, dateTo: string): Promise<ZenbookerPaymentSyncResult> {
        return postSync({ date_from: dateFrom, date_to: dateTo });
    },

    syncFullHistory(cursor?: ZenbookerSyncCursor | null): Promise<ZenbookerPaymentSyncResult> {
        return postSync(cursor == null
            ? { full_history: true }
            : { full_history: true, cursor });
    },
};
