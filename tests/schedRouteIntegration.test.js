/**
 * SCHED-ROUTE-001 — createFromSlot(job) (FR-001) + route-segments provider scope (FR-009/PF007).
 */
jest.mock('../backend/src/db/scheduleQueries');
jest.mock('../backend/src/services/jobsService');
jest.mock('../backend/src/services/routeSegmentService');
jest.mock('../backend/src/db/routeQueries');

const scheduleService = require('../backend/src/services/scheduleService');
const jobsService = require('../backend/src/services/jobsService');
const routeSeg = require('../backend/src/services/routeSegmentService');
const routeQueries = require('../backend/src/db/routeQueries');

beforeEach(() => jest.clearAllMocks());

describe('createFromSlot(job) — FR-001', () => {
    it('creates a manual job and enqueues geocode + recalc when address has no coords', async () => {
        jobsService.createManualJob.mockResolvedValue({ id: 42 });
        const r = await scheduleService.createFromSlot('co', 'job', {
            title: 'Fix fridge', address: '123 Main', assignee_id: 'u1', start_at: '2026-06-15T14:00:00Z',
        });
        expect(jobsService.createManualJob).toHaveBeenCalledWith('co', expect.objectContaining({ address: '123 Main', assignee_id: 'u1' }));
        expect(routeSeg.enqueueGeocode).toHaveBeenCalledWith('co', 42);
        expect(routeSeg.recalcForJob).toHaveBeenCalledWith('co', 42, { coordsChanged: true });
        expect(r).toMatchObject({ entity_type: 'job', entity_id: 42 });
    });

    it('skips paid geocode when coords are supplied by the frontend', async () => {
        jobsService.createManualJob.mockResolvedValue({ id: 7 });
        await scheduleService.createFromSlot('co', 'job', { title: 'x', address: 'A', lat: 1, lng: 2, assignee_id: 'u1' });
        expect(routeSeg.enqueueGeocode).not.toHaveBeenCalled();
        expect(routeSeg.recalcForJob).toHaveBeenCalledWith('co', 7, { coordsChanged: true });
    });

    it('lead-from-slot is still 501', async () => {
        await expect(scheduleService.createFromSlot('co', 'lead', {})).rejects.toMatchObject({ httpStatus: 501 });
    });
});

describe('getRouteSegments — provider scope (PF007)', () => {
    it('forces technician_id to own crm_user for assigned_only providers', async () => {
        routeQueries.getSegmentsForRange.mockResolvedValue([{ id: 1 }]);
        await scheduleService.getRouteSegments('co',
            { from: '2026-06-15', to: '2026-06-15', technicianId: 'someoneElse' },
            { assignedOnly: true, userId: 'me' });
        expect(routeQueries.getSegmentsForRange).toHaveBeenCalledWith('co', expect.objectContaining({ technicianId: 'me' }));
    });

    it('assigned_only with no resolved user → empty (no leak), no query', async () => {
        const r = await scheduleService.getRouteSegments('co', {}, { assignedOnly: true, userId: null });
        expect(r).toEqual({ segments: [] });
        expect(routeQueries.getSegmentsForRange).not.toHaveBeenCalled();
    });

    it('tenant-wide provider passes the requested technician filter through', async () => {
        routeQueries.getSegmentsForRange.mockResolvedValue([]);
        await scheduleService.getRouteSegments('co', { technicianId: 't1' }, { assignedOnly: false });
        expect(routeQueries.getSegmentsForRange).toHaveBeenCalledWith('co', expect.objectContaining({ technicianId: 't1' }));
    });
});
