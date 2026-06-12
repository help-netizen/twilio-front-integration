/**
 * PF007-HARDENING-001 / TASK-RBAC-016
 * Provider assigned-only visibility for the Jobs API.
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/zenbookerClient', () => ({}));
jest.mock('../backend/src/services/fsmService', () => ({}));
jest.mock('../backend/src/services/eventService', () => ({
    logEvent: jest.fn(), actorName: jest.fn(() => 'Test'), getEntityHistory: jest.fn(async () => []),
}));
jest.mock('../backend/src/services/noteAttachmentsService', () => ({
    MAX_FILE_SIZE: 1024, MAX_FILES_PER_NOTE: 5, getAttachmentsForEntity: jest.fn(async () => []),
}));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));

const http = require('http');
const express = require('express');
const db = require('../backend/src/db/connection');
const jobsService = require('../backend/src/services/jobsService');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const PROVIDER_USER = '11111111-1111-1111-1111-111111111111';

beforeEach(() => db.query.mockReset());

// ─── Service-level scope semantics ───────────────────────────────────────────

describe('jobsService.listJobs provider scope', () => {
    it('adds an assignee-mirror containment condition for assigned_only', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ total: '0' }] }).mockResolvedValueOnce({ rows: [] });
        await jobsService.listJobs({
            companyId: COMPANY_A,
            providerScope: { assignedOnly: true, userId: PROVIDER_USER },
        });
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('j.company_id = $1');
        expect(sql).toContain('j.assigned_provider_user_ids @> $2::jsonb');
        expect(params[1]).toBe(JSON.stringify([PROVIDER_USER]));
    });

    it('returns nothing when assigned_only has no resolved user', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ total: '0' }] }).mockResolvedValueOnce({ rows: [] });
        await jobsService.listJobs({
            companyId: COMPANY_A,
            providerScope: { assignedOnly: true, userId: null },
        });
        const [sql] = db.query.mock.calls[0];
        expect(sql).toContain('FALSE');
    });

    it('keeps tenant-wide behavior for job_visibility=all', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ total: '0' }] }).mockResolvedValueOnce({ rows: [] });
        await jobsService.listJobs({ companyId: COMPANY_A, providerScope: { assignedOnly: false, userId: null } });
        const [sql] = db.query.mock.calls[0];
        expect(sql).not.toContain('assigned_provider_user_ids');
        expect(sql).toContain('j.company_id = $1');
    });
});

describe('jobsService.getJobById provider scope', () => {
    it('filters by company AND assignee mirror', async () => {
        db.query.mockResolvedValue({ rows: [] });
        const job = await jobsService.getJobById(7, COMPANY_A, { assignedOnly: true, userId: PROVIDER_USER });
        expect(job).toBeNull();
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('j.company_id = $2');
        expect(sql).toContain('j.assigned_provider_user_ids @> $3::jsonb');
        expect(params).toEqual([7, COMPANY_A, JSON.stringify([PROVIDER_USER])]);
    });

    it('short-circuits to null for assigned_only without a user', async () => {
        const job = await jobsService.getJobById(7, COMPANY_A, { assignedOnly: true, userId: null });
        expect(job).toBeNull();
        expect(db.query).not.toHaveBeenCalled();
    });
});

// ─── Route-level behavior (404 / 403 contracts) ──────────────────────────────

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

function appWithAuthz({ permissions = [], scopes = {}, userId = PROVIDER_USER } = {}) {
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

describe('GET /api/jobs/:id route contract', () => {
    it('403 without jobs.view', async () => {
        const res = await request(appWithAuthz({ permissions: [] }), 'GET', '/123');
        expect(res.status).toBe(403);
    });

    it('404 (not 403) for a non-visible job under assigned_only', async () => {
        db.query.mockResolvedValue({ rows: [] }); // job exists in another scope → no rows here
        const res = await request(
            appWithAuthz({ permissions: ['jobs.view'], scopes: { job_visibility: 'assigned_only' } }),
            'GET', '/123'
        );
        expect(res.status).toBe(404);
    });

    it('closing transition via PATCH /:id/status requires a closing permission', async () => {
        // job is visible
        db.query.mockResolvedValue({
            rows: [{ id: 123, blanc_status: 'Visit completed', assigned_techs: [], notes: [], company_id: COMPANY_A }],
        });
        const res = await request(
            appWithAuthz({ permissions: ['jobs.view', 'jobs.edit'] }),
            'PATCH', '/123/status', { blanc_status: 'Job is Done' }
        );
        expect(res.status).toBe(403);
    });
});
