/**
 * SLOT-ENGINE-001 Phase 2 — slot engine snapshot + proxy.
 *
 * Covers:
 *  - isAppConnected matrix (only 'connected' installation of a published app → true).
 *  - Snapshot mapping (drops null-coord + Canceled/Visit-completed jobs; local HH:MM
 *    windows; duration = end−start; assigned_technicians mapping; base only when row exists).
 *  - Proxy gating (not connected → {enabled:false}, fetch NOT called).
 *  - Proxy success (connected + fetch 200 → {enabled:true, engine_status:'ok', recommendations}).
 *  - Engine-down safe-failure (reject / timeout / missing URL → engine_status:'unavailable',
 *    recommendations:[], never a 5xx).
 *  - schedule.dispatch enforcement (403 without).
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/db/marketplaceQueries', () => ({
    getPublishedAppByKey: jest.fn(),
    findActiveInstallation: jest.fn(),
}));
jest.mock('../backend/src/services/zenbookerClient', () => ({ getTeamMembers: jest.fn() }));
jest.mock('../backend/src/services/googlePlacesService', () => ({ geocodeAddress: jest.fn() }));
jest.mock('../backend/src/services/jobsService', () => ({ listJobs: jest.fn() }));
jest.mock('../backend/src/services/scheduleService', () => ({
    getDispatchSettings: jest.fn(async () => ({ timezone: 'America/New_York' })),
}));

const express = require('express');
const request = require('supertest');

const marketplaceQueries = require('../backend/src/db/marketplaceQueries');
const zenbookerClient = require('../backend/src/services/zenbookerClient');
const jobsService = require('../backend/src/services/jobsService');
const marketplaceService = require('../backend/src/services/marketplaceService');
const slotEngineService = require('../backend/src/services/slotEngineService');
const scheduleRouter = require('../backend/src/routes/schedule');

const COMPANY = '00000000-0000-0000-0000-00000000000a';

beforeEach(() => {
    jest.clearAllMocks();
    marketplaceQueries.getPublishedAppByKey.mockReset();
    marketplaceQueries.findActiveInstallation.mockReset();
    zenbookerClient.getTeamMembers.mockReset().mockResolvedValue([]);
    jobsService.listJobs.mockReset().mockResolvedValue([]);
    process.env.SLOT_ENGINE_URL = 'http://engine.test';
    global.fetch = jest.fn();
});

afterEach(() => {
    delete global.fetch;
});

// ─── isAppConnected matrix ───────────────────────────────────────────────────

describe('marketplaceService.isAppConnected', () => {
    it('false when the app is not published / missing', async () => {
        marketplaceQueries.getPublishedAppByKey.mockResolvedValue(null);
        const r = await marketplaceService.isAppConnected(COMPANY, 'smart-slot-engine');
        expect(r).toBe(false);
        expect(marketplaceQueries.findActiveInstallation).not.toHaveBeenCalled();
    });

    it('false when there is no active installation', async () => {
        marketplaceQueries.getPublishedAppByKey.mockResolvedValue({ id: 7 });
        marketplaceQueries.findActiveInstallation.mockResolvedValue(null);
        expect(await marketplaceService.isAppConnected(COMPANY, 'smart-slot-engine')).toBe(false);
    });

    it.each(['disconnected', 'revoked', 'provisioning_failed'])(
        'false when the active installation status is %s',
        async (status) => {
            marketplaceQueries.getPublishedAppByKey.mockResolvedValue({ id: 7 });
            marketplaceQueries.findActiveInstallation.mockResolvedValue({ id: 1, status });
            expect(await marketplaceService.isAppConnected(COMPANY, 'smart-slot-engine')).toBe(false);
        }
    );

    it('true only when an active installation is connected', async () => {
        marketplaceQueries.getPublishedAppByKey.mockResolvedValue({ id: 7 });
        marketplaceQueries.findActiveInstallation.mockResolvedValue({ id: 1, status: 'connected' });
        expect(await marketplaceService.isAppConnected(COMPANY, 'smart-slot-engine')).toBe(true);
    });
});

// ─── Snapshot mapping ────────────────────────────────────────────────────────

describe('snapshot mapping', () => {
    const dbConn = require('../backend/src/db/connection');

    beforeEach(() => {
        // technicianBaseLocationQueries.listByCompany runs schema + SELECT through db.query.
        dbConn.query.mockReset().mockResolvedValue({ rows: [] });
    });

    it('drops null-coord jobs and Canceled / Visit completed jobs; maps windows/duration/techs', async () => {
        jobsService.listJobs.mockResolvedValue([
            // kept: 10:00–11:15 EDT → 75 min, two techs
            {
                id: 1, lat: 42.34, lng: -71.10, blanc_status: 'Submitted', job_type: 'service_call',
                start_date: '2026-06-25T14:00:00.000Z', end_date: '2026-06-25T15:15:00.000Z',
                assigned_techs: [{ id: 'tech_001' }, { id: 7 }],
            },
            // dropped: null coords
            { id: 2, lat: null, lng: null, blanc_status: 'Submitted', start_date: '2026-06-25T14:00:00.000Z' },
            // dropped: Canceled
            { id: 3, lat: 42.0, lng: -71.0, blanc_status: 'Canceled', start_date: '2026-06-25T14:00:00.000Z', end_date: '2026-06-25T15:00:00.000Z' },
            // dropped: Visit completed
            { id: 4, lat: 42.0, lng: -71.0, blanc_status: 'Visit completed', start_date: '2026-06-25T14:00:00.000Z', end_date: '2026-06-25T15:00:00.000Z' },
        ]);

        const jobs = await slotEngineService._buildScheduledJobs(COMPANY, '2026-06-25', '2026-06-27', 'America/New_York');
        expect(jobs).toHaveLength(1);
        const j = jobs[0];
        expect(j.id).toBe('1');
        expect(j.status).toBe('scheduled');
        expect(j.date).toBe('2026-06-25');
        expect(j.job_type).toBe('service_call');
        expect(j.window_start).toBe('10:00'); // 14:00Z = 10:00 EDT
        expect(j.window_end).toBe('11:15');
        expect(j.duration_minutes).toBe(75);
        expect(j.assigned_technicians).toEqual(['tech_001', '7']);
    });

    it('falls back to default duration when end_date is missing, end window = start', async () => {
        jobsService.listJobs.mockResolvedValue([
            { id: 9, lat: 42.0, lng: -71.0, blanc_status: 'Submitted', start_date: '2026-06-25T14:00:00.000Z', end_date: null, assigned_techs: [] },
        ]);
        const jobs = await slotEngineService._buildScheduledJobs(COMPANY, '2026-06-25', '2026-06-27', 'America/New_York');
        expect(jobs[0].duration_minutes).toBe(75);
        expect(jobs[0].window_start).toBe('10:00');
        expect(jobs[0].window_end).toBe('10:00');
        expect(jobs[0].assigned_technicians).toEqual([]);
    });

    it('attaches a base only when a base row exists for the tech', async () => {
        dbConn.query.mockReset().mockImplementation(async (sql) => {
            if (/SELECT tech_id, lat, lng/.test(String(sql))) {
                return { rows: [{ tech_id: 'tech_001', lat: 42.36, lng: -71.06, label: 'Home', address: null }] };
            }
            return { rows: [] };
        });
        zenbookerClient.getTeamMembers.mockResolvedValue([
            { id: 'tech_001', first_name: 'Robert', last_name: 'Smith', deactivated: false },
            { id: 'tech_002', name: 'Jane', deactivated: false },
        ]);
        const techs = await slotEngineService._buildTechnicians(COMPANY);
        const t1 = techs.find(t => t.id === 'tech_001');
        const t2 = techs.find(t => t.id === 'tech_002');
        expect(t1.base).toEqual({ lat: 42.36, lng: -71.06 });
        expect(t1.name).toBe('Robert Smith');
        expect(t1.active).toBe(true);
        expect(t2.base).toBeNull();
        expect(t2.name).toBe('Jane');
    });
});

// ─── getRecommendations: success + safe-failure ──────────────────────────────

describe('slotEngineService.getRecommendations', () => {
    const dbConn = require('../backend/src/db/connection');
    beforeEach(() => { dbConn.query.mockReset().mockResolvedValue({ rows: [] }); });

    it('throws NEW_JOB_LOCATION_REQUIRED when no point can be resolved', async () => {
        require('../backend/src/services/googlePlacesService').geocodeAddress.mockResolvedValue({ status: 'failed' });
        await expect(slotEngineService.getRecommendations(COMPANY, { new_job: {} }))
            .rejects.toMatchObject({ httpStatus: 422, code: 'NEW_JOB_LOCATION_REQUIRED' });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('success: posts to the engine and returns engine_status ok + recommendations', async () => {
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ recommendations: [{ rank: 1 }], summary: { count: 1 } }),
        });
        const out = await slotEngineService.getRecommendations(COMPANY, {
            new_job: { lat: 42.35, lng: -71.09, job_type: 'service_call' },
        });
        expect(out.engine_status).toBe('ok');
        expect(out.recommendations).toEqual([{ rank: 1 }]);
        expect(out.summary).toEqual({ count: 1 });
        const [url, opts] = global.fetch.mock.calls[0];
        expect(url).toBe('http://engine.test/api/v1/slot-recommendations');
        const body = JSON.parse(opts.body);
        expect(body.new_request.required_technician_count).toBe(1);
        expect(body.new_request.lat).toBe(42.35);
    });

    it('safe-failure when fetch rejects (network/timeout)', async () => {
        global.fetch.mockRejectedValue(new Error('aborted'));
        const out = await slotEngineService.getRecommendations(COMPANY, { new_job: { lat: 1, lng: 2 } });
        expect(out).toEqual({ recommendations: [], summary: null, engine_status: 'unavailable' });
    });

    it('safe-failure on non-2xx', async () => {
        global.fetch.mockResolvedValue({ ok: false, status: 502, json: async () => ({}) });
        const out = await slotEngineService.getRecommendations(COMPANY, { new_job: { lat: 1, lng: 2 } });
        expect(out.engine_status).toBe('unavailable');
        expect(out.recommendations).toEqual([]);
    });

    it('safe-failure when SLOT_ENGINE_URL is missing (no fetch)', async () => {
        delete process.env.SLOT_ENGINE_URL;
        const out = await slotEngineService.getRecommendations(COMPANY, { new_job: { lat: 1, lng: 2 } });
        expect(out.engine_status).toBe('unavailable');
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

// ─── Proxy route ─────────────────────────────────────────────────────────────

function appWith({ permissions = [] } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'kc', email: 'u@x.com', crmUser: { id: 'user-1' } };
        req.authz = { permissions };
        req.companyFilter = { company_id: COMPANY };
        next();
    });
    app.use('/api/schedule', scheduleRouter);
    return app;
}

describe('POST /api/schedule/slot-recommendations', () => {
    it('403 without schedule.dispatch', async () => {
        const res = await request(appWith({ permissions: [] }))
            .post('/api/schedule/slot-recommendations').send({ new_job: { lat: 1, lng: 2 } });
        expect(res.status).toBe(403);
    });

    it('not connected → {enabled:false}, engine NOT called', async () => {
        marketplaceQueries.getPublishedAppByKey.mockResolvedValue(null);
        const res = await request(appWith({ permissions: ['schedule.dispatch'] }))
            .post('/api/schedule/slot-recommendations').send({ new_job: { lat: 1, lng: 2 } });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, data: { enabled: false, recommendations: [] } });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('connected + engine 200 → {enabled:true, engine_status:ok}', async () => {
        marketplaceQueries.getPublishedAppByKey.mockResolvedValue({ id: 7 });
        marketplaceQueries.findActiveInstallation.mockResolvedValue({ id: 1, status: 'connected' });
        global.fetch.mockResolvedValue({ ok: true, json: async () => ({ recommendations: [{ rank: 1 }], summary: null }) });
        const res = await request(appWith({ permissions: ['schedule.dispatch'] }))
            .post('/api/schedule/slot-recommendations').send({ new_job: { lat: 42.35, lng: -71.09 } });
        expect(res.status).toBe(200);
        expect(res.body.data.enabled).toBe(true);
        expect(res.body.data.engine_status).toBe('ok');
        expect(res.body.data.recommendations).toEqual([{ rank: 1 }]);
    });

    it('connected but engine down → 200 with enabled:true, engine_status:unavailable (never 5xx)', async () => {
        marketplaceQueries.getPublishedAppByKey.mockResolvedValue({ id: 7 });
        marketplaceQueries.findActiveInstallation.mockResolvedValue({ id: 1, status: 'connected' });
        global.fetch.mockRejectedValue(new Error('aborted'));
        const res = await request(appWith({ permissions: ['schedule.dispatch'] }))
            .post('/api/schedule/slot-recommendations').send({ new_job: { lat: 42.35, lng: -71.09 } });
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ enabled: true, recommendations: [], summary: null, engine_status: 'unavailable' });
    });

    it('connected + bad input → surfaces 422 NEW_JOB_LOCATION_REQUIRED', async () => {
        marketplaceQueries.getPublishedAppByKey.mockResolvedValue({ id: 7 });
        marketplaceQueries.findActiveInstallation.mockResolvedValue({ id: 1, status: 'connected' });
        require('../backend/src/services/googlePlacesService').geocodeAddress.mockResolvedValue({ status: 'failed' });
        const res = await request(appWith({ permissions: ['schedule.dispatch'] }))
            .post('/api/schedule/slot-recommendations').send({ new_job: {} });
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('NEW_JOB_LOCATION_REQUIRED');
    });
});
