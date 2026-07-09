/**
 * OUTBOUND-PARTS-CALL-001 — POST /api/tasks/:id/actions/:type route (unit, mocked).
 *
 * Binding: Docs/test-cases/OUTBOUND-PARTS-CALL-001.md U16/U15/U17 (spec §A.3, S7/S11/S12).
 *
 * The router (backend/src/routes/tasks.js) carries the per-route guard
 * `requirePermission('tasks.manage')`; `authenticate` + `requireCompanyAccess` are
 * applied at mount time in src/server.js. This suite reproduces that mount chain
 * with a fake `authenticate` (401 when no Authorization header) + the REAL
 * `requirePermission` so the full gate is exercised without real HTTP/DB.
 *
 * db is mocked (getTaskById / job lookup run against db.query); partsCallService
 * is mocked so `robot_call` dispatch is asserted without touching the lifecycle.
 */

const express = require('express');
const request = require('supertest');

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../backend/src/services/tasksService', () => ({ emitTaskChange: jest.fn() }));

// The lifecycle seam — assert dispatch + passthrough without dialing.
const mockStartRobotCall = jest.fn();
jest.mock('../backend/src/services/partsCallService', () => ({
    startRobotCall: (...args) => mockStartRobotCall(...args),
    PART_ARRIVED_CALL_KIND: 'part_arrived_call',
    PART_ARRIVED_ACTIONS: [],
}));

// jobsService.getJobById resolves the customer phone/name for manual_call.
const mockGetJobById = jest.fn();
jest.mock('../backend/src/services/jobsService', () => ({
    getJobById: (...args) => mockGetJobById(...args),
}));

const { requirePermission } = require('../backend/src/middleware/authorization');
const tasksRouter = require('../backend/src/routes/tasks');

const COMPANY = '00000000-0000-0000-0000-000000000001';
const OTHER_COMPANY = 'c0000000-0000-4000-8000-0000000000f1';
const ME = 'crm-me';

// Fake `authenticate` mirroring the real mount: no Authorization header → 401
// BEFORE any router handler (so requirePermission / task load never run).
function fakeAuthenticate(permissions, company) {
    return (req, res, next) => {
        if (!req.headers.authorization) {
            return res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Missing token' });
        }
        req.user = { sub: 'kc', email: 'u@x.com', crmUser: { id: ME } };
        req.authz = { scope: 'tenant', permissions };
        req.companyFilter = { company_id: company };
        next();
    };
}

function makeApp({ permissions = ['tasks.manage'], company = COMPANY } = {}) {
    const app = express();
    app.use(express.json());
    app.use(fakeAuthenticate(permissions, company)); // authenticate + requireCompanyAccess seam
    app.use('/api/tasks', tasksRouter);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockStartRobotCall.mockReset();
    mockGetJobById.mockReset();
});

// ── U16 / S12 — auth + permission gate ───────────────────────────────────────
describe('auth / permission gate (U16, S12)', () => {
    test('no token → 401, before any handler / task load / dispatch', async () => {
        const res = await request(makeApp())
            .post(`/api/tasks/7/actions/robot_call`); // no Authorization header
        expect(res.status).toBe(401);
        expect(mockQuery).not.toHaveBeenCalled();
        expect(mockStartRobotCall).not.toHaveBeenCalled();
    });

    test('authenticated but lacks tasks.manage → 403, no dispatch', async () => {
        const res = await request(makeApp({ permissions: ['tasks.view', 'tasks.create'] }))
            .post(`/api/tasks/7/actions/robot_call`)
            .set('Authorization', 'Bearer t');
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ACCESS_DENIED');
        expect(mockQuery).not.toHaveBeenCalled();
        expect(mockStartRobotCall).not.toHaveBeenCalled();
    });
});

// ── U15 / S11 — unknown action type → 400 BEFORE the task load ────────────────
describe('unknown action type (U15, S11)', () => {
    test('unknown :type → 400, no task load, no handler', async () => {
        const res = await request(makeApp())
            .post(`/api/tasks/7/actions/frobnicate`)
            .set('Authorization', 'Bearer t');
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('UNKNOWN_ACTION');
        // Gate is BEFORE the task load — no getTaskById query, no dispatch.
        expect(mockQuery).not.toHaveBeenCalled();
        expect(mockStartRobotCall).not.toHaveBeenCalled();
    });
});

// ── S10 — foreign / absent task id → 404 (not a leak) ─────────────────────────
describe('company scope / not-found (S10)', () => {
    test('foreign or absent task id → 404, scoped SELECT to companyFilter, no dispatch', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] }); // getTaskById (company-scoped) → none
        const res = await request(makeApp())
            .post(`/api/tasks/999/actions/robot_call`)
            .set('Authorization', 'Bearer t');
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
        // The task load ran, scoped to the caller's company (not the body).
        const [, params] = mockQuery.mock.calls[0];
        expect(params).toContain(COMPANY);
        expect(mockStartRobotCall).not.toHaveBeenCalled();
    });

    test('companyId flows from req.companyFilter (foreign company → still 404, own scope)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });
        const res = await request(makeApp({ company: OTHER_COMPANY }))
            .post(`/api/tasks/5/actions/robot_call`)
            .set('Authorization', 'Bearer t');
        expect(res.status).toBe(404);
        expect(mockQuery.mock.calls[0][1]).toContain(OTHER_COMPANY);
    });
});

// ── S11 sub — robot_call happy dispatch to partsCallService.startRobotCall ────
describe('robot_call dispatch (S11 sub, spec §A.3)', () => {
    test('calls partsCallService.startRobotCall(jobId, companyId, taskId) and returns queued', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 7, parent_type: 'job', parent_id: 50, status: 'open' }] }); // getTaskById
        mockGetJobById.mockResolvedValueOnce({ id: 50, customer_phone: '+16170001111', customer_name: 'Jane' });
        mockStartRobotCall.mockResolvedValueOnce({ ok: true, state: 'queued', attemptId: 11 });

        const res = await request(makeApp())
            .post(`/api/tasks/7/actions/robot_call`)
            .set('Authorization', 'Bearer t');

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ ok: true, state: 'queued', attemptId: 11 });
        // jobId, companyId (from companyFilter), taskId, client(null), dispatcherSlot.
        // SLOTPICK-001: a bodyless POST threads dispatcherSlot=undefined → auto-compute.
        expect(mockStartRobotCall).toHaveBeenCalledWith(50, COMPANY, 7, null, undefined);
    });

    test('startRobotCall no_slots result surfaces as state:failed + reason (still 200)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 7, parent_type: 'job', parent_id: 50, status: 'open' }] });
        mockGetJobById.mockResolvedValueOnce({ id: 50, customer_phone: '+16170001111', customer_name: 'Jane' });
        mockStartRobotCall.mockResolvedValueOnce({ ok: false, reason: 'no_slots' });

        const res = await request(makeApp())
            .post(`/api/tasks/7/actions/robot_call`)
            .set('Authorization', 'Bearer t');

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ ok: false, state: 'failed', reason: 'no_slots' });
    });

    test('already-in-flight result → state:in_flight_existing (S14 dispatch shape)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 7, parent_type: 'job', parent_id: 50, status: 'open' }] });
        mockGetJobById.mockResolvedValueOnce({ id: 50, customer_phone: '+16170001111', customer_name: 'Jane' });
        mockStartRobotCall.mockResolvedValueOnce({ ok: true, already: true, attemptId: 9 });

        const res = await request(makeApp())
            .post(`/api/tasks/7/actions/robot_call`)
            .set('Authorization', 'Bearer t');

        expect(res.status).toBe(200);
        expect(res.body.data.state).toBe('in_flight_existing');
    });
});

// ── SLOTPICK-001 — dispatcher slot body threading + invalid_slot → 400 ────────
describe('SLOTPICK-001: req.body.slot threading + invalid_slot → 400 (TC-SP-10…12)', () => {
    const OPEN_JOB_TASK = { id: 7, parent_type: 'job', parent_id: 50, status: 'open' };
    const SLOT = { startIso: '2026-07-09T13:00:00Z', endIso: '2026-07-09T15:00:00Z' };

    test('TC-SP-10: valid slot in body → startRobotCall(jobId, company, taskId, null, slot); 200 queued', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [OPEN_JOB_TASK] }); // getTaskById
        mockGetJobById.mockResolvedValueOnce({ id: 50, customer_phone: '+16170001111', customer_name: 'Jane' });
        mockStartRobotCall.mockResolvedValueOnce({ ok: true, state: 'queued', attemptId: 7 });

        const res = await request(makeApp())
            .post(`/api/tasks/7/actions/robot_call`)
            .set('Authorization', 'Bearer t')
            .send({ slot: SLOT });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, data: { ok: true, state: 'queued', attemptId: 7 } });
        // The raw {startIso,endIso} is threaded straight to the 5th arg (server converts).
        expect(mockStartRobotCall).toHaveBeenCalledWith(50, COMPANY, 7, null, SLOT);
    });

    test('TC-SP-11: startRobotCall reason:invalid_slot → HTTP 400 (not 200)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [OPEN_JOB_TASK] });
        mockGetJobById.mockResolvedValueOnce({ id: 50, customer_phone: '+16170001111', customer_name: 'Jane' });
        mockStartRobotCall.mockResolvedValueOnce({ ok: false, reason: 'invalid_slot' });

        const res = await request(makeApp())
            .post(`/api/tasks/7/actions/robot_call`)
            .set('Authorization', 'Bearer t')
            .send({ slot: { startIso: 'bad', endIso: 'worse' } });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ ok: false, error: { code: 'INVALID_SLOT' }, reason: 'invalid_slot' });
    });

    test('TC-SP-12a: non-slot domain refusal (no_phone) stays the 200 envelope', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [OPEN_JOB_TASK] });
        mockGetJobById.mockResolvedValueOnce({ id: 50, customer_phone: null, customer_name: 'Jane' });
        mockStartRobotCall.mockResolvedValueOnce({ ok: false, reason: 'no_phone' });

        const res = await request(makeApp())
            .post(`/api/tasks/7/actions/robot_call`)
            .set('Authorization', 'Bearer t')
            .send({ slot: SLOT });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, data: { ok: false, state: 'failed', reason: 'no_phone' } });
    });

    test('TC-SP-12b: NO body → dispatcherSlot=undefined (auto-compute), still 200', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [OPEN_JOB_TASK] });
        mockGetJobById.mockResolvedValueOnce({ id: 50, customer_phone: '+16170001111', customer_name: 'Jane' });
        mockStartRobotCall.mockResolvedValueOnce({ ok: true, state: 'queued', attemptId: 3 });

        const res = await request(makeApp())
            .post(`/api/tasks/7/actions/robot_call`)
            .set('Authorization', 'Bearer t');

        expect(res.status).toBe(200);
        expect(mockStartRobotCall).toHaveBeenCalledWith(50, COMPANY, 7, null, undefined);
    });
});

// ── U17 / S7 — manual_call is a pure no-op returning an open-softphone directive ─
describe('manual_call no-op (U17, S7)', () => {
    test('returns { client:{action:open_softphone, phone, contactName} }; no dispatch, no mutation', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 7, parent_type: 'job', parent_id: 50, status: 'open' }] }); // getTaskById
        mockGetJobById.mockResolvedValueOnce({ id: 50, customer_phone: '+16170002222', customer_name: 'Bob' });

        const res = await request(makeApp())
            .post(`/api/tasks/7/actions/manual_call`)
            .set('Authorization', 'Bearer t');

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({
            ok: true,
            state: 'idle',
            client: { action: 'open_softphone', phone: '+16170002222', contactName: 'Bob' },
        });
        // Server never dials and never touches the lifecycle.
        expect(mockStartRobotCall).not.toHaveBeenCalled();
        // Only the task load + job lookup ran — no INSERT/UPDATE mutation.
        const mutations = mockQuery.mock.calls.filter(c => /INSERT|UPDATE|DELETE/i.test(String(c[0])));
        expect(mutations).toHaveLength(0);
    });

    test('missing job/phone → well-formed directive with nulls, still 200', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 7, parent_type: null, parent_id: null, status: 'open' }] });
        // job_id null → route does not call getJobById → job stays null.

        const res = await request(makeApp())
            .post(`/api/tasks/7/actions/manual_call`)
            .set('Authorization', 'Bearer t');

        expect(res.status).toBe(200);
        expect(res.body.data.client).toEqual({ action: 'open_softphone', phone: null, contactName: null });
        expect(mockGetJobById).not.toHaveBeenCalled();
    });
});
