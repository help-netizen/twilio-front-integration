import { beforeEach, describe, expect, it, vi } from 'vitest';

const authedFetch = vi.hoisted(() => vi.fn());
vi.mock('./apiClient', () => ({ authedFetch }));

import {
    zenbookerPaymentsApi,
    zenbookerSyncResultMessage,
    type ZenbookerPaymentSyncResult,
} from './zenbookerPaymentsApi';

function result(overrides: Partial<ZenbookerPaymentSyncResult> = {}): ZenbookerPaymentSyncResult {
    return {
        mode: 'full_history',
        synced: 25,
        total_transactions: 25,
        imported: 20,
        skipped_existing: 5,
        remaining: false,
        cursor: null,
        last_range: null,
        unlinked: 0,
        unresolved_job_id: 0,
        job_fetch_failed: 0,
        ...overrides,
    };
}

function response(body: unknown, ok = true, status = 200): Response {
    return { ok, status, json: vi.fn(async () => body) } as unknown as Response;
}

beforeEach(() => authedFetch.mockReset());

describe('zenbookerPaymentsApi', () => {
    it('posts the exact existing range body', async () => {
        authedFetch.mockResolvedValue(response({ ok: true, data: result({ mode: 'range' }) }));

        await zenbookerPaymentsApi.syncRange('2026-01-01', '2026-01-31');

        expect(authedFetch).toHaveBeenCalledWith('/api/zenbooker/payments/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date_from: '2026-01-01', date_to: '2026-01-31' }),
        });
    });

    it('posts full history without a cursor, then the returned continuation cursor', async () => {
        authedFetch
            .mockResolvedValueOnce(response({
                ok: true,
                data: result({ remaining: true, cursor: 'cursor-25' }),
            }))
            .mockResolvedValueOnce(response({ ok: true, data: result() }));

        const partial = await zenbookerPaymentsApi.syncFullHistory();
        await zenbookerPaymentsApi.syncFullHistory(partial.cursor);

        expect(authedFetch.mock.calls[0][1]?.body).toBe(JSON.stringify({ full_history: true }));
        expect(authedFetch.mock.calls[1][1]?.body).toBe(JSON.stringify({
            full_history: true,
            cursor: 'cursor-25',
        }));
        expect(partial).toMatchObject({ remaining: true, cursor: 'cursor-25' });
        expect(zenbookerSyncResultMessage(partial))
            .toBe('Progress saved — run again to continue');
        expect(zenbookerSyncResultMessage(result()))
            .toBe('Sync complete — 20 imported, 5 already imported');
    });

    it('surfaces API and non-JSON failures', async () => {
        authedFetch.mockResolvedValueOnce(response({ ok: false, error: 'Forbidden' }, false, 403));
        await expect(zenbookerPaymentsApi.syncFullHistory()).rejects.toThrow('Forbidden');

        authedFetch.mockResolvedValueOnce({
            ok: false,
            status: 502,
            json: vi.fn(async () => { throw new Error('not json'); }),
        } as unknown as Response);
        await expect(zenbookerPaymentsApi.syncRange('2026-01-01', '2026-01-31'))
            .rejects.toThrow('Sync failed (502)');
    });
});
