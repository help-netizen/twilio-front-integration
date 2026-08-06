/**
 * MTECH-T0 / RBAC-FSM-FIX-001 — provider status-transition gates.
 *
 * Regression guard for the mobile field-tech app (MOBILE-TECH-APP-001 §0 G3, §3.3, C6):
 * the `provider` role does NOT have `jobs.edit`, so the retained status route
 * PATCH /:id/status MUST accept the OR-gate
 * `requirePermission('jobs.edit','jobs.done_pending_approval')` — otherwise a
 * technician changing their own job's status from the app gets a 403.
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

// getClient() backs transactionService.withTransaction (BEGIN/work/COMMIT). The
// transaction client shares the SAME query mock as db.query, so a test's
// db.query.mockResolvedValue(...) also drives the committed UPDATE inside the
// transaction — otherwise every 200-path status change 500s on a missing client.
jest.mock('../backend/src/db/connection', () => {
    const query = jest.fn();
    return { query, getClient: jest.fn(async () => ({ query, release: jest.fn() })) };
});
jest.mock('../backend/src/services/zenbookerClient', () => ({
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
// Keep the real actor factories (routes build actors with userActor); stub only the
// activity WRITE so the committed transaction doesn't hit the crm_users.id validation
// against a mocked DB. Orthogonal to the permission gate under test.
jest.mock('../backend/src/services/jobActivityService', () => {
    const actual = jest.requireActual('../backend/src/services/jobActivityService');
    return { ...actual, logJobActivity: jest.fn(async () => {}) };
});

const http = require('http');
const express = require('express');
const db = require('../backend/src/db/connection');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const PROVIDER_USER = '11111111-1111-1111-1111-111111111111';

// A minimal job row that satisfies getJobById + the status service method.
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
    it('PATCH /:id/status without either → 403 (gate blocks before the handler)', async () => {
        db.query.mockResolvedValue({ rows: [JOB_ROW] });
        const res = await request(
            appWithAuthz({ permissions: ['jobs.view'] }),
            'PATCH', '/123/status', { blanc_status: 'Waiting for parts' }
        );
        expect(res.status).toBe(403);
    });
});

// ROLE-JOB-CLOSE-PERMS-001 — the closing/terminal transitions must be gated on the
// closing permissions on EVERY write path. Owner semantics:
//   'Job is Done'     → jobs.close
//   'Visit completed' → jobs.done_pending_approval OR jobs.close
//   'Canceled'        → jobs.close
const { closePermissionError } = require('../backend/src/services/jobTransitionPerms');

describe('closePermissionError — closing-transition permission map (single source of truth)', () => {
    it('Job is Done requires jobs.close (NOT done_pending_approval)', () => {
        expect(closePermissionError(['jobs.done_pending_approval'], 'Job is Done')).toEqual(
            { status: 403, error: 'Insufficient permissions to close jobs' });
        expect(closePermissionError(['jobs.close'], 'Job is Done')).toBeNull();
    });
    it('Visit completed requires done_pending_approval OR close', () => {
        expect(closePermissionError(['jobs.done_pending_approval'], 'Visit completed')).toBeNull();
        expect(closePermissionError(['jobs.close'], 'Visit completed')).toBeNull();
        expect(closePermissionError(['jobs.edit'], 'Visit completed')).toEqual(
            { status: 403, error: 'Insufficient permissions to mark a job visit-completed' });
    });
    it('Canceled requires jobs.close; non-terminal states are ungated here', () => {
        expect(closePermissionError(['jobs.edit'], 'Canceled')).toEqual(
            { status: 403, error: 'Insufficient permissions to cancel jobs' });
        expect(closePermissionError([], 'Waiting for parts')).toBeNull();
        expect(closePermissionError([], 'On the way')).toBeNull();
    });
});

describe('PATCH /:id/status closing gates — Visit completed / Job is Done (ROLE-JOB-CLOSE-PERMS-001)', () => {
    it('Visit completed with jobs.done_pending_approval → 200', async () => {
        db.query.mockResolvedValue({ rows: [JOB_ROW] });
        const res = await request(
            appWithAuthz({ permissions: PROVIDER_PERMS }),
            'PATCH', '/123/status', { blanc_status: 'Visit completed' });
        expect(res.status).toBe(200);
    });

    it('Job is Done with only jobs.done_pending_approval → 403 (needs jobs.close now)', async () => {
        db.query.mockResolvedValue({ rows: [JOB_ROW] });
        const res = await request(
            appWithAuthz({ permissions: PROVIDER_PERMS }),
            'PATCH', '/123/status', { blanc_status: 'Job is Done' });
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/close/i);
    });

    it('Job is Done with jobs.close (+jobs.edit to pass the route guard) → 200', async () => {
        db.query.mockResolvedValue({ rows: [JOB_ROW] });
        const res = await request(
            appWithAuthz({ permissions: ['jobs.view', 'jobs.edit', 'jobs.close'] }),
            'PATCH', '/123/status', { blanc_status: 'Job is Done' });
        expect(res.status).toBe(200);
    });

    // The exact reported bug: a role WITH jobs.edit (so it passes the route's OR-guard)
    // but WITHOUT any closing permission could still reach Visit completed / Job is Done.
    it('jobs.edit but no closing perm → Visit completed is 403 (was the leak)', async () => {
        db.query.mockResolvedValue({ rows: [JOB_ROW] });
        const res = await request(
            appWithAuthz({ permissions: ['jobs.view', 'jobs.edit'] }),
            'PATCH', '/123/status', { blanc_status: 'Visit completed' });
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/visit-completed/i);
    });

    it('jobs.edit but no closing perm → Job is Done is 403 (was the leak)', async () => {
        db.query.mockResolvedValue({ rows: [JOB_ROW] });
        const res = await request(
            appWithAuthz({ permissions: ['jobs.view', 'jobs.edit'] }),
            'PATCH', '/123/status', { blanc_status: 'Job is Done' });
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/close/i);
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
