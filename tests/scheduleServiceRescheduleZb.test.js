/**
 * scheduleServiceRescheduleZb.test.js — AGENT-SKILLS-001 T7 (G4, AR-4, spec §5.2/§5.3)
 *
 * Proves the ZB write-through SEAM added to `scheduleService.rescheduleItem`:
 *   - ZB-linked job → local write AND `zenbookerClient.rescheduleJob(zbId,{start_date ISO,…})`.
 *   - skip-if-not-linked / skip-if-canceled / non-'job' → NO ZB reschedule push.
 *   - the pre-existing `job_rescheduled` pushService hook stays best-effort/non-fatal
 *     AND does not prevent the ZB push (ASK-WRITE-07).
 *   - ZB reject → force-sync from the master THEN throw the friendly 409
 *     (blocking-with-recovery, ASK-WRITE-03) — the local write already committed, so
 *     state never silently diverges.
 *   - the existing NOT_FOUND (404) contract is preserved for existing callers.
 *
 * REAL scheduleService with the lower-level deps mocked (scheduleQueries /
 * jobsService / zenbookerClient / pushService + route side-effects stubbed).
 */

'use strict';

const CO = '00000000-0000-0000-0000-000000000001';

jest.mock('../backend/src/db/scheduleQueries', () => ({
    rescheduleJob: jest.fn(async () => ({ id: 7 })),
    rescheduleLead: jest.fn(async () => ({ id: 8 })),
    rescheduleTask: jest.fn(async () => ({ id: 9 })),
    getDispatchSettings: jest.fn(async () => null),
}));
jest.mock('../backend/src/services/jobsService', () => ({
    getJobById: jest.fn(),
    syncFromZenbooker: jest.fn(async () => {}),
}));
jest.mock('../backend/src/services/zenbookerClient', () => ({
    rescheduleJob: jest.fn(async () => ({})),
    getJob: jest.fn(async () => ({ id: 'zb_7', status: 'scheduled' })),
}));
jest.mock('../backend/src/services/pushService', () => ({
    sendToUser: jest.fn(() => Promise.resolve()),
}));
// Route/geo side-effects are irrelevant to the seam → stub so recalc never touches real deps.
jest.mock('../backend/src/services/routeSegmentService', () => ({
    recalcForJob: jest.fn(async () => {}),
    enqueueGeocode: jest.fn(async () => {}),
}));
jest.mock('../backend/src/db/routeQueries', () => ({
    getCompanyTimezone: jest.fn(async () => 'America/New_York'),
    getTechDaysForJob: jest.fn(async () => []),
}));

const scheduleQueries = require('../backend/src/db/scheduleQueries');
const jobsService = require('../backend/src/services/jobsService');
const zenbookerClient = require('../backend/src/services/zenbookerClient');
const pushService = require('../backend/src/services/pushService');
const scheduleService = require('../backend/src/services/scheduleService');

const START = '2026-07-10T14:00:00.000Z';
const END = '2026-07-10T16:00:00.000Z';

beforeEach(() => jest.clearAllMocks());

describe('rescheduleItem ZB write-through seam (AR-4)', () => {
    test('ASK-WRITE-01: ZB-linked job → local write AND zenbookerClient.rescheduleJob(start_date ISO), zb.pushed', async () => {
        jobsService.getJobById.mockResolvedValue({ id: 7, zenbooker_job_id: 'zb_7', zb_canceled: false, assigned_provider_user_ids: [] });
        const res = await scheduleService.rescheduleItem(CO, 'job', 7, START, END);
        expect(scheduleQueries.rescheduleJob).toHaveBeenCalledWith(CO, 7, START, END);
        expect(zenbookerClient.rescheduleJob).toHaveBeenCalledWith('zb_7', expect.objectContaining({ start_date: START, arrival_window_minutes: 120 }));
        expect(res.zb).toMatchObject({ linked: true, pushed: true });
    });

    test('ASK-WRITE-06: job with NO zenbooker_job_id → local write, ZB push NOT called (skip-if-not-linked)', async () => {
        jobsService.getJobById.mockResolvedValue({ id: 7, zenbooker_job_id: null, zb_canceled: false, assigned_provider_user_ids: [] });
        const res = await scheduleService.rescheduleItem(CO, 'job', 7, START, END);
        expect(scheduleQueries.rescheduleJob).toHaveBeenCalled();
        expect(zenbookerClient.rescheduleJob).not.toHaveBeenCalled();
        expect(res.zb).toMatchObject({ linked: false, pushed: false, skipped: 'not_linked' });
    });

    test('ASK-WRITE-06: non-job entityType never triggers a ZB reschedule push', async () => {
        const res = await scheduleService.rescheduleItem(CO, 'lead', 8, START, END);
        expect(scheduleQueries.rescheduleLead).toHaveBeenCalledWith(CO, 8, START, END);
        expect(zenbookerClient.rescheduleJob).not.toHaveBeenCalled();
        expect(res.zb).toMatchObject({ pushed: false, skipped: 'not_a_job' });
    });

    test('skip ZB push when the job is already zb_canceled', async () => {
        jobsService.getJobById.mockResolvedValue({ id: 7, zenbooker_job_id: 'zb_7', zb_canceled: true, assigned_provider_user_ids: [] });
        const res = await scheduleService.rescheduleItem(CO, 'job', 7, START, END);
        expect(zenbookerClient.rescheduleJob).not.toHaveBeenCalled();
        expect(res.zb).toMatchObject({ skipped: 'zb_canceled' });
    });

    test('ASK-WRITE-07: pushService throw is non-fatal AND the ZB push still happens + success returned', async () => {
        jobsService.getJobById.mockResolvedValue({ id: 7, zenbooker_job_id: 'zb_7', zb_canceled: false, assigned_provider_user_ids: ['u1'] });
        pushService.sendToUser.mockImplementation(() => { throw new Error('push boom'); });
        const res = await scheduleService.rescheduleItem(CO, 'job', 7, START, END);
        expect(zenbookerClient.rescheduleJob).toHaveBeenCalled(); // ZB push still fired despite the push-hook throw
        expect(res.zb.pushed).toBe(true);
        expect(res.entity_id).toBe(7);
    });

    test('ASK-WRITE-03: ZB rescheduleJob rejects → force-sync from ZB THEN throw 409 (blocking-with-recovery)', async () => {
        jobsService.getJobById.mockResolvedValue({ id: 7, zenbooker_job_id: 'zb_7', zb_canceled: false, company_id: CO, assigned_provider_user_ids: [] });
        zenbookerClient.rescheduleJob.mockRejectedValue(new Error('ZB 500'));
        await expect(scheduleService.rescheduleItem(CO, 'job', 7, START, END)).rejects.toMatchObject({ statusCode: 409 });
        // recovery ran: pulled the master's truth + wrote it back locally
        expect(zenbookerClient.getJob).toHaveBeenCalledWith('zb_7');
        expect(jobsService.syncFromZenbooker).toHaveBeenCalledWith('zb_7', expect.any(Object), CO);
        // local write DID commit before the throw (authoritative-first) → never a silent divergence
        expect(scheduleQueries.rescheduleJob).toHaveBeenCalled();
    });

    test('NOT_FOUND preserved: rescheduleJob returns null → 404 ScheduleServiceError, no ZB push (existing contract)', async () => {
        scheduleQueries.rescheduleJob.mockResolvedValueOnce(null);
        await expect(scheduleService.rescheduleItem(CO, 'job', 7, START, END)).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        expect(zenbookerClient.rescheduleJob).not.toHaveBeenCalled();
    });
});
