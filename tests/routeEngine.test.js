/**
 * SCHED-ROUTE-001 — route engine: distance cache-first, reconcile, statuses.
 */
jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/db/routeQueries');

const db = require('../backend/src/db/connection');
const routeQueries = require('../backend/src/db/routeQueries');

beforeEach(() => { jest.clearAllMocks(); db.query.mockResolvedValue({ rows: [] }); });

describe('routeDistanceService.computePair (cache-first, no-traffic)', () => {
    const distance = require('../backend/src/services/routeDistanceService');
    beforeEach(() => { global.fetch = jest.fn(); process.env.GOOGLE_GEOCODING_KEY = 'k'; });

    it('cache hit → no Google call', async () => {
        routeQueries.getCache.mockResolvedValue({ distance_meters: 5000, duration_minutes: 10 });
        const r = await distance.computePair({ lat: 1, lng: 2 }, { lat: 3, lng: 4 });
        expect(r).toMatchObject({ status: 'success', fromCache: true, distanceMeters: 5000, durationMinutes: 10 });
        expect(global.fetch).not.toHaveBeenCalled();
        expect(routeQueries.putCache).not.toHaveBeenCalled();
    });

    it('cache miss → Google Distance Matrix + putCache; NO departure_time (no traffic)', async () => {
        routeQueries.getCache.mockResolvedValue(null);
        global.fetch.mockResolvedValue({ json: async () => ({ status: 'OK', rows: [{ elements: [{ status: 'OK', distance: { value: 8000 }, duration: { value: 600 } }] }] }) });
        const r = await distance.computePair({ lat: 1, lng: 2 }, { lat: 3, lng: 4 });
        expect(r).toMatchObject({ status: 'success', fromCache: false, distanceMeters: 8000, durationMinutes: 10 });
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const calledUrl = String(global.fetch.mock.calls[0][0]);
        expect(calledUrl).toContain('distancematrix');
        expect(calledUrl).not.toContain('departure_time');
        expect(routeQueries.putCache).toHaveBeenCalled();
    });

    it('Google failure → failed; not cached as success', async () => {
        routeQueries.getCache.mockResolvedValue(null);
        global.fetch.mockResolvedValue({ json: async () => ({ status: 'OVER_QUERY_LIMIT' }) });
        const r = await distance.computePair({ lat: 1, lng: 2 }, { lat: 3, lng: 4 });
        expect(r.status).toBe('failed');
        expect(routeQueries.putCache).not.toHaveBeenCalled();
    });
});

describe('routeSegmentService.reconcileTechDay (idempotent recalc)', () => {
    const svc = require('../backend/src/services/routeSegmentService');

    it('inserts pending for new adjacent pairs and enqueues route_calc', async () => {
        routeQueries.getCompanyTimezone.mockResolvedValue('America/New_York');
        routeQueries.getParticipatingJobsForTechDay.mockResolvedValue([
            { id: 1, lat: 1, lng: 1, address: 'a' }, { id: 2, lat: 2, lng: 2, address: 'b' }, { id: 3, lat: 3, lng: 3, address: 'c' },
        ]);
        routeQueries.getActiveSegments.mockResolvedValue([]);
        routeQueries.markSegmentsStale.mockResolvedValue(0);
        routeQueries.insertSegment.mockResolvedValue({ id: 99 });
        const res = await svc.reconcileTechDay('co', 'tech', '2026-06-15');
        expect(res.created).toBe(2);            // pairs (1,2),(2,3)
        expect(res.enqueuedCalc).toBe(true);
        // route_calc task enqueued via tasks insert
        expect(db.query.mock.calls.some(c => /INSERT INTO tasks/.test(c[0]) && /route_calc/.test(JSON.stringify(c)))).toBe(true);
    });

    it('marks removed pairs stale and creates the repaired pair', async () => {
        routeQueries.getCompanyTimezone.mockResolvedValue('UTC');
        routeQueries.getParticipatingJobsForTechDay.mockResolvedValue([
            { id: 1, lat: 1, lng: 1, address: 'a' }, { id: 3, lat: 3, lng: 3, address: 'c' }, // job 2 removed
        ]);
        routeQueries.getActiveSegments.mockResolvedValue([
            { from_job_id: 1, to_job_id: 2 }, { from_job_id: 2, to_job_id: 3 },
        ]);
        routeQueries.markSegmentsStale.mockResolvedValue(2);
        routeQueries.insertSegment.mockResolvedValue({ id: 1 });
        const res = await svc.reconcileTechDay('co', 'tech', '2026-06-15');
        expect(routeQueries.markSegmentsStale).toHaveBeenCalledWith('co', 'tech', '2026-06-15',
            expect.arrayContaining([['1', '2'], ['2', '3']]));
        expect(res.created).toBe(1);            // (1,3)
    });

    it('a pair with a coordless job → missing_address, not calculable, no route_calc', async () => {
        routeQueries.getCompanyTimezone.mockResolvedValue('UTC');
        routeQueries.getParticipatingJobsForTechDay.mockResolvedValue([
            { id: 1, lat: 1, lng: 1, address: 'a' }, { id: 2, lat: null, lng: null, address: null },
        ]);
        routeQueries.getActiveSegments.mockResolvedValue([]);
        routeQueries.markSegmentsStale.mockResolvedValue(0);
        routeQueries.insertSegment.mockResolvedValue({ id: 5 });
        const res = await svc.reconcileTechDay('co', 'tech', '2026-06-15');
        expect(routeQueries.insertSegment).toHaveBeenCalledWith(expect.objectContaining({ status: 'missing_address' }));
        expect(res.enqueuedCalc).toBe(false);
    });

    it('pairInitialStatus: address but no coords → address_needs_review', () => {
        expect(svc.pairInitialStatus({ lat: 1, lng: 1, address: 'a' }, { lat: null, lng: null, address: '500 Oak' }))
            .toBe('address_needs_review');
        expect(svc.pairInitialStatus({ lat: 1, lng: 1 }, { lat: 2, lng: 2 })).toBe('pending');
    });
});
