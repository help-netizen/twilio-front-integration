/**
 * PF007-HARDENING-001 / TASK-RBAC-016
 * Provider scope for the unified schedule read model + dispatch boundaries.
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));

const http = require('http');
const express = require('express');
const db = require('../backend/src/db/connection');
const scheduleQueries = require('../backend/src/db/scheduleQueries');
const scheduleService = require('../backend/src/services/scheduleService');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const PROVIDER_USER = '11111111-1111-1111-1111-111111111111';
const SCOPE = { assignedOnly: true, userId: PROVIDER_USER };

beforeEach(() => db.query.mockReset());

describe('scheduleQueries.getScheduleItems provider scope', () => {
    it('excludes leads and filters jobs/tasks by the current assignee', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ total: '0' }] })
            .mockResolvedValueOnce({ rows: [] });

        await scheduleQueries.getScheduleItems({ companyId: COMPANY_A, providerScope: SCOPE });

        const [countSql, params] = db.query.mock.calls[0];
        expect(countSql).not.toContain('FROM leads');
        expect(countSql).toContain('j.assigned_provider_user_ids @>');
        expect(countSql).toContain('t.assigned_provider_id =');
        expect(params).toContain(JSON.stringify([PROVIDER_USER]));
        expect(params).toContain(PROVIDER_USER);
    });

    it('degrades to zero visibility when assigned_only has no user', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ total: '0' }] })
            .mockResolvedValueOnce({ rows: [] });

        await scheduleQueries.getScheduleItems({
            companyId: COMPANY_A,
            providerScope: { assignedOnly: true, userId: null },
        });

        const [countSql] = db.query.mock.calls[0];
        expect(countSql).not.toContain('FROM leads');
        expect(countSql).toContain('FALSE');
    });

    it('keeps all three branches without provider scope', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ total: '0' }] })
            .mockResolvedValueOnce({ rows: [] });

        await scheduleQueries.getScheduleItems({ companyId: COMPANY_A });
        const [countSql] = db.query.mock.calls[0];
        expect(countSql).toContain('FROM jobs');
        expect(countSql).toContain('FROM leads');
        expect(countSql).toContain('FROM tasks');
    });
});

describe('scheduleService.getScheduleItemDetail provider scope', () => {
    it('404 for a job not assigned to the provider', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ id: 5, company_id: COMPANY_A, assigned_provider_user_ids: ['someone-else'] }],
        });
        await expect(scheduleService.getScheduleItemDetail(COMPANY_A, 'job', 5, SCOPE))
            .rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    });

    it('returns a job assigned to the provider', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ id: 5, company_id: COMPANY_A, assigned_provider_user_ids: [PROVIDER_USER] }],
        });
        const out = await scheduleService.getScheduleItemDetail(COMPANY_A, 'job', 5, SCOPE);
        expect(out.entity_type).toBe('job');
    });

    it('providers never see lead detail', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 9, company_id: COMPANY_A }] });
        await expect(scheduleService.getScheduleItemDetail(COMPANY_A, 'lead', 9, SCOPE))
            .rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    });

    it('404 for a task assigned to another user', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ id: 3, company_id: COMPANY_A, assigned_provider_id: 'someone-else' }],
        });
        await expect(scheduleService.getScheduleItemDetail(COMPANY_A, 'task', 3, SCOPE))
            .rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    });
});

// ─── Route-level dispatch boundary ───────────────────────────────────────────

function request(app, method, path, body = null) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const payload = body ? JSON.stringify(body) : null;
            const req = http.request({
                hostname: '127.0.0.1', port: server.address().port, path, method,
                headers: { 'Content-Type': 'application/json' },
            }, (res) => {
                let data = '';
                res.on('data', c => (data += c));
                res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); });
            });
            req.on('error', e => { server.close(); reject(e); });
            if (payload) req.write(payload);
            req.end();
        });
    });
}

function appWithAuthz({ permissions = [] } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'kc-sub', email: 'p@x.com', crmUser: { id: PROVIDER_USER } };
        req.authz = { scope: 'tenant', permissions, scopes: { job_visibility: 'assigned_only' }, membership: { role_key: 'provider' } };
        req.companyFilter = { company_id: COMPANY_A };
        next();
    });
    app.use('/', require('../backend/src/routes/schedule'));
    return app;
}

describe('schedule route dispatch boundaries', () => {
    it('GET / requires schedule.view', async () => {
        const res = await request(appWithAuthz({ permissions: [] }), 'GET', '/');
        expect(res.status).toBe(403);
    });

    it('provider with schedule.view cannot reassign (schedule.dispatch required)', async () => {
        const res = await request(
            appWithAuthz({ permissions: ['schedule.view'] }),
            'PATCH', '/items/job/5/reassign', { assignee_id: 'x' }
        );
        expect(res.status).toBe(403);
    });

    it('provider with schedule.view cannot read or write dispatch settings', async () => {
        const r1 = await request(appWithAuthz({ permissions: ['schedule.view'] }), 'GET', '/settings');
        const r2 = await request(appWithAuthz({ permissions: ['schedule.view'] }), 'PATCH', '/settings', { timezone: 'UTC' });
        expect(r1.status).toBe(403);
        expect(r2.status).toBe(403);
    });

    it('create-from-slot requires schedule.dispatch', async () => {
        const res = await request(
            appWithAuthz({ permissions: ['schedule.view'] }),
            'POST', '/items/from-slot', { entity_type: 'task', title: 'X' }
        );
        expect(res.status).toBe(403);
    });
});
