'use strict';

/**
 * ZB-DECOUPLE Phase C2 — createFromSlot assignment-input validation
 * (spec deferred #2: client assignee_id / assigned_techs used to reach the
 * authz-bearing columns unresolved).
 *
 * Contract:
 *  • assignee_id must be an ACTIVE member of THIS company (crm_users plane) —
 *    a foreign/nonexistent id (including an injected NATIVE technician uuid)
 *    is a 400 INVALID_ASSIGNEE and nothing is written;
 *  • every assigned_techs[].id must resolve on the native roster —
 *    off-roster ids are a 400 INVALID_TECHNICIAN and nothing is written;
 *  • valid legacy inputs are canonicalized to technicians.id before writes.
 */

const mockCreateTask = jest.fn();
const mockGetActiveMembershipInCompany = jest.fn();
const mockCanonicalizeAssignments = jest.fn();
const mockCreateManualJob = jest.fn();

jest.mock('../../src/db/scheduleQueries', () => ({
    createTask: (...args) => mockCreateTask(...args),
}));
jest.mock('../../src/db/technicianDirectoryQueries', () => ({}));
jest.mock('../../src/services/jobActivityService', () => ({ logJobActivity: jest.fn() }));
jest.mock('../../src/services/transactionService', () => ({ withTransaction: jest.fn() }));
jest.mock('../../src/services/eventBus', () => ({ emit: jest.fn() }));
jest.mock('../../src/db/membershipQueries', () => ({
    getActiveMembershipInCompany: (...args) => mockGetActiveMembershipInCompany(...args),
}));
jest.mock('../../src/services/technicianRosterService', () => ({
    canonicalizeAssignments: (...args) => mockCanonicalizeAssignments(...args),
}));
jest.mock('../../src/services/jobsService', () => ({
    createManualJob: (...args) => mockCreateManualJob(...args),
}));
jest.mock('../../src/services/routeSegmentService', () => ({
    enqueueGeocode: jest.fn(),
    recalcForJob: jest.fn(),
}));

const scheduleService = require('../../src/services/scheduleService');

const COMPANY = '00000000-0000-0000-0000-000000000001';
const NATIVE_UUID = '73edf9e7-bbbf-4129-a690-2eb6fc72a1ef';

describe('scheduleService.createFromSlot — assignment validation (ZB-DECOUPLE C2)', () => {
    beforeEach(() => {
        mockCreateTask.mockReset().mockResolvedValue({ id: 7 });
        mockGetActiveMembershipInCompany.mockReset();
        mockCanonicalizeAssignments.mockReset()
            .mockImplementation(async (_companyId, assignments) => assignments);
        mockCreateManualJob.mockReset().mockResolvedValue({ id: 1617 });
    });

    it('task: a valid company member passes and reaches createTask unchanged', async () => {
        mockGetActiveMembershipInCompany.mockResolvedValue({ id: 'm1', user_id: '42' });
        const result = await scheduleService.createFromSlot(COMPANY, 'task', {
            title: 'Call back', assignee_id: '42',
        });
        expect(mockGetActiveMembershipInCompany).toHaveBeenCalledWith('42', COMPANY);
        expect(mockCreateTask).toHaveBeenCalledWith(COMPANY, expect.objectContaining({ assignedProviderId: '42' }));
        expect(result.entity_type).toBe('task');
    });

    it('task: a non-member assignee is a 400 and nothing is written', async () => {
        mockGetActiveMembershipInCompany.mockResolvedValue(null);
        await expect(
            scheduleService.createFromSlot(COMPANY, 'task', { title: 'x', assignee_id: '999' })
        ).rejects.toMatchObject({ code: 'INVALID_ASSIGNEE', httpStatus: 400 });
        expect(mockCreateTask).not.toHaveBeenCalled();
    });

    it('task: an injected NATIVE technician uuid is rejected on the crm plane', async () => {
        // The spec scenario: a native uuid must not slip into authz-bearing columns.
        mockGetActiveMembershipInCompany.mockResolvedValue(null);
        await expect(
            scheduleService.createFromSlot(COMPANY, 'task', { title: 'x', assignee_id: NATIVE_UUID })
        ).rejects.toMatchObject({ code: 'INVALID_ASSIGNEE', httpStatus: 400 });
        expect(mockCreateTask).not.toHaveBeenCalled();
    });

    it('task: no assignee at all passes (unassigned slot task)', async () => {
        await scheduleService.createFromSlot(COMPANY, 'task', { title: 'unassigned' });
        expect(mockGetActiveMembershipInCompany).not.toHaveBeenCalled();
        expect(mockCreateTask).toHaveBeenCalled();
    });

    it('job: an off-roster assigned_techs id is a 400 and no job is created', async () => {
        mockCanonicalizeAssignments.mockRejectedValueOnce(
            Object.assign(new Error('Technician not found'), { httpStatus: 404 })
        );
        await expect(
            scheduleService.createFromSlot(COMPANY, 'job', {
                title: 'Repair', assigned_techs: [{ id: 'foreign-zb-id', name: 'Evil' }],
            })
        ).rejects.toMatchObject({ code: 'INVALID_TECHNICIAN', httpStatus: 400 });
        expect(mockCreateManualJob).not.toHaveBeenCalled();
    });

    it('job: a roster-valid legacy id reaches createManualJob as a native UUID', async () => {
        mockGetActiveMembershipInCompany.mockResolvedValue({ id: 'm1' });
        mockCanonicalizeAssignments.mockResolvedValueOnce([{ id: NATIVE_UUID, name: 'Robert' }]);
        const result = await scheduleService.createFromSlot(COMPANY, 'job', {
            title: 'Repair',
            assignee_id: '42',
            assigned_techs: [{ id: '1770085964093x308143070595776500', name: 'Robert' }],
        });
        expect(mockCanonicalizeAssignments).toHaveBeenCalledWith(
            COMPANY,
            [{ id: '1770085964093x308143070595776500', name: 'Robert' }]
        );
        expect(mockCreateManualJob).toHaveBeenCalledWith(COMPANY, expect.objectContaining({
            assignee_id: '42',
            assigned_techs: [{ id: NATIVE_UUID, name: 'Robert' }],
        }), null);
        expect(result.entity_id).toBe(1617);
    });

    it('job: an assigned_techs entry without an id is a 400', async () => {
        mockCanonicalizeAssignments.mockRejectedValueOnce(
            Object.assign(new Error('Technician assignments require an id'), { httpStatus: 400 })
        );
        await expect(
            scheduleService.createFromSlot(COMPANY, 'job', { title: 'x', assigned_techs: [{ name: 'No Id' }] })
        ).rejects.toMatchObject({ code: 'INVALID_TECHNICIAN', httpStatus: 400 });
        expect(mockCreateManualJob).not.toHaveBeenCalled();
    });
});
