import { beforeEach, expect, it, vi } from 'vitest';

const authedFetch = vi.hoisted(() => vi.fn());
vi.mock('./apiClient', () => ({ authedFetch }));

import {
    fetchUnavailability,
    overlapsUnavailability,
    unavailabilityLabel,
    unavailabilityWarningPhrase,
    type UnavailabilityBlock,
} from './scheduleApi';

const gap: UnavailabilityBlock = {
    id: 'schedule:tech-1:2026-07-20:before',
    kind: 'schedule_gap',
    technician_id: 'tech-1',
    technician_name: 'Alex Rivera',
    starts_at: '2026-07-20T04:00:00.000Z',
    ends_at: '2026-07-20T12:00:00.000Z',
    source: 'work_schedule',
    mutable: false,
};

beforeEach(() => authedFetch.mockReset());

it('reads the composite endpoint and keeps synthetic blocks non-mutable', async () => {
    authedFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn(async () => ({ ok: true, data: { unavailability: [gap] } })),
    });
    await expect(fetchUnavailability({
        from: '2026-07-20T04:00:00.000Z',
        to: '2026-07-21T04:00:00.000Z',
        technician_id: 'tech-1',
    })).resolves.toEqual([gap]);
    expect(authedFetch.mock.calls[0][0]).toContain('/api/schedule/unavailability?');
    expect(authedFetch.mock.calls[0][0]).toContain('technician_id=tech-1');
});

it('uses strict half-open overlap for both kinds', () => {
    expect(overlapsUnavailability([gap], ['tech-1'], gap.ends_at, '2026-07-20T13:00:00.000Z')).toEqual([]);
    expect(overlapsUnavailability([gap], ['tech-1'], '2026-07-20T11:59:00.000Z', '2026-07-20T13:00:00.000Z')).toEqual([gap]);
});

it('provides kind-aware renderer and warning language', () => {
    expect(unavailabilityLabel(gap)).toBe('Outside work schedule');
    expect(unavailabilityWarningPhrase(gap)).toBe('is outside their work schedule');
    expect(unavailabilityLabel({ kind: 'time_off' })).toBe('Time off');
});
