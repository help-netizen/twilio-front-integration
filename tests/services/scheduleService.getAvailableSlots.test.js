/**
 * LQV2 — scheduleService.getAvailableSlots unit tests.
 *
 * Covers the slot-generation logic that backs the checkAvailability tool:
 *   - TC-LQV2-017  returns up to maxSlots
 *   - TC-LQV2-018  no availability → empty + error
 *   - TC-LQV2-021  human-readable label format
 *   plus: one-slot-per-day variety, booked-window overlap filtering,
 *         work-day filtering, custom dispatch_settings.
 *
 * scheduleQueries is mocked so no DB is required.
 */

jest.mock('../../backend/src/db/scheduleQueries', () => ({
    getDispatchSettings: jest.fn(),
    getScheduleItems: jest.fn(),
}));

const scheduleQueries = require('../../backend/src/db/scheduleQueries');
const scheduleService = require('../../backend/src/services/scheduleService');

beforeEach(() => {
    jest.clearAllMocks();
    // Default: no custom settings (service falls back to defaults), no bookings.
    scheduleQueries.getDispatchSettings.mockResolvedValue(null);
    scheduleQueries.getScheduleItems.mockResolvedValue({ rows: [], total: 0 });
});

const COMPANY = '00000000-0000-0000-0000-000000000001';

describe('getAvailableSlots', () => {
    // TC-LQV2-017
    test('returns up to maxSlots, one per working day', async () => {
        // 2026-06-08 is a Monday
        const r = await scheduleService.getAvailableSlots(COMPANY, {
            startDate: '2026-06-08', days: 5, slotDurationMin: 120, maxSlots: 3,
        });
        expect(r.slots).toHaveLength(3);
        const dates = r.slots.map(s => s.date);
        expect(new Set(dates).size).toBe(3); // distinct days
        expect(dates).toEqual(['2026-06-08', '2026-06-09', '2026-06-10']);
    });

    // TC-LQV2-021
    test('label format is human-readable with ordinal day and am/pm range', async () => {
        const r = await scheduleService.getAvailableSlots(COMPANY, {
            startDate: '2026-06-08', days: 1, slotDurationMin: 120, maxSlots: 1,
        });
        expect(r.slots[0].label).toBe('Monday, June 8th between 8am and 10am');
        expect(r.slots[0].start).toBe('08:00');
        expect(r.slots[0].end).toBe('10:00');
    });

    test('first booked window is skipped to next open window same day', async () => {
        scheduleQueries.getScheduleItems.mockResolvedValue({
            rows: [{ entity_type: 'job', start_at: '2026-06-08T08:00:00', end_at: '2026-06-08T10:00:00' }],
            total: 1,
        });
        const r = await scheduleService.getAvailableSlots(COMPANY, {
            startDate: '2026-06-08', days: 1, slotDurationMin: 120, maxSlots: 1,
        });
        // 8–10 booked → first open Monday window is 10–12
        expect(r.slots[0].label).toBe('Monday, June 8th between 10am and 12pm');
    });

    // TC-LQV2-018
    test('weekend-only range with default work_days (Mon–Fri) → no availability', async () => {
        // 2026-06-13 is Saturday, 06-14 Sunday
        const r = await scheduleService.getAvailableSlots(COMPANY, {
            startDate: '2026-06-13', days: 2, slotDurationMin: 120, maxSlots: 3,
        });
        expect(r.slots).toEqual([]);
        expect(r.error).toMatch(/No availability/);
    });

    test('respects custom dispatch_settings (work days + hours)', async () => {
        scheduleQueries.getDispatchSettings.mockResolvedValue({
            timezone: 'America/New_York',
            work_start_time: '09:00',
            work_end_time: '17:00',
            work_days: [6], // Saturday only
            slot_duration: 60,
            buffer_minutes: 0,
        });
        // 2026-06-13 is Saturday
        const r = await scheduleService.getAvailableSlots(COMPANY, {
            startDate: '2026-06-13', days: 1, slotDurationMin: 120, maxSlots: 1,
        });
        expect(r.slots).toHaveLength(1);
        expect(r.slots[0].label).toBe('Saturday, June 13th between 9am and 11am');
    });

    test('fully booked day is skipped entirely', async () => {
        // Book the whole Monday 08:00–18:00
        scheduleQueries.getScheduleItems.mockResolvedValue({
            rows: [{ entity_type: 'job', start_at: '2026-06-08T08:00:00', end_at: '2026-06-08T18:00:00' }],
            total: 1,
        });
        const r = await scheduleService.getAvailableSlots(COMPANY, {
            startDate: '2026-06-08', days: 2, slotDurationMin: 120, maxSlots: 3,
        });
        // Monday fully booked → first slot is Tuesday
        expect(r.slots[0].date).toBe('2026-06-09');
    });
});
