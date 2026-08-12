/**
 * Regression guards for the local-only schedule mutation paths after Zenbooker
 * job traffic was decommissioned.
 */

'use strict';

const CO = '00000000-0000-0000-0000-000000000001';

jest.mock('../backend/src/db/scheduleQueries', () => ({
    rescheduleJob: jest.fn(),
    rescheduleLead: jest.fn(),
    rescheduleTask: jest.fn(),
    reassignJob: jest.fn(),
    getDispatchSettings: jest.fn(async () => null),
}));
jest.mock('../backend/src/services/jobsService', () => ({
    getJobById: jest.fn(),
    resolveAssignedProviderUserIds: jest.fn(),
}));
jest.mock('../backend/src/services/eventBus', () => ({
    emit: jest.fn(async () => ({})),
}));
jest.mock('../backend/src/services/routeSegmentService', () => ({
    recalcForJob: jest.fn(async () => {}),
    enqueueGeocode: jest.fn(async () => {}),
}));
jest.mock('../backend/src/services/technicianRosterService', () => ({
    canonicalizeAssignments: jest.fn(async (_companyId, assignments) => assignments),
}));
jest.mock('../backend/src/db/routeQueries', () => ({
    getCompanyTimezone: jest.fn(async () => 'America/New_York'),
    getTechDaysForJob: jest.fn(async () => []),
}));

const scheduleQueries = require('../backend/src/db/scheduleQueries');
const jobsService = require('../backend/src/services/jobsService');
const eventBus = require('../backend/src/services/eventBus');
const scheduleService = require('../backend/src/services/scheduleService');

const START = '2026-07-10T14:00:00.000Z';
const END = '2026-07-10T16:00:00.000Z';

beforeEach(() => {
    jest.clearAllMocks();
    scheduleQueries.rescheduleJob.mockResolvedValue({ id: 7 });
    scheduleQueries.rescheduleLead.mockResolvedValue({ id: 8 });
    scheduleQueries.rescheduleTask.mockResolvedValue({ id: 9 });
    scheduleQueries.reassignJob.mockResolvedValue({ id: 7 });
    jobsService.resolveAssignedProviderUserIds.mockResolvedValue('[]');
});

describe('rescheduleItem local-only behavior', () => {
    test('a historically linked job is rescheduled locally and reports the decommissioned compatibility signal', async () => {
        jobsService.getJobById.mockResolvedValue({
            id: 7,
            zenbooker_job_id: 'zb_7',
            assigned_provider_user_ids: ['u1'],
        });

        const result = await scheduleService.rescheduleItem(CO, 'job', 7, START, END);

        expect(scheduleQueries.rescheduleJob).toHaveBeenCalledWith(CO, 7, START, END);
        expect(result.zb).toEqual({ linked: true, pushed: false, skipped: 'decommissioned' });
        expect(eventBus.emit).toHaveBeenCalledWith(
            CO,
            'job.rescheduled',
            expect.objectContaining({ job_id: 7, assignee_user_ids: ['u1'] }),
            expect.objectContaining({ aggregateType: 'job', aggregateId: 7 })
        );
    });

    test('an unlinked job keeps the existing not_linked compatibility signal', async () => {
        jobsService.getJobById.mockResolvedValue({
            id: 7,
            zenbooker_job_id: null,
            assigned_provider_user_ids: [],
        });

        const result = await scheduleService.rescheduleItem(CO, 'job', 7, START, END);

        expect(result.zb).toEqual({ linked: false, pushed: false, skipped: 'not_linked' });
    });

    test('non-job entities retain the not_a_job contract', async () => {
        const result = await scheduleService.rescheduleItem(CO, 'lead', 8, START, END);

        expect(scheduleQueries.rescheduleLead).toHaveBeenCalledWith(CO, 8, START, END);
        expect(result.zb).toEqual({ linked: false, pushed: false, skipped: 'not_a_job' });
        expect(jobsService.getJobById).not.toHaveBeenCalled();
    });

    test('NOT_FOUND remains a 404 and does not emit an event', async () => {
        scheduleQueries.rescheduleJob.mockResolvedValueOnce(null);

        await expect(scheduleService.rescheduleItem(CO, 'job', 7, START, END))
            .rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        expect(eventBus.emit).not.toHaveBeenCalled();
    });
});

describe('reassignItem local-only behavior', () => {
    test('persists the provider mirror and emits assignment events without an external side effect', async () => {
        const technicianUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        const crmUserId = '11111111-1111-4111-8111-111111111111';
        jobsService.getJobById.mockResolvedValue({
            id: 7,
            assigned_provider_user_ids: [],
        });
        jobsService.resolveAssignedProviderUserIds.mockResolvedValue(JSON.stringify([crmUserId]));

        const assignees = [{ id: technicianUuid, name: 'Native only' }];
        await scheduleService.reassignItem(CO, 'job', 7, assignees);

        expect(scheduleQueries.reassignJob).toHaveBeenCalledWith(
            CO,
            7,
            assignees,
            JSON.stringify([crmUserId])
        );
        expect(eventBus.emit).toHaveBeenCalledWith(
            CO,
            'job.assigned',
            expect.objectContaining({ job_id: 7, assignee_user_ids: [crmUserId] }),
            expect.any(Object)
        );
    });
});
