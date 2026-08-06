/**
 * RBAC-FSM-FIX-001 — a field provider (has jobs.done_pending_approval, NOT jobs.edit)
 * must be able to apply an FSM-backed status on THEIR job, but must NOT Cancel
 * (cancel stays jobs.close). Plus the resolver lockout fix:
 * a tenant_admin must never resolve to 0 perms when the role config is missing.
 */

// ── Mock the jobs router's service deps so it mounts cleanly ──
const mockJobs = {
    getJobById: jest.fn(async () => ({ id: 5, blanc_status: 'Scheduled', company_id: 'co', contact_id: null, customer_name: 'C', customer_phone: null, service_name: 'S' })),
    addNote: jest.fn(async () => ({ notes: [] })),
    updateBlancStatus: jest.fn(async (id, status) => ({ id, blanc_status: status })),
    cancelJob: jest.fn(async () => ({ id: 5, blanc_status: 'Canceled' })),
};
jest.mock('../backend/src/services/jobsService', () => mockJobs);
jest.mock('../backend/src/services/fsmService', () => ({
    // Mirror the real resolveTransition contract (FSM-JOB-ACTIONS-001): the /apply handler
    // requires a resolved edge with transition.action === true BEFORE it reaches the RBAC
    // gate. A bare { valid, targetState } would 400 at the graph check and never exercise the
    // cancel/close guard these tests assert on.
    resolveTransition: jest.fn(async (_co, _mk, _cur, event) => ({
        valid: true,
        targetState: event,
        event,
        transition: { action: true, roles: [] },
        op: null,
    })),
}));
jest.mock('../backend/src/services/eventService', () => ({ logEvent: jest.fn(), actorName: () => 'Tester', describeEvent: jest.fn() }));
jest.mock('../backend/src/services/eventBus', () => ({ emit: jest.fn(() => Promise.resolve()) }));
jest.mock('../backend/src/services/zenbookerClient', () => ({}));
jest.mock('../backend/src/services/noteAttachmentsService', () => ({
    MAX_FILE_SIZE: 10 * 1024 * 1024,
    MAX_FILES_PER_NOTE: 5,
    createAttachments: jest.fn(),
    associateStagedAttachments: jest.fn(async () => ([{
        id: 7,
        file_name: 'label.png',
        content_type: 'image/png',
        file_size: 100,
    }])),
}));
jest.mock('../backend/src/services/unitLabelScanService', () => ({ queueScan: jest.fn(() => true) }));
jest.mock('../backend/src/services/notesMutationService', () => ({ editNote: jest.fn(), softDeleteNote: jest.fn() }));
jest.mock('../backend/src/services/conversationsService', () => ({}));
jest.mock('../backend/src/services/routeDistanceService', () => ({}));
jest.mock('../backend/src/services/googlePlacesService', () => ({}));
jest.mock('../backend/src/services/stripePaymentsService', () => ({}));
jest.mock('../backend/src/services/messagingHelper', () => ({ resolveCompanyProxyE164: jest.fn() }));
jest.mock('../backend/src/db/companyQueries', () => ({}));
jest.mock('../backend/src/middleware/providerScope', () => ({ getProviderScope: () => null }));

// ── Mocks for the resolver lockout test ──
jest.mock('../backend/src/db/roleQueries', () => ({
    getRoleConfig: jest.fn(),
    getAllowedPermissionKeys: jest.fn(async () => []),
    getScopeMap: jest.fn(async () => ({})),
}));
jest.mock('../backend/src/db/membershipQueries', () => ({
    getActiveMembership: jest.fn(),
    getPermissionOverrides: jest.fn(async () => []),
    getScopeOverrides: jest.fn(async () => []),
}));

const express = require('express');
const request = require('supertest');
const jobsRouter = require('../backend/src/routes/jobs');
const fsmRouter = require('../backend/src/routes/fsm');
const authz = require('../backend/src/services/authorizationService');
const roleQueries = require('../backend/src/db/roleQueries');
const unitLabelScanService = require('../backend/src/services/unitLabelScanService');

const PROVIDER = ['jobs.view', 'jobs.done_pending_approval', 'schedule.view', 'provider.enabled', 'tasks.view', 'tasks.create'];

function appAs(perms) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'u1', email: 't@t.com', name: 'Tester' };
        req.authz = { scope: 'tenant', permissions: perms, scopes: {} };
        req.companyFilter = { company_id: 'co' };
        next();
    });
    app.use('/', jobsRouter);
    return app;
}

describe('provider FSM gate', () => {
    beforeEach(() => Object.values(mockJobs).forEach(f => f.mockClear()));

    test('provider (no jobs.edit) CAN set a non-closing FSM status', async () => {
        expect((await request(appAs(PROVIDER)).patch('/5/status').send({ blanc_status: 'On the way' })).status).toBe(200);
    });
    test('provider CAN mark the visit completed (pending approval)', async () => {
        expect((await request(appAs(PROVIDER)).patch('/5/status').send({ blanc_status: 'Visit completed' })).status).toBe(200);
    });
    test('provider CANNOT Cancel (cancel stays jobs.close)', async () => {
        const res = await request(appAs(PROVIDER)).patch('/5/status').send({ blanc_status: 'Canceled', cancel_reason: 'no-show' });
        expect(res.status).toBe(403);
    });
    test('a view-only user is still blocked from status changes', async () => {
        expect((await request(appAs(['jobs.view'])).patch('/5/status').send({ blanc_status: 'On the way' })).status).toBe(403);
    });
    test('a user WITH jobs.close CAN Cancel', async () => {
        const res = await request(appAs(['jobs.edit', 'jobs.close'])).patch('/5/status').send({ blanc_status: 'Canceled', cancel_reason: 'no-show' });
        expect(res.status).toBe(200);
    });
});

describe('UNIT-LABEL-SCAN-001 job note trigger', () => {
    beforeEach(() => {
        mockJobs.getJobById.mockClear();
        mockJobs.addNote.mockClear();
        unitLabelScanService.queueScan.mockClear();
    });

    test('queues committed image attachments only after the source note is saved', async () => {
        const res = await request(appAs(['jobs.edit']))
            .post('/5/notes')
            .field('text', 'Unit photo')
            .field('attachment_ids', '[7]');

        expect(res.status).toBe(200);
        expect(mockJobs.addNote).toHaveBeenCalledTimes(1);
        expect(unitLabelScanService.queueScan).toHaveBeenCalledWith({
            companyId: 'co',
            entityType: 'job',
            entityId: 5,
            sourceNoteId: expect.any(String),
            attachmentIds: [7],
        });
        expect(mockJobs.addNote.mock.invocationCallOrder[0])
            .toBeLessThan(unitLabelScanService.queueScan.mock.invocationCallOrder[0]);
    });

    test('a queue failure never changes the successful note-create response', async () => {
        unitLabelScanService.queueScan.mockImplementationOnce(() => {
            throw new Error('queue unavailable');
        });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const res = await request(appAs(['jobs.edit']))
            .post('/5/notes')
            .field('text', 'Unit photo')
            .field('attachment_ids', '[7]');

        expect(res.status).toBe(200);
        expect(mockJobs.addNote).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
            '[Jobs API] Unit label scan queue failed:',
            'queue unavailable'
        );
        warn.mockRestore();
    });
});

describe('resolver lockout fix', () => {
    test('tenant_admin with NO role config still gets the mandatory admin baseline', async () => {
        roleQueries.getRoleConfig.mockResolvedValue(null);
        const { permissions } = await authz.resolveEffectivePermissionsAndScopes('co', 'tenant_admin', 'm1');
        for (const k of authz.MANDATORY_ADMIN_PERMISSIONS) expect(permissions).toContain(k);
    });
    test('non-admin role with NO config resolves to []', async () => {
        roleQueries.getRoleConfig.mockResolvedValue(null);
        const { permissions } = await authz.resolveEffectivePermissionsAndScopes('co', 'provider', 'm1');
        expect(permissions).toEqual([]);
    });
});

// The FSM /apply route is a parallel manual-transition path; its cancel guard must
// match PATCH /jobs/:id/status so it can't be used as a side-door to cancel.
function appFsmAs(perms) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'u1', email: 't@t.com', name: 'Tester' };
        req.authz = { scope: 'tenant', permissions: perms, scopes: {} };
        req.companyFilter = { company_id: 'co' };
        next();
    });
    app.use('/', fsmRouter);
    return app;
}

describe('FSM /apply cancel guard (side-door)', () => {
    test('a holder of jobs.edit + jobs.done_pending_approval but NOT jobs.close CANNOT cancel via /apply', async () => {
        const res = await request(appFsmAs(['jobs.edit', 'jobs.done_pending_approval']))
            .post('/job/apply').send({ entityId: 5, event: 'Canceled', reason: 'no-show' });
        expect(res.status).toBe(403);
    });
    test('a holder of jobs.close CAN cancel via /apply', async () => {
        const res = await request(appFsmAs(['jobs.edit', 'jobs.close']))
            .post('/job/apply').send({ entityId: 5, event: 'Canceled', reason: 'no-show' });
        expect(res.status).toBe(200);
    });
    test('Done via /apply needs jobs.close — done_pending_approval only gates Visit completed', async () => {
        // ROLE-JOB-CLOSE-PERMS-001: done_pending_approval unlocks the pending "Visit completed"
        // step, NOT the final "Job is Done" close, which stays jobs.close. The /apply side-door
        // must enforce the same split as PATCH /jobs/:id/status.
        const pendingOnly = await request(appFsmAs(['jobs.edit', 'jobs.done_pending_approval']))
            .post('/job/apply').send({ entityId: 5, event: 'Job is Done' });
        expect(pendingOnly.status).toBe(403);
        const closer = await request(appFsmAs(['jobs.edit', 'jobs.close']))
            .post('/job/apply').send({ entityId: 5, event: 'Job is Done' });
        expect(closer.status).toBe(200);
    });

    test('Visit completed via /apply is unlocked by done_pending_approval', async () => {
        const res = await request(appFsmAs(['jobs.edit', 'jobs.done_pending_approval']))
            .post('/job/apply').send({ entityId: 5, event: 'Visit completed' });
        expect(res.status).toBe(200);
    });
});

// RBAC-FSM-FIX (side-door base gate): a provider holds jobs.done_pending_approval but
// NOT jobs.edit. The /apply base permission gate must accept it — mirroring PATCH
// /jobs/:id/status — so a provider can advance a job (e.g. Part arrived → On the way)
// via the FSM side-door, while the closing guard still blocks Cancel.
describe('FSM /apply provider parity (widened base gate)', () => {
    test('provider (no jobs.edit) CAN apply a non-closing transition (On the way) via /apply', async () => {
        const res = await request(appFsmAs(PROVIDER))
            .post('/job/apply').send({ entityId: 5, event: 'On the way' });
        expect(res.status).toBe(200);
    });
    test('provider CANNOT Cancel via /apply (cancel stays jobs.close)', async () => {
        const res = await request(appFsmAs(PROVIDER))
            .post('/job/apply').send({ entityId: 5, event: 'Canceled', reason: 'no-show' });
        expect(res.status).toBe(403);
    });
    test('a holder of jobs.close (dispatcher/admin) can still Cancel via /apply', async () => {
        const res = await request(appFsmAs(['jobs.edit', 'jobs.close']))
            .post('/job/apply').send({ entityId: 5, event: 'Canceled', reason: 'no-show' });
        expect(res.status).toBe(200);
    });
    test('a view-only user (no jobs.edit / done_pending_approval) is blocked at the base gate', async () => {
        const res = await request(appFsmAs(['jobs.view']))
            .post('/job/apply').send({ entityId: 5, event: 'On the way' });
        expect(res.status).toBe(403);
    });
});
