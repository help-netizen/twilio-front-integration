/**
 * Tests for "create a Job directly" (no lead → job conversion path).
 *
 *   - Route POST /api/jobs: permission gate (jobs.create) + tenant context from
 *     req.companyFilter only.
 *   - jobsService.createDirectJob: company isolation on an existing contact_id,
 *     Zenbooker-failure fallback (local job still created + zb_warning), and the
 *     happy path (ZB job created → local job persisted).
 *
 * Mirrors tests/paymentsRoute.test.js (route + mocked service) and
 * tests/zenbookerJobCreate.test.js (axios/ZB mocking style).
 */

const express = require('express');
const http = require('http');

// ─── Supertest-like helper (no extra dep) ─────────────────────────────────────

function request(app, method, path, body = null) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const port = server.address().port;
            const options = {
                hostname: '127.0.0.1',
                port,
                path,
                method: method.toUpperCase(),
                headers: { 'Content-Type': 'application/json' },
            };
            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    server.close();
                    try {
                        resolve({ status: res.statusCode, body: JSON.parse(data) });
                    } catch (e) {
                        resolve({ status: res.statusCode, body: data });
                    }
                });
            });
            req.on('error', err => { server.close(); reject(err); });
            if (body) req.write(JSON.stringify(body));
            req.end();
        });
    });
}

// =============================================================================
// Route: POST /api/jobs — permission gate + tenant context (mocked service)
// =============================================================================

const mockCreateDirectJob = jest.fn();
jest.mock('../backend/src/services/jobsService', () => ({
    createDirectJob: mockCreateDirectJob,
}));
// Stub the other modules the route file pulls in so requiring it is cheap.
jest.mock('../backend/src/services/zenbookerClient', () => ({}));
jest.mock('../backend/src/services/noteAttachmentsService', () => ({
    MAX_FILE_SIZE: 1, MAX_FILES_PER_NOTE: 1,
}));
jest.mock('../backend/src/services/eventService', () => ({}));
jest.mock('../backend/src/services/stripePaymentsService', () => ({
    StripePaymentsError: class extends Error {},
}));

const jobsRouter = require('../backend/src/routes/jobs');

const COMPANY = '00000000-0000-0000-0000-00000000000a';

function routeApp({ permissions = [], companyFilter = { company_id: COMPANY }, noTenant = false } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'kc', email: 'u@x.com', crmUser: { id: 'u-1' } };
        req.authz = { scope: 'tenant', permissions, scopes: {} };
        req.companyFilter = noTenant ? undefined : companyFilter;
        // Poison the legacy field: the route must never read it (PF007).
        req.companyId = 'LEGACY-DO-NOT-USE';
        next();
    });
    app.use('/', jobsRouter);
    return app;
}

const VALID_BODY = {
    contact: { name: 'Jane Doe', phone: '+16175551234' },
    address: { line1: '6 Cirrus Drive', city: 'Ashland', postal_code: '01721' },
    slot: { start: '2026-07-01T14:00:00Z', end: '2026-07-01T16:00:00Z' },
    job_type: 'Refrigerator repair',
};

describe('POST /api/jobs — permission + tenant context', () => {
    beforeEach(() => mockCreateDirectJob.mockReset());

    test('P0: denies without jobs.create permission (403)', async () => {
        const res = await request(routeApp({ permissions: [] }), 'POST', '/', VALID_BODY);
        // requirePermission denies before the handler — its body is { code, message }.
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ACCESS_DENIED');
        expect(mockCreateDirectJob).not.toHaveBeenCalled();
    });

    test('uses req.companyFilter company, never req.companyId', async () => {
        mockCreateDirectJob.mockResolvedValue({ job_id: 7, zenbooker_job_id: 'zb-7', zb_warning: null });
        const res = await request(routeApp({ permissions: ['jobs.create'] }), 'POST', '/', VALID_BODY);
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data).toEqual({ job_id: 7, zenbooker_job_id: 'zb-7', zb_warning: null });
        expect(mockCreateDirectJob.mock.calls[0][0]).toBe(COMPANY);
    });

    test('returns 403 when tenant context (companyFilter) is absent', async () => {
        const res = await request(
            routeApp({ permissions: ['jobs.create'], noTenant: true }),
            'POST', '/', VALID_BODY
        );
        expect(res.status).toBe(403);
        expect(res.body.ok).toBe(false);
        expect(mockCreateDirectJob).not.toHaveBeenCalled();
    });

    test('maps a thrown httpStatus through to the response', async () => {
        const err = new Error('Contact not found');
        err.httpStatus = 404;
        mockCreateDirectJob.mockRejectedValue(err);
        const res = await request(routeApp({ permissions: ['jobs.create'] }), 'POST', '/', VALID_BODY);
        expect(res.status).toBe(404);
        expect(res.body.ok).toBe(false);
        expect(res.body.error).toBe('Contact not found');
    });
});

// =============================================================================
// Service: jobsService.createDirectJob — isolation, ZB-failure, happy path
// =============================================================================
//
// Isolated module registry so the real jobsService runs against mocked deps
// (db / contactDedupeService / zenbookerClient) without disturbing the route
// suite above. jest.isolateModules gives each test a fresh require graph.

describe('jobsService.createDirectJob', () => {
    function loadService({ dbQuery, resolveContact, createJob, getJob }) {
        let svc;
        jest.isolateModules(() => {
            jest.doMock('../backend/src/db/connection', () => ({
                query: dbQuery,
                getClient: jest.fn(),
                pool: { connect: jest.fn() },
            }));
            jest.doMock('../backend/src/services/contactDedupeService', () => ({
                resolveContact: resolveContact || jest.fn(),
            }));
            jest.doMock('../backend/src/services/zenbookerClient', () => ({
                findTerritoryByPostalCode: jest.fn().mockResolvedValue('terr_01'),
                createJob: createJob || jest.fn(),
                getJob: getJob || jest.fn(),
            }));
            jest.doMock('../backend/src/services/fsmService', () => ({}));
            jest.doMock('../backend/src/services/eventService', () => ({}));
            jest.doMock('../backend/src/db/membershipQueries', () => ({
                resolveProviderUserIds: jest.fn().mockResolvedValue([]),
            }));
            jest.doMock('../backend/src/config/featureFlags', () => ({
                isZenbookerSyncEnabled: () => false,
            }));
            // jobsService is jest.mock()'d at the top of this file for the route
            // suite; load the REAL implementation here so we exercise its logic.
            svc = jest.requireActual('../backend/src/services/jobsService');
        });
        return svc;
    }

    afterEach(() => { jest.resetModules(); jest.dontMock('../backend/src/db/connection'); });

    test('P0: rejects a contact_id from another company (404)', async () => {
        // The company-scoped SELECT returns no rows → not found in THIS tenant.
        const dbQuery = jest.fn().mockResolvedValue({ rows: [] });
        const svc = loadService({ dbQuery });

        await expect(
            svc.createDirectJob(COMPANY, {
                contact: { contact_id: 999 },
                address: { postal_code: '01721' },
                slot: { start: '2026-07-01T14:00:00Z', end: '2026-07-01T16:00:00Z' },
                job_type: 'Repair',
            })
        ).rejects.toMatchObject({ message: 'Contact not found', httpStatus: 404 });

        // It must have queried contacts scoped by both id AND company_id.
        const call = dbQuery.mock.calls[0];
        expect(call[0]).toMatch(/FROM contacts WHERE id = \$1 AND company_id = \$2/);
        expect(call[1]).toEqual([999, COMPANY]);
    });

    test('P0: Zenbooker failure → local job still created + zb_warning', async () => {
        const zbErr = new Error('request failed');
        zbErr.response = { data: { error: { message: 'INVALID_ADDRESS' } } };
        const createJob = jest.fn().mockRejectedValue(zbErr);

        // db.query is used for: (1) contact dedupe path is bypassed (new contact),
        // (2) the fallback INSERT into jobs.
        const dbQuery = jest.fn((sql) => {
            if (/INSERT INTO jobs/.test(sql)) {
                return Promise.resolve({ rows: [{ id: 42, blanc_status: 'Submitted' }] });
            }
            return Promise.resolve({ rows: [] });
        });
        const resolveContact = jest.fn().mockResolvedValue({ contact_id: 5, status: 'created' });

        const svc = loadService({ dbQuery, resolveContact, createJob });

        const out = await svc.createDirectJob(COMPANY, {
            contact: { name: 'Jane Doe', phone: '+16175551234' },
            address: { line1: '6 Cirrus Drive', city: 'Ashland', postal_code: '01721' },
            slot: { start: '2026-07-01T14:00:00Z', end: '2026-07-01T16:00:00Z', tech_id: 'prov-1' },
            job_type: 'Refrigerator repair',
            description: 'door seal',
        });

        expect(createJob).toHaveBeenCalledTimes(1);
        expect(out.job_id).toBe(42);
        expect(out.zenbooker_job_id).toBeNull();
        // ZB nests the reason under error.message — must surface it verbatim.
        expect(out.zb_warning).toBe('INVALID_ADDRESS');

        // The fallback insert ran, scoped to the company, with the input data.
        const insertCall = dbQuery.mock.calls.find(c => /INSERT INTO jobs/.test(c[0]));
        expect(insertCall).toBeTruthy();
        const params = insertCall[1];
        expect(params).toContain(COMPANY);
        expect(params).toContain('Refrigerator repair');
        expect(params).toContain('2026-07-01T14:00:00Z');
    });

    test('P1: happy path → ZB job created + local job persisted', async () => {
        const createJobZb = jest.fn().mockResolvedValue({ job_id: 'zb-123' });
        const getJob = jest.fn().mockResolvedValue({
            job_number: 'JN-9001',
            status: 'scheduled',
            customer: { id: 'cust_1', name: 'Jane Doe' },
            start_date: '2026-07-01T14:00:00Z',
        });

        // Local persist goes through jobsService.createJob → ON CONFLICT upsert.
        const dbQuery = jest.fn((sql) => {
            if (/INSERT INTO jobs/.test(sql)) {
                return Promise.resolve({ rows: [{ id: 77, zenbooker_job_id: 'zb-123', blanc_status: 'Submitted' }] });
            }
            return Promise.resolve({ rows: [] });
        });
        const resolveContact = jest.fn().mockResolvedValue({ contact_id: 5, status: 'created' });

        const svc = loadService({ dbQuery, resolveContact, createJob: createJobZb, getJob });

        const out = await svc.createDirectJob(COMPANY, {
            contact: { name: 'Jane Doe', phone: '+16175551234', email: 'jane@x.com' },
            address: { line1: '6 Cirrus Drive', city: 'Ashland', postal_code: '01721' },
            slot: { start: '2026-07-01T14:00:00Z', end: '2026-07-01T16:00:00Z' },
            job_type: 'Refrigerator repair',
        });

        expect(createJobZb).toHaveBeenCalledTimes(1);
        // Payload sanity: custom service + arrival window + auto assignment.
        const payload = createJobZb.mock.calls[0][0];
        expect(payload.territory_id).toBe('terr_01');
        expect(payload.services[0].custom_service.name).toBe('Refrigerator repair');
        expect(payload.timeslot).toEqual({ type: 'arrival_window', start: '2026-07-01T14:00:00Z', end: '2026-07-01T16:00:00Z' });
        expect(payload.assignment_method).toBe('auto');
        expect(payload.assigned_providers).toBeUndefined();

        // job_number was present on first getJob → no retry needed.
        expect(getJob).toHaveBeenCalledTimes(1);

        expect(out).toEqual({ job_id: 77, zenbooker_job_id: 'zb-123', zb_warning: null });
    });

    test('P1: pre-assigned tech omits assignment_method (ZB rejects both)', async () => {
        const createJobZb = jest.fn().mockResolvedValue({ job_id: 'zb-555' });
        const getJob = jest.fn().mockResolvedValue({ job_number: 'JN-1', status: 'scheduled' });
        const dbQuery = jest.fn((sql) =>
            /INSERT INTO jobs/.test(sql)
                ? Promise.resolve({ rows: [{ id: 88, blanc_status: 'Submitted' }] })
                : Promise.resolve({ rows: [] })
        );
        const resolveContact = jest.fn().mockResolvedValue({ contact_id: 9, status: 'created' });

        const svc = loadService({ dbQuery, resolveContact, createJob: createJobZb, getJob });

        await svc.createDirectJob(COMPANY, {
            contact: { name: 'Solo', phone: '+16175550000' },
            address: { postal_code: '01721' },
            slot: { start: '2026-07-01T14:00:00Z', end: '2026-07-01T16:00:00Z', tech_id: 'prov-7' },
            job_type: 'Repair',
        });

        const payload = createJobZb.mock.calls[0][0];
        expect(payload.assigned_providers).toEqual(['prov-7']);
        expect(payload.assignment_method).toBeUndefined();
    });
});
