/**
 * SCHED-ROUTE-001 SR-12 — recalc edge cases not covered elsewhere:
 * address change, reassign/move union, multi-tech fan-out, reconcile
 * idempotency, and "schedule read makes zero Google calls".
 */
jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/db/routeQueries');
jest.mock('../backend/src/services/routeDistanceService');

const db = require('../backend/src/db/connection');
const routeQueries = require('../backend/src/db/routeQueries');
const distance = require('../backend/src/services/routeDistanceService');
const svc = require('../backend/src/services/routeSegmentService');

beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [] });
    global.fetch = jest.fn();
});

describe('address change → recalc of surviving pairs that touch the job', () => {
    it('re-stales and re-calculates every pair touching the changed job, even if the sequence is unchanged', async () => {
        routeQueries.getCompanyTimezone.mockResolvedValue('UTC');
        routeQueries.getParticipatingJobsForTechDay.mockResolvedValue([
            { id: 1, lat: 1, lng: 1, address: 'a' },
            { id: 2, lat: 2, lng: 2, address: 'b' },
            { id: 3, lat: 3, lng: 3, address: 'c' },
        ]);
        // Same sequence already active — without changedJobIds this is a no-op.
        routeQueries.getActiveSegments.mockResolvedValue([
            { from_job_id: 1, to_job_id: 2 }, { from_job_id: 2, to_job_id: 3 },
        ]);
        routeQueries.markSegmentsStale.mockResolvedValue(2);
        routeQueries.insertSegment.mockResolvedValue({ id: 7 });

        const res = await svc.reconcileTechDay('co', 'tech', '2026-06-15', { changedJobIds: [2] });

        // Both pairs touch job 2 → both stale + both recreated.
        expect(routeQueries.markSegmentsStale).toHaveBeenCalledWith('co', 'tech', '2026-06-15',
            expect.arrayContaining([['1', '2'], ['2', '3']]));
        expect(res.created).toBe(2);
        expect(res.enqueuedCalc).toBe(true);
    });
});

describe('reconcile idempotency — identical re-run writes nothing', () => {
    it('active === desired and no changed jobs → 0 stale, 0 created, no route_calc', async () => {
        routeQueries.getCompanyTimezone.mockResolvedValue('UTC');
        routeQueries.getParticipatingJobsForTechDay.mockResolvedValue([
            { id: 1, lat: 1, lng: 1, address: 'a' }, { id: 2, lat: 2, lng: 2, address: 'b' },
        ]);
        routeQueries.getActiveSegments.mockResolvedValue([{ from_job_id: 1, to_job_id: 2 }]);
        routeQueries.markSegmentsStale.mockResolvedValue(0);
        routeQueries.insertSegment.mockResolvedValue(null);   // ON CONFLICT DO NOTHING

        const res = await svc.reconcileTechDay('co', 'tech', '2026-06-15');

        expect(res.created).toBe(0);
        expect(res.stale).toBe(0);
        expect(res.enqueuedCalc).toBe(false);
        expect(routeQueries.insertSegment).not.toHaveBeenCalled();
    });
});

describe('recalcForJob — multi-tech fan-out + before/after union', () => {
    beforeEach(() => {
        routeQueries.getCompanyTimezone.mockResolvedValue('UTC');
        // Make each reconcile cheap: no jobs, no active segments.
        routeQueries.getParticipatingJobsForTechDay.mockResolvedValue([]);
        routeQueries.getActiveSegments.mockResolvedValue([]);
        routeQueries.markSegmentsStale.mockResolvedValue(0);
    });

    it('reconciles every (technician, day) the job now belongs to (fan-out by assigned_provider_user_ids)', async () => {
        routeQueries.getTechDaysForJob.mockResolvedValue([
            { technicianId: 'techA', scheduleDate: '2026-06-15' },
            { technicianId: 'techB', scheduleDate: '2026-06-15' },
        ]);
        const res = await svc.recalcForJob('co', 42, { coordsChanged: true });
        expect(res.techDays).toBe(2);
        const reconciled = routeQueries.getParticipatingJobsForTechDay.mock.calls.map(c => c[1]);
        expect(reconciled).toEqual(expect.arrayContaining(['techA', 'techB']));
    });

    it('unions before (vacated) and after tech-days and dedupes the overlap', async () => {
        routeQueries.getTechDaysForJob.mockResolvedValue([
            { technicianId: 'techA', scheduleDate: '2026-06-16' },  // moved here
        ]);
        const res = await svc.recalcForJob('co', 42, {
            beforeTechDays: [
                { technicianId: 'techA', scheduleDate: '2026-06-15' },  // vacated day
                { technicianId: 'techA', scheduleDate: '2026-06-16' },  // overlaps "after" → dedup
            ],
            coordsChanged: false,
        });
        // 2 unique: (techA,15) vacated + (techA,16) current — the duplicate collapses.
        expect(res.techDays).toBe(2);
    });
});

describe('schedule read makes zero Google calls (FR-009)', () => {
    const scheduleService = require('../backend/src/services/scheduleService');

    it('getRouteSegments returns stored rows without touching the distance service or fetch', async () => {
        routeQueries.getSegmentsForRange.mockResolvedValue([
            { id: 1, technician_id: 't', from_job_id: 1, to_job_id: 2, distance_meters: 5000, status: 'success' },
        ]);
        const r = await scheduleService.getRouteSegments('co', { from: '2026-06-15', to: '2026-06-15', technicianId: 't' }, { assignedOnly: false });
        expect(r.segments).toHaveLength(1);
        expect(distance.computePair).not.toHaveBeenCalled();
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
