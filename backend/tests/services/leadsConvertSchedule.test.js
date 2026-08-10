'use strict';

/**
 * ZB-DECOUPLE C4b — native conversion schedule (leadsService.resolveNativeSchedule).
 *
 * Contract: overrides.schedule = { start_at, end_at, technician_ids? } drives a
 * FULLY native conversion (convertLead skips every Zenbooker branch when it is
 * present). The helper must: validate timestamps and ordering (400), validate
 * every technician on the native roster (400 on foreign ids), normalize ids
 * to the roster-compat plane, and pass null through for absent schedules.
 */

const mockRequireActive = jest.fn();

jest.mock('../../src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../../src/services/technicianRosterService', () => ({
    requireActive: (...args) => mockRequireActive(...args),
}));

const leadsService = require('../../src/services/leadsService');

const COMPANY = '00000000-0000-0000-0000-000000000001';

describe('leadsService.resolveNativeSchedule — ZB-DECOUPLE C4b', () => {
    beforeEach(() => mockRequireActive.mockReset());

    it('returns null when no schedule is provided (legacy path untouched)', async () => {
        expect(await leadsService.resolveNativeSchedule(undefined, COMPANY)).toBeNull();
        expect(await leadsService.resolveNativeSchedule(null, COMPANY)).toBeNull();
    });

    it('normalizes a valid schedule to ISO + roster-compat technician entries', async () => {
        mockRequireActive.mockResolvedValue({ id: '1770085964093x308143070595776500', name: 'Robert' });
        const out = await leadsService.resolveNativeSchedule({
            start_at: '2026-08-14T14:00:00.000Z',
            end_at: '2026-08-14T16:00:00.000Z',
            technician_ids: ['e2ae7e60-c85b-41e2-aaaa-e6c2a95831a2'],
        }, COMPANY);
        expect(out.startISO).toBe('2026-08-14T14:00:00.000Z');
        expect(out.endISO).toBe('2026-08-14T16:00:00.000Z');
        // uuid in → roster-compat id out (the plane jobs.assigned_techs uses)
        expect(JSON.parse(out.assignedTechs)).toEqual([
            { id: '1770085964093x308143070595776500', name: 'Robert' },
        ]);
    });

    it('rejects invalid timestamps with a 400 LeadsServiceError', async () => {
        await expect(
            leadsService.resolveNativeSchedule({ start_at: 'not-a-date', end_at: '2026-08-14T16:00:00Z' }, COMPANY)
        ).rejects.toMatchObject({ code: 'INVALID_SCHEDULE', httpStatus: 400 });
    });

    it('rejects end <= start', async () => {
        await expect(
            leadsService.resolveNativeSchedule({ start_at: '2026-08-14T16:00:00Z', end_at: '2026-08-14T16:00:00Z' }, COMPANY)
        ).rejects.toMatchObject({ code: 'INVALID_SCHEDULE', httpStatus: 400 });
    });

    it('rejects an off-roster technician with a 400 (nothing schedulable slips through)', async () => {
        mockRequireActive.mockRejectedValue(new Error('Technician not found'));
        await expect(
            leadsService.resolveNativeSchedule({
                start_at: '2026-08-14T14:00:00Z', end_at: '2026-08-14T16:00:00Z',
                technician_ids: ['foreign-id'],
            }, COMPANY)
        ).rejects.toMatchObject({ code: 'INVALID_TECHNICIAN', httpStatus: 400 });
    });

    it('an empty technician list yields null assignedTechs (auto-assign later)', async () => {
        const out = await leadsService.resolveNativeSchedule({
            start_at: '2026-08-14T14:00:00Z', end_at: '2026-08-14T16:00:00Z', technician_ids: [],
        }, COMPANY);
        expect(out.assignedTechs).toBeNull();
        expect(mockRequireActive).not.toHaveBeenCalled();
    });
});
