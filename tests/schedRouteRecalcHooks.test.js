/**
 * SCHED-ROUTE-VIS-001 RV-04a — FR-1 recalc hooks (TC-RV-01..17).
 *
 * Covers the event-driven route-recalc hooks added by RV-01:
 *   - jobsService.createDirectJob (both branches: ZB-success + local fallback)
 *   - jobsService.syncFromZenbooker (existing capture-before-UPDATE, coords
 *     delta / webhook echo / null-coords, create branch, delayed auto-assign)
 *   - POST /api/jobs/:id/reschedule (capture before ZB-assign + UPDATE, recalc
 *     after UPDATE, non-fatal failure, companyId guard, cross-tenant 404)
 *
 * Mock style mirrors tests/schedRouteRecalc.test.js (mocked db.query +
 * mocked layers, service under test is REAL); route cases are supertest over a
 * mini-app with a fake auth middleware (style of tests/routes/tasks.test.js).
 * global.fetch is asserted untouched in EVERY case (TC-RV-34 runtime guard).
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn(), pool: { end: jest.fn() } }));
jest.mock('../backend/src/db/routeQueries');
jest.mock('../backend/src/services/routeSegmentService');
jest.mock('../backend/src/db/membershipQueries');
jest.mock('../backend/src/services/zenbookerClient', () => ({
    findTerritoryByPostalCode: jest.fn(),
    createJob: jest.fn(),
    getJob: jest.fn(),
    rescheduleJob: jest.fn(),
    assignProviders: jest.fn(),
    addJobNote: jest.fn(),
}));
jest.mock('../backend/src/services/contactDedupeService', () => ({ resolveContact: jest.fn() }));
jest.mock('../backend/src/services/eventBus', () => ({ emit: jest.fn() }));
jest.mock('../backend/src/services/eventService', () => ({}));
jest.mock('../backend/src/services/noteAttachmentsService', () => ({ MAX_FILE_SIZE: 1, MAX_FILES_PER_NOTE: 1 }));
jest.mock('../backend/src/services/stripePaymentsService', () => ({ StripePaymentsError: class extends Error {} }));
jest.mock('../backend/src/services/realtimeService', () => ({ publishJobUpdate: jest.fn() }));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));

const express = require('express');
const request = require('supertest');

const db = require('../backend/src/db/connection');
const routeQueries = require('../backend/src/db/routeQueries');
const routeSeg = require('../backend/src/services/routeSegmentService');
const membershipQueries = require('../backend/src/db/membershipQueries');
const zb = require('../backend/src/services/zenbookerClient');
const contactDedupe = require('../backend/src/services/contactDedupeService');
const eventBus = require('../backend/src/services/eventBus');
const jobsService = require('../backend/src/services/jobsService');
const jobsRouter = require('../backend/src/routes/jobs');

const CO = 'co-1';
const BEFORE_TD = [{ technicianId: 'tech-A', scheduleDate: '2026-07-14' }];

// Real timer reference captured BEFORE any per-test patching, so flushes keep
// working while global.setTimeout is stubbed to fire instantly.
const REAL_SET_TIMEOUT = global.setTimeout;
const microFlush = () => new Promise(r => setImmediate(r));
const flushMs = (ms = 25) => new Promise(r => REAL_SET_TIMEOUT(r, ms));
async function waitFor(cond, timeout = 2000) {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeout) throw new Error('waitFor timeout');
        await new Promise(r => REAL_SET_TIMEOUT(r, 5));
    }
}
/** Run fn with every setTimeout delay collapsed to 0 (delayed re-fetch / bg sync). */
async function withInstantTimers(fn) {
    global.setTimeout = (cb, _ms, ...args) => REAL_SET_TIMEOUT(cb, 0, ...args);
    try { return await fn(); } finally { global.setTimeout = REAL_SET_TIMEOUT; }
}

function jobRow(over = {}) {
    return {
        id: 42, company_id: CO, blanc_status: 'Submitted',
        customer_name: 'Jane Doe', address: '1 Main St, Boston', city: 'Boston',
        lat: 42.1, lng: -71.2,
        start_date: new Date('2026-07-15T10:00:00Z'), end_date: new Date('2026-07-15T12:00:00Z'),
        assigned_techs: [], assigned_provider_user_ids: ['tech-A'], notes: [],
        zenbooker_job_id: null, zb_canceled: false, zb_rescheduled: false, zb_status: 'scheduled',
        created_at: new Date('2026-07-01T00:00:00Z'), updated_at: new Date('2026-07-01T00:00:00Z'),
        ...over,
    };
}

/** Invocation order of the first db.query call whose SQL matches `re`. */
function dbOrderOf(re) {
    const idx = db.query.mock.calls.findIndex(c => re.test(c[0]));
    expect(idx).toBeGreaterThanOrEqual(0);
    return db.query.mock.invocationCallOrder[idx];
}

beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
    routeSeg.recalcForJob.mockResolvedValue({ techDays: 0, results: [] });
    routeSeg.enqueueGeocode.mockResolvedValue();
    routeQueries.getCompanyTimezone.mockResolvedValue('America/New_York');
    routeQueries.getTechDaysForJob.mockResolvedValue(BEFORE_TD);
    membershipQueries.resolveProviderUserIds.mockResolvedValue([]);
    eventBus.emit.mockResolvedValue(undefined);
    contactDedupe.resolveContact.mockResolvedValue({ contact_id: 5, status: 'created' });
});

afterEach(() => {
    // TC-RV-34 (runtime half): no hook or route path ever touches Google/fetch.
    expect(global.fetch).not.toHaveBeenCalled();
    console.error.mockRestore();
    console.log.mockRestore();
    console.warn.mockRestore();
});

// =============================================================================
// createDirectJob — TC-RV-01..06
// =============================================================================

const DIRECT_INPUT = {
    contact: { name: 'Jane Doe', phone: '+16175551234' },
    address: { line1: '1 Main St', city: 'Boston', postal_code: '02134' },
    slot: { start: '2026-07-15T10:00:00Z', end: '2026-07-15T12:00:00Z' },
    job_type: 'Fridge repair',
};

function primeDirectCreate(row, { zbFails = false } = {}) {
    zb.findTerritoryByPostalCode.mockResolvedValue('terr_1');
    if (zbFails) {
        const err = new Error('request failed');
        err.response = { data: { error: { message: 'INVALID_ADDRESS' } } };
        zb.createJob.mockRejectedValue(err);
    } else {
        zb.createJob.mockResolvedValue({ job_id: 'zb-1' });
        zb.getJob.mockResolvedValue({ job_number: 'JN-1', status: 'scheduled' });
    }
    db.query.mockImplementation(async (sql) => {
        if (/INSERT INTO jobs/.test(sql)) return { rows: [row] };
        return { rows: [], rowCount: 0 };
    });
}

describe('createDirectJob → recalc hook (FR-1, S-1..S-3)', () => {
    // TC-RV-01: ZB-success branch → exactly ONE recalcForJob({coordsChanged:true}),
    // no beforeTechDays (new job), no second fire from the createJob upsert (INV-8).
    test('TC-RV-01: ZB-success → single recalcForJob with {coordsChanged:true}', async () => {
        primeDirectCreate(jobRow());
        const out = await jobsService.createDirectJob(CO, DIRECT_INPUT);
        expect(out.job_id).toBe(42);
        expect(routeSeg.recalcForJob).toHaveBeenCalledTimes(1);
        expect(routeSeg.recalcForJob).toHaveBeenCalledWith(CO, 42, { coordsChanged: true });
        // opts object is EXACTLY {coordsChanged:true} — no beforeTechDays key.
        expect(routeSeg.recalcForJob.mock.calls[0][2]).toEqual({ coordsChanged: true });
    });

    // TC-RV-02: ZB down → local fallback branch still fires the same single recalc.
    test('TC-RV-02: ZB failure fallback → same single recalc on the local job', async () => {
        primeDirectCreate(jobRow({ id: 43 }), { zbFails: true });
        const out = await jobsService.createDirectJob(CO, DIRECT_INPUT);
        expect(out.job_id).toBe(43);
        expect(out.zb_warning).toBe('INVALID_ADDRESS');
        expect(routeSeg.recalcForJob).toHaveBeenCalledTimes(1);
        expect(routeSeg.recalcForJob).toHaveBeenCalledWith(CO, 43, { coordsChanged: true });
    });

    // TC-RV-03: address without coords → enqueueGeocode fires too; both are
    // fire-and-forget (a rejecting geocode never breaks the create).
    test('TC-RV-03: address without coords → recalc AND enqueueGeocode, both non-fatal', async () => {
        primeDirectCreate(jobRow({ lat: null, lng: null }));
        routeSeg.enqueueGeocode.mockRejectedValue(new Error('gc down'));
        const out = await jobsService.createDirectJob(CO, DIRECT_INPUT);
        expect(out.job_id).toBe(42);
        expect(routeSeg.recalcForJob).toHaveBeenCalledWith(CO, 42, { coordsChanged: true });
        expect(routeSeg.enqueueGeocode).toHaveBeenCalledWith(CO, 42);
        await microFlush();
        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining('geocode enqueue failed'), 'gc down');
    });

    // TC-RV-04 (negative): coords already present → NO geocode; recalc once.
    test('TC-RV-04: coords present → enqueueGeocode NOT called', async () => {
        primeDirectCreate(jobRow());
        await jobsService.createDirectJob(CO, DIRECT_INPUT);
        expect(routeSeg.enqueueGeocode).not.toHaveBeenCalled();
        expect(routeSeg.recalcForJob).toHaveBeenCalledTimes(1);
    });

    // TC-RV-05 (S-2/E-9): (a) hook level — no start_date still calls recalc once;
    // (b) service level — REAL routeSegmentService with 0 tech-days is a cheap no-op.
    test('TC-RV-05a: job without date → hook still fires recalc once (no-op downstream)', async () => {
        primeDirectCreate(jobRow({ start_date: null, end_date: null }));
        await jobsService.createDirectJob(CO, DIRECT_INPUT);
        expect(routeSeg.recalcForJob).toHaveBeenCalledTimes(1);
    });

    test('TC-RV-05b: real recalcForJob with no tech-days → no reconcile, no inserts, no route_calc', async () => {
        const realRouteSeg = jest.requireActual('../backend/src/services/routeSegmentService');
        routeQueries.getTechDaysForJob.mockResolvedValue([]);
        const res = await realRouteSeg.recalcForJob(CO, 42, { coordsChanged: true });
        expect(res.techDays).toBe(0);
        expect(routeQueries.getParticipatingJobsForTechDay).not.toHaveBeenCalled();
        expect(routeQueries.insertSegment).not.toHaveBeenCalled();
        expect(routeQueries.markSegmentsStale).not.toHaveBeenCalled();
        // No route_calc task enqueued.
        expect(db.query.mock.calls.some(c => /INSERT INTO tasks/.test(c[0]))).toBe(false);
    });

    // TC-RV-06 (INV-7): a rejecting recalc never breaks the create.
    test('TC-RV-06: recalcForJob rejection is non-fatal for createDirectJob', async () => {
        primeDirectCreate(jobRow());
        routeSeg.recalcForJob.mockRejectedValue(new Error('boom'));
        const out = await jobsService.createDirectJob(CO, DIRECT_INPUT);
        expect(out.job_id).toBe(42);
        await microFlush();
        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining('route recalc failed'), 'boom');
    });
});

// =============================================================================
// syncFromZenbooker — TC-RV-07..13
// =============================================================================

function zbPayload(over = {}) {
    return {
        status: 'scheduled', job_number: 'JN-1',
        start_date: '2026-07-15T10:00:00Z',
        service_address: { formatted: '1 Main St, Boston', city: 'Boston', lat: 42.1, lng: -71.2 },
        assigned_providers: [{ id: 'zb-t1' }],
        ...over,
    };
}

function primeSyncExisting(existingRow) {
    db.query.mockImplementation(async (sql) => {
        if (/SELECT \* FROM jobs WHERE zenbooker_job_id/.test(sql)) return { rows: [existingRow] };
        return { rows: [], rowCount: 1 };
    });
}

function primeSyncCreate(createdRow) {
    db.query.mockImplementation(async (sql) => {
        if (/SELECT \* FROM jobs WHERE zenbooker_job_id/.test(sql)) return { rows: [] };
        if (/INSERT INTO jobs/.test(sql)) return { rows: [createdRow] };
        return { rows: [], rowCount: 1 };
    });
}

describe('syncFromZenbooker existing branch (FR-1, S-5/S-6/E-11)', () => {
    // pg returns numerics as strings — existing coords are strings on purpose
    // (the hook must compare via Number(), TC-RV-08/09).
    const existing = () => jobRow({ zenbooker_job_id: 'zb-9', lat: '42.1', lng: '-71.2' });

    // TC-RV-07 (S-5): beforeTechDays captured BEFORE the UPDATE, passed to recalc.
    test('TC-RV-07: beforeTechDays captured before UPDATE and passed to recalcForJob', async () => {
        primeSyncExisting(existing());
        const res = await jobsService.syncFromZenbooker('zb-9', zbPayload(), CO);
        expect(res.updated).toBe(true);
        // capture (getTechDaysForJob) strictly precedes the UPDATE jobs query.
        const captureOrder = routeQueries.getTechDaysForJob.mock.invocationCallOrder[0];
        expect(captureOrder).toBeLessThan(dbOrderOf(/UPDATE jobs SET\s+zb_status = \$1/));
        expect(routeSeg.recalcForJob).toHaveBeenCalledTimes(1);
        const [co, jobId, opts] = routeSeg.recalcForJob.mock.calls[0];
        expect(co).toBe(CO);
        expect(jobId).toBe(42);
        expect(opts.beforeTechDays).toEqual(BEFORE_TD);
    });

    // TC-RV-08 (S-5): real numeric delta (string '42.1' vs 42.2) → coordsChanged=true.
    test('TC-RV-08: coordsChanged=true only on a real numeric coords delta', async () => {
        primeSyncExisting(existing());
        await jobsService.syncFromZenbooker('zb-9',
            zbPayload({ service_address: { formatted: '1 Main St', lat: 42.2, lng: -71.2 } }), CO);
        expect(routeSeg.recalcForJob.mock.calls[0][2].coordsChanged).toBe(true);
    });

    // TC-RV-09 (S-6/INV-11): webhook echo — same values (string '42.1' vs number
    // 42.1) → coordsChanged=false; service level: desired==active writes nothing.
    test('TC-RV-09a: ZB webhook echo → coordsChanged=false', async () => {
        primeSyncExisting(existing());
        await jobsService.syncFromZenbooker('zb-9', zbPayload(), CO);   // lat 42.1 === Number('42.1')
        expect(routeSeg.recalcForJob.mock.calls[0][2].coordsChanged).toBe(false);
    });

    test('TC-RV-09b: real service echo path — desired==active → 0 stale, 0 insert, no route_calc, no fetch', async () => {
        const realRouteSeg = jest.requireActual('../backend/src/services/routeSegmentService');
        routeQueries.getTechDaysForJob.mockResolvedValue(BEFORE_TD);
        routeQueries.getParticipatingJobsForTechDay.mockResolvedValue([
            { id: 1, lat: 1, lng: 1, address: 'a' }, { id: 2, lat: 2, lng: 2, address: 'b' },
        ]);
        routeQueries.getActiveSegments.mockResolvedValue([{ from_job_id: 1, to_job_id: 2 }]);
        routeQueries.markSegmentsStale.mockResolvedValue(0);
        const res = await realRouteSeg.recalcForJob(CO, 42, { beforeTechDays: [], coordsChanged: false });
        expect(res.results[0]).toEqual({ stale: 0, created: 0, enqueuedCalc: false });
        expect(routeQueries.markSegmentsStale).toHaveBeenCalledWith(CO, 'tech-A', '2026-07-14', []);
        expect(routeQueries.insertSegment).not.toHaveBeenCalled();
        expect(db.query.mock.calls.some(c => /INSERT INTO tasks/.test(c[0]))).toBe(false);
    });

    // TC-RV-10 (E-11, negative): partial payload with null coords → coordsChanged=false.
    test('TC-RV-10: ZB sends lat/lng=null → coordsChanged=false', async () => {
        primeSyncExisting(existing());
        await jobsService.syncFromZenbooker('zb-9',
            zbPayload({ service_address: { formatted: '1 Main St', lat: null, lng: null } }), CO);
        expect(routeSeg.recalcForJob.mock.calls[0][2].coordsChanged).toBe(false);
    });

    // TC-RV-13 (negative): capture failure degrades to [] and sync continues.
    test('TC-RV-13: beforeTechDays capture failure → [], sync still succeeds', async () => {
        primeSyncExisting(existing());
        routeQueries.getTechDaysForJob.mockRejectedValueOnce(new Error('db'));
        const res = await jobsService.syncFromZenbooker('zb-9', zbPayload(), CO);
        expect(res.updated).toBe(true);
        // The UPDATE still happened.
        expect(db.query.mock.calls.some(c => /UPDATE jobs SET\s+zb_status = \$1/.test(c[0]))).toBe(true);
        expect(routeSeg.recalcForJob).toHaveBeenCalledTimes(1);
        expect(routeSeg.recalcForJob.mock.calls[0][2].beforeTechDays).toEqual([]);
    });
});

describe('syncFromZenbooker create branch (FR-1, S-4/S-7)', () => {
    // TC-RV-11 (S-4): new ZB job → recalc({coordsChanged:true}); geocode only
    // when the address arrived without coordinates.
    test('TC-RV-11: create branch → recalc; geocode when address has no coords', async () => {
        primeSyncCreate(jobRow({ id: 91, zenbooker_job_id: 'zb-9', lat: null, lng: null }));
        const res = await jobsService.syncFromZenbooker('zb-9',
            zbPayload({ unable_to_auto_assign: true }), CO);
        expect(res.created).toBe(true);
        expect(routeSeg.recalcForJob).toHaveBeenCalledTimes(1);
        expect(routeSeg.recalcForJob).toHaveBeenCalledWith(CO, 91, { coordsChanged: true });
        expect(routeSeg.enqueueGeocode).toHaveBeenCalledWith(CO, 91);
    });

    test('TC-RV-11 (negative half): create branch with coords → geocode NOT enqueued', async () => {
        primeSyncCreate(jobRow({ id: 91, zenbooker_job_id: 'zb-9' }));   // lat/lng present
        await jobsService.syncFromZenbooker('zb-9', zbPayload({ unable_to_auto_assign: true }), CO);
        expect(routeSeg.recalcForJob).toHaveBeenCalledWith(CO, 91, { coordsChanged: true });
        expect(routeSeg.enqueueGeocode).not.toHaveBeenCalled();
    });

    // TC-RV-12 (S-7): delayed auto-assign re-fetch → recalc with {} AFTER the
    // mirror UPDATE; opts carry neither beforeTechDays nor coordsChanged.
    test('TC-RV-12: delayed auto-assign → recalcForJob(companyId, jobId, {}) after mirror UPDATE', async () => {
        primeSyncCreate(jobRow({ id: 91, zenbooker_job_id: 'zb-9' }));
        zb.getJob.mockResolvedValue({ assigned_providers: [{ id: 'zb-t9' }] });
        membershipQueries.resolveProviderUserIds.mockResolvedValue(['u-9']);

        await withInstantTimers(async () => {
            // No assigned_providers + not unable_to_auto_assign → delayed re-fetch fires.
            await jobsService.syncFromZenbooker('zb-9',
                zbPayload({ assigned_providers: [], unable_to_auto_assign: false }), CO);
            await waitFor(() => routeSeg.recalcForJob.mock.calls.length >= 2);
        });

        // First fire: the create-branch recalc; second: the delayed-assign recalc.
        expect(routeSeg.recalcForJob).toHaveBeenCalledTimes(2);
        expect(routeSeg.recalcForJob.mock.calls[0]).toEqual([CO, 91, { coordsChanged: true }]);
        const second = routeSeg.recalcForJob.mock.calls[1];
        expect(second[0]).toBe(CO);
        expect(second[1]).toBe(91);
        expect(second[2]).toEqual({});   // NO beforeTechDays / coordsChanged keys
        // recalc happened AFTER the assigned_techs/mirror UPDATE.
        const mirrorUpdateOrder = dbOrderOf(/UPDATE jobs SET assigned_techs = \$1::jsonb, zb_raw = \$2::jsonb, assigned_provider_user_ids/);
        expect(routeSeg.recalcForJob.mock.invocationCallOrder[1]).toBeGreaterThan(mirrorUpdateOrder);
    });
});

// =============================================================================
// POST /api/jobs/:id/reschedule — TC-RV-14..17 (supertest over mini-app)
// =============================================================================

function makeApp({ permissions = ['jobs.edit', 'jobs.assign'], companyFilter = { company_id: CO } } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'kc', email: 'u@x.com', crmUser: { id: 'u-1' } };
        req.authz = { scope: 'tenant', permissions, scopes: {} };
        req.companyFilter = companyFilter;
        next();
    });
    app.use('/api/jobs', jobsRouter);
    return app;
}

function primeRescheduleDb({ found = true, zenbookerJobId = null, currentTechs = [] } = {}) {
    const row = jobRow({ zenbooker_job_id: zenbookerJobId });
    db.query.mockImplementation(async (sql) => {
        if (/FROM jobs j/.test(sql)) return { rows: found ? [row] : [] };            // getJobById
        if (/job_tag_assignments/.test(sql)) return { rows: [] };                    // tags
        if (/SELECT zenbooker_job_id, assigned_techs FROM jobs/.test(sql)) {
            return { rows: [{ zenbooker_job_id: zenbookerJobId, assigned_techs: currentTechs }] };
        }
        return { rows: [], rowCount: 1 };
    });
}

describe('POST /api/jobs/:id/reschedule (FR-1, S-8)', () => {
    // TC-RV-14 (S-8): capture BEFORE the ZB-assign block rewrites the mirror and
    // BEFORE the start_date UPDATE; recalc after the UPDATE with the OLD tech-day.
    test('TC-RV-14: capture before ZB-assign + UPDATE; recalc after UPDATE with old tech-day', async () => {
        primeRescheduleDb({ zenbookerJobId: 'zb-9', currentTechs: [{ id: 'tech-OLD-zb' }] });
        zb.rescheduleJob.mockResolvedValue({});
        zb.assignProviders.mockResolvedValue({});
        // First getJob feeds the immediate tech sync; later background poll → null (no-op).
        zb.getJob.mockResolvedValueOnce({ assigned_providers: [{ id: 'tech-B-zb' }] }).mockResolvedValue(null);
        membershipQueries.resolveProviderUserIds.mockResolvedValue(['tech-B']);

        await withInstantTimers(async () => {
            const res = await request(makeApp())
                .post('/api/jobs/42/reschedule')
                .send({ start_date: '2026-07-16T14:00:00Z', tech_id: 'tech-B-zb' });
            expect(res.status).toBe(200);
            expect(res.body.ok).toBe(true);
            await flushMs();   // drain the background ZB sync (getJob → null)
        });

        const captureOrder = routeQueries.getTechDaysForJob.mock.invocationCallOrder[0];
        const assignUpdateOrder = dbOrderOf(/SET assigned_techs = \$1::jsonb, assigned_provider_user_ids = \$2::jsonb/);
        const startUpdateOrder = dbOrderOf(/SET start_date = \$1, end_date = \$2, zb_rescheduled = true/);
        expect(captureOrder).toBeLessThan(assignUpdateOrder);   // before mirror rewrite
        expect(captureOrder).toBeLessThan(startUpdateOrder);    // before date UPDATE

        expect(routeSeg.recalcForJob).toHaveBeenCalledTimes(1);
        expect(routeSeg.recalcForJob).toHaveBeenCalledWith(CO, 42, { beforeTechDays: BEFORE_TD });
        // beforeTechDays reflects the OLD technician's day (the vacated one).
        expect(routeSeg.recalcForJob.mock.calls[0][2]).toEqual({ beforeTechDays: BEFORE_TD });
        expect(routeSeg.recalcForJob.mock.invocationCallOrder[0]).toBeGreaterThan(startUpdateOrder);
    });

    // TC-RV-15 (E-8/INV-7): recalc rejection leaves status+body identical to success.
    test('TC-RV-15: recalc failure does not change the HTTP response', async () => {
        primeRescheduleDb();
        const okRes = await request(makeApp())
            .post('/api/jobs/42/reschedule').send({ start_date: '2026-07-16T14:00:00Z' });
        expect(okRes.status).toBe(200);

        jest.clearAllMocks();
        global.fetch = jest.fn();
        routeQueries.getCompanyTimezone.mockResolvedValue('America/New_York');
        routeQueries.getTechDaysForJob.mockResolvedValue(BEFORE_TD);
        primeRescheduleDb();
        routeSeg.recalcForJob.mockRejectedValue(new Error('recalc boom'));

        const failRes = await request(makeApp())
            .post('/api/jobs/42/reschedule').send({ start_date: '2026-07-16T14:00:00Z' });
        expect(failRes.status).toBe(200);
        expect(failRes.body).toEqual(okRes.body);   // byte-equivalent response
        await microFlush();
        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining('reschedule recalc failed'), 'recalc boom');
    });

    // TC-RV-16 (E-8, guard): unresolved companyId → capture and recalc both skipped,
    // route response does not degrade.
    test('TC-RV-16: no companyId → recalc skipped, response unchanged', async () => {
        primeRescheduleDb();
        const res = await request(makeApp({ companyFilter: null }))
            .post('/api/jobs/42/reschedule').send({ start_date: '2026-07-16T14:00:00Z' });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(routeQueries.getTechDaysForJob).not.toHaveBeenCalled();
        expect(routeSeg.recalcForJob).not.toHaveBeenCalled();
    });

    // TC-RV-17 (INV-2, security): foreign-company job → existing 404 path, and the
    // hook (which sits AFTER the company-scoped read) never runs.
    test('TC-RV-17: cross-tenant job → 404, no capture, no recalc, no UPDATE', async () => {
        primeRescheduleDb({ found: false });   // company-scoped SELECT → no rows
        const res = await request(makeApp())
            .post('/api/jobs/42/reschedule').send({ start_date: '2026-07-16T14:00:00Z' });
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ ok: false, error: 'Job not found' });
        expect(routeQueries.getTechDaysForJob).not.toHaveBeenCalled();
        expect(routeSeg.recalcForJob).not.toHaveBeenCalled();
        expect(db.query.mock.calls.some(c => /UPDATE jobs/.test(c[0]))).toBe(false);
    });
});
