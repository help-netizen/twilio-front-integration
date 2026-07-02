/**
 * MTECH-T0 / RBAC-FSM-FIX-001 — provider status-transition gates.
 *
 * Regression guard for the mobile field-tech app (MOBILE-TECH-APP-001 §0 G3, §3.3, C6):
 * the `provider` role does NOT have `jobs.edit`, so the operational status routes
 *   POST /:id/enroute, POST /:id/start, PATCH /:id/status
 * MUST accept the OR-gate `requirePermission('jobs.edit','jobs.done_pending_approval')`
 * — otherwise a technician changing their own job's status from the app gets a 403.
 *
 * This test locks the gate so a future edit can't silently narrow it back to
 * `jobs.edit` only (which is what broke the mobile status change).
 *
 * Own-ness is enforced by getProviderScope (assigned_only → getJobById filters by
 * the assignee mirror), so a foreign job resolves to null → 404 (never 403 — we
 * don't leak existence). Cancel stays dispatch-only (`jobs.close`) and must remain
 * 403 for a provider.
 *
 * Harness mirrors tests/jobsProviderScope.test.js: mount the real jobs router
 * behind a stub authz middleware and drive it over a live http socket. The db and
 * side-effecting services are mocked; the db mock's row payload is what makes a job
 * "visible to me" (rows) vs "not mine" (empty → 404).
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/zenbookerClient', () => ({
    markJobEnroute: jest.fn(async () => {}),
    markJobInProgress: jest.fn(async () => {}),
    markComplete: jest.fn(async () => {}),
    cancelJob: jest.fn(async () => {}),
}));
jest.mock('../backend/src/services/fsmService', () => ({
    resolveTransition: jest.fn(async () => ({ valid: true })),
}));
jest.mock('../backend/src/services/eventService', () => ({
    logEvent: jest.fn(), actorName: jest.fn(() => 'Test'), getEntityHistory: jest.fn(async () => []),
}));
jest.mock('../backend/src/services/eventBus', () => ({ emit: jest.fn(async () => {}) }));
jest.mock('../backend/src/services/noteAttachmentsService', () => ({
    MAX_FILE_SIZE: 1024, MAX_FILES_PER_NOTE: 5, getAttachmentsForEntity: jest.fn(async () => []),
}));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));

const http = require('http');
const express = require('express');
const db = require('../backend/src/db/connection');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const PROVIDER_USER = '11111111-1111-1111-1111-111111111111';

// A minimal job row that satisfies getJobById + the status service methods.
// zenbooker_job_id=null keeps the ZB side-effect branch out of the path.
const JOB_ROW = {
    id: 123,
    blanc_status: 'Submitted',
    zb_status: 'scheduled',
    zb_canceled: false,
    zenbooker_job_id: null,
    assigned_techs: [],
    notes: [],
    company_id: COMPANY_A,
    contact_id: null,
    customer_name: 'Test Customer',
    customer_phone: null,
    service_name: null,
};

beforeEach(() => {
    db.query.mockReset();
});

function request(app, method, path, body = null, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const payload = body ? JSON.stringify(body) : null;
            const req = http.request({
                hostname: '127.0.0.1',
                port: server.address().port,
                path, method,
                headers: { 'Content-Type': 'application/json', ...extraHeaders },
            }, (res) => {
                let data = '';
                res.on('data', c => (data += c));
                res.on('end', () => {
                    server.close();
                    resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
                });
            });
            req.on('error', e => { server.close(); reject(e); });
            if (payload) req.write(payload);
            req.end();
        });
    });
}

// Stub authz middleware: `permissions` is exactly what requirePermission checks;
// job_visibility=assigned_only makes getProviderScope build the assignee filter,
// so db-mock rows decide visibility.
function appWithAuthz({ permissions = [], scopes = { job_visibility: 'assigned_only' }, userId = PROVIDER_USER } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'kc-sub', email: 'p@x.com', crmUser: { id: userId } };
        req.authz = { scope: 'tenant', permissions, scopes, membership: { role_key: 'provider' } };
        req.companyFilter = { company_id: COMPANY_A };
        next();
    });
    app.use('/', require('../backend/src/routes/jobs'));
    return app;
}

// Provider entitlement per RBAC-FSM-FIX-001: has jobs.done_pending_approval, NOT jobs.edit.
const PROVIDER_PERMS = ['jobs.view', 'jobs.done_pending_approval'];

describe('Provider status gates — own job succeeds with jobs.done_pending_approval (no jobs.edit)', () => {
    it('POST /:id/enroute → 200 and zb_status=en-route', async () => {
        db.query.mockResolvedValue({ rows: [JOB_ROW] }); // every getJobById/UPDATE resolves to the row
        const res = await request(appWithAuthz({ permissions: PROVIDER_PERMS }), 'POST', '/123/enroute');
        expect(res.status).toBe(200);
        expect(res.body.data.zb_status).toBe('en-route');
    });

    it('POST /:id/start → 200 and zb_status=in-progress', async () => {
        db.query.mockResolvedValue({ rows: [JOB_ROW] });
        const res = await request(appWithAuthz({ permissions: PROVIDER_PERMS }), 'POST', '/123/start');
        expect(res.status).toBe(200);
        expect(res.body.data.zb_status).toBe('in-progress');
    });

    it('PATCH /:id/status (operational, non-closing) → 200', async () => {
        db.query.mockResolvedValue({ rows: [JOB_ROW] });
        const res = await request(
            appWithAuthz({ permissions: PROVIDER_PERMS }),
            'PATCH', '/123/status', { blanc_status: 'Waiting for parts' }
        );
        expect(res.status).toBe(200);
    });
});

describe('Provider status gates — foreign job is 404 (scope hides it), never 403', () => {
    it('POST /:id/enroute on a job not assigned to me → 404', async () => {
        db.query.mockResolvedValue({ rows: [] }); // assignee filter excludes it → getJobById null
        const res = await request(appWithAuthz({ permissions: PROVIDER_PERMS }), 'POST', '/999/enroute');
        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
    });

    it('POST /:id/start on a foreign job → 404', async () => {
        db.query.mockResolvedValue({ rows: [] });
        const res = await request(appWithAuthz({ permissions: PROVIDER_PERMS }), 'POST', '/999/start');
        expect(res.status).toBe(404);
    });

    it('PATCH /:id/status on a foreign job → 404', async () => {
        db.query.mockResolvedValue({ rows: [] });
        const res = await request(
            appWithAuthz({ permissions: PROVIDER_PERMS }),
            'PATCH', '/999/status', { blanc_status: 'Waiting for parts' }
        );
        expect(res.status).toBe(404);
    });
});

describe('Provider status gates — 403 without either operational permission', () => {
    it('POST /:id/enroute with neither jobs.edit nor jobs.done_pending_approval → 403', async () => {
        db.query.mockResolvedValue({ rows: [JOB_ROW] });
        const res = await request(appWithAuthz({ permissions: ['jobs.view'] }), 'POST', '/123/enroute');
        expect(res.status).toBe(403);
    });

    it('POST /:id/start without either → 403', async () => {
        db.query.mockResolvedValue({ rows: [JOB_ROW] });
        const res = await request(appWithAuthz({ permissions: ['jobs.view'] }), 'POST', '/123/start');
        expect(res.status).toBe(403);
    });

    it('PATCH /:id/status without either → 403 (gate blocks before the handler)', async () => {
        db.query.mockResolvedValue({ rows: [JOB_ROW] });
        const res = await request(
            appWithAuthz({ permissions: ['jobs.view'] }),
            'PATCH', '/123/status', { blanc_status: 'Waiting for parts' }
        );
        expect(res.status).toBe(403);
    });
});

describe('Cancel stays dispatch-only — provider cannot cancel', () => {
    it('POST /:id/cancel with provider perms (no jobs.close) → 403', async () => {
        db.query.mockResolvedValue({ rows: [JOB_ROW] });
        const res = await request(
            appWithAuthz({ permissions: PROVIDER_PERMS }),
            'POST', '/123/cancel', { reason: 'Customer canceled' }
        );
        expect(res.status).toBe(403);
    });

    it('PATCH /:id/status → Canceled with provider perms (no jobs.close) → 403', async () => {
        // Gate lets a provider into the handler (has done_pending_approval), but the
        // in-handler closing check rejects Cancel without jobs.close.
        db.query.mockResolvedValue({ rows: [JOB_ROW] });
        const res = await request(
            appWithAuthz({ permissions: PROVIDER_PERMS }),
            'PATCH', '/123/status', { blanc_status: 'Canceled', reason: 'nope' }
        );
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/cancel/i);
    });
});
