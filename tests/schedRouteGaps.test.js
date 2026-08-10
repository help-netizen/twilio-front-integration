/**
 * SCHED-ROUTE-001 gap-closure coverage:
 *  - Gap 1/2: updateJobLocation → geocoding_status + recalc (+ async geocode).
 *  - Gap 3:   createManualJob resolves ZB-shaped assigned_techs → crm mirror.
 *  - Retention SQL.
 */
jest.mock('../backend/src/db/connection', () => ({ query: jest.fn(), pool: { end: jest.fn() } }));
jest.mock('../backend/src/db/membershipQueries');
jest.mock('../backend/src/db/routeQueries');
jest.mock('../backend/src/services/routeSegmentService');

const db = require('../backend/src/db/connection');
const membershipQueries = require('../backend/src/db/membershipQueries');
const routeQueries = require('../backend/src/db/routeQueries');
const routeSeg = require('../backend/src/services/routeSegmentService');

const jobsService = require('../backend/src/services/jobsService');

beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('createManualJob (Gap 3)', () => {
    function mockInsertReturning(job) {
        db.query.mockImplementation(async (sql) => {
            if (/INSERT INTO jobs/.test(sql)) return { rows: [job] };
            return { rows: [], rowCount: 0 };
        });
    }

    it('resolves ZB-shaped assigned_techs to the internal crm mirror', async () => {
        membershipQueries.resolveProviderUserIds.mockResolvedValue(['crm-1']);
        mockInsertReturning({ id: 1, zenbooker_job_id: null });
        await jobsService.createManualJob('co', { service_name: 'Fix', assigned_techs: [{ id: 'zb-9', name: 'Bob' }] });
        expect(membershipQueries.resolveProviderUserIds).toHaveBeenCalledWith('co', ['zb-9']);
        const insert = db.query.mock.calls.find(c => /INSERT INTO jobs/.test(c[0]));
        expect(insert[1]).toContain(JSON.stringify(['crm-1']));   // assigned_provider_user_ids
    });

});

describe('updateJobLocation (Gap 1 + Gap 2)', () => {
    beforeEach(() => {
        routeQueries.getCompanyTimezone.mockResolvedValue('UTC');
        routeQueries.getTechDaysForJob.mockResolvedValue([{ technicianId: 't', scheduleDate: '2026-06-15' }]);
        routeSeg.enqueueGeocode.mockResolvedValue(undefined);
        routeSeg.recalcForJob.mockResolvedValue(undefined);
    });

    it('coords supplied → success status, recalc forced, no paid geocode', async () => {
        db.query.mockImplementation(async (sql) =>
            /UPDATE jobs SET/.test(sql) ? { rows: [{ id: 1, address: 'A', lat: 1, lng: 2, zenbooker_job_id: 'Z', zb_sync_status: 'synced' }] } : { rows: [], rowCount: 0 });
        await jobsService.updateJobLocation('co', 1, { address: 'A', lat: 1, lng: 2 });
        const upd = db.query.mock.calls.find(c => /UPDATE jobs SET/.test(c[0]));
        expect(upd[1]).toContain('success');
        expect(routeSeg.enqueueGeocode).not.toHaveBeenCalled();
        expect(routeSeg.recalcForJob).toHaveBeenCalledWith('co', 1,
            expect.objectContaining({ coordsChanged: true, beforeTechDays: [{ technicianId: 't', scheduleDate: '2026-06-15' }] }));
    });

    it('address only (no coords) → not_geocoded + async geocode enqueued', async () => {
        db.query.mockImplementation(async (sql) =>
            /UPDATE jobs SET/.test(sql) ? { rows: [{ id: 1, address: '123 Main', lat: null, lng: null, zenbooker_job_id: 'Z', zb_sync_status: 'synced' }] } : { rows: [], rowCount: 0 });
        await jobsService.updateJobLocation('co', 1, { address: '123 Main' });
        const upd = db.query.mock.calls.find(c => /UPDATE jobs SET/.test(c[0]));
        expect(upd[1]).toContain('not_geocoded');
        expect(routeSeg.enqueueGeocode).toHaveBeenCalledWith('co', 1);
    });
});

describe('retention SQL (Gap 5 / C-13)', () => {
    it('purgeStaleSegments + pruneRouteCache run parameterized deletes', async () => {
        const { purgeStaleSegments, pruneRouteCache } = jest.requireActual('../backend/src/db/routeQueries');
        db.query.mockResolvedValue({ rowCount: 4 });
        expect(await purgeStaleSegments(30)).toBe(4);
        expect(db.query.mock.calls[0][0]).toMatch(/DELETE FROM schedule_route_segments/);
        expect(db.query.mock.calls[0][1]).toEqual(['30']);
        expect(await pruneRouteCache(180)).toBe(4);
        expect(db.query.mock.calls[1][0]).toMatch(/DELETE FROM route_calculation_cache/);
        expect(db.query.mock.calls[1][1]).toEqual(['180']);
    });
});
