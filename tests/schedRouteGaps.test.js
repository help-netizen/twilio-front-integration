/**
 * SCHED-ROUTE-001 gap-closure coverage:
 *  - Gap 1/2: updateJobLocation → geocoding_status + recalc (+ async geocode).
 *  - Gap 3:   createManualJob resolves ZB-shaped assigned_techs → crm mirror.
 *  - Gap 4:   ZB best-effort sync — enqueue on create; handler dedupe/success/failure.
 *  - Feature flag default; retention SQL.
 */
jest.mock('../backend/src/db/connection', () => ({ query: jest.fn(), pool: { end: jest.fn() } }));
jest.mock('../backend/src/db/membershipQueries');
jest.mock('../backend/src/db/routeQueries');
jest.mock('../backend/src/services/routeSegmentService');
jest.mock('../backend/src/services/zenbookerClient');

const db = require('../backend/src/db/connection');
const membershipQueries = require('../backend/src/db/membershipQueries');
const routeQueries = require('../backend/src/db/routeQueries');
const routeSeg = require('../backend/src/services/routeSegmentService');
const zb = require('../backend/src/services/zenbookerClient');

const jobsService = require('../backend/src/services/jobsService');
const agentHandlers = require('../backend/src/services/agentHandlers');
const flags = require('../backend/src/config/featureFlags');

beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
    delete process.env.FEATURE_ZENBOOKER_SYNC;
});

describe('feature flag default (C-12)', () => {
    it('ZB sync is ON by default, OFF when explicitly disabled', () => {
        delete process.env.FEATURE_ZENBOOKER_SYNC;
        expect(flags.isZenbookerSyncEnabled()).toBe(true);
        process.env.FEATURE_ZENBOOKER_SYNC = '0';
        expect(flags.isZenbookerSyncEnabled()).toBe(false);
        process.env.FEATURE_ZENBOOKER_SYNC = 'true';
        expect(flags.isZenbookerSyncEnabled()).toBe(true);
    });
});

describe('createManualJob (Gap 3 + Gap 4)', () => {
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

    it('enqueues a dedupe-guarded zb_job_sync when the flag is ON', async () => {
        membershipQueries.resolveProviderUserIds.mockResolvedValue([]);
        mockInsertReturning({ id: 5, zenbooker_job_id: null });
        await jobsService.createManualJob('co', { service_name: 'x' });
        expect(db.query.mock.calls.some(c => /INSERT INTO tasks/.test(c[0]) && /zb_job_sync/.test(JSON.stringify(c)))).toBe(true);
    });

    it('skips ZB sync when the flag is OFF', async () => {
        process.env.FEATURE_ZENBOOKER_SYNC = '0';
        mockInsertReturning({ id: 6, zenbooker_job_id: null });
        await jobsService.createManualJob('co', { service_name: 'x' });
        expect(db.query.mock.calls.some(c => /zb_job_sync/.test(JSON.stringify(c)))).toBe(false);
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

describe('zb_job_sync handler (Gap 4)', () => {
    const task = (job_id, address) => ({ company_id: 'co', agent_input: { job_id, address } });

    it('dedupe: a job already linked to ZenBooker is skipped (no createJob)', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 1, zenbooker_job_id: 'ZB-EXISTING' }] });
        const r = await agentHandlers.HANDLERS.zb_job_sync(task(1));
        expect(r.skipped).toBe('already_synced');
        expect(zb.createJob).not.toHaveBeenCalled();
    });

    it('success: creates in ZB once and stores zenbooker_job_id', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 2, zenbooker_job_id: null, address: '1 Main', start_date: null }] });
        zb.findTerritoryByPostalCode.mockResolvedValue('terr-1');
        zb.createJob.mockResolvedValue({ job_id: 'ZB-NEW' });
        const r = await agentHandlers.HANDLERS.zb_job_sync(task(2, { postal_code: '02118', city: 'Boston' }));
        expect(zb.createJob).toHaveBeenCalledTimes(1);
        expect(r).toMatchObject({ status: 'synced', zenbooker_job_id: 'ZB-NEW' });
        expect(db.query.mock.calls.some(c => /zb_sync_status = 'synced'/.test(c[0]))).toBe(true);
    });

    it('failure: records failed, keeps local job, never throws', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 3, zenbooker_job_id: null, address: 'x' }] });
        zb.findTerritoryByPostalCode.mockResolvedValue(null);
        zb.createJob.mockRejectedValue(new Error('ZB 500'));
        const r = await agentHandlers.HANDLERS.zb_job_sync(task(3, {}));
        expect(r.status).toBe('failed');
        expect(db.query.mock.calls.some(c => /zb_sync_status = 'failed'/.test(c[0]))).toBe(true);
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
