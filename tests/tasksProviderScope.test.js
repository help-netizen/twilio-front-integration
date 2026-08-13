/**
 * ROLE-TASKS-SCOPE-001 — Tasks visibility is by CONTENT, not an access toggle.
 *
 * A user sees only tasks assigned to them (owner_user_id) or authored by them
 * (author_user_id); holders of tasks.manage (dispatchers + managers) see all. This
 * locks the two enforcement points against regression:
 *   - GET /            → non-managers get filters.scopeOwnerId = their crm id; the
 *                        query then restricts to owner_user_id OR author_user_id.
 *   - PATCH /:id       → canActOn: a non-manager may only mutate a task they own or
 *                        authored (else 403), never a teammate's task.
 * Managers (tasks.manage) bypass both — they see and act on everything in the tenant.
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/db/tasksQueries', () => ({
    listTasksPage: jest.fn(async () => ({ items: [], page_info: { has_more: false } })),
    countTasks: jest.fn(async () => 0),
    getTaskById: jest.fn(),
    updateTask: jest.fn(async () => ({ id: 7, status: 'open' })),
    clearTimelineActionRequiredIfNoOpenTasks: jest.fn(async () => {}),
}));
jest.mock('../backend/src/services/userService', () => ({}));
jest.mock('../backend/src/services/tasksService', () => ({ emitTaskChange: jest.fn() }));
jest.mock('../backend/src/services/jobsService', () => ({}));
jest.mock('../backend/src/services/taskActions/registry', () => ({ get: jest.fn(), list: jest.fn(() => []) }));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));

const http = require('http');
const express = require('express');
const tasksQueries = require('../backend/src/db/tasksQueries');
const { resolveTaskContentScope } = require('../backend/src/middleware/taskContentScope');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const PROVIDER_USER = '11111111-1111-1111-1111-111111111111';
const OTHER_USER = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
    Object.values(tasksQueries).forEach(fn => fn.mockClear && fn.mockClear());
});

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

// Stub the auth context requirePermission/canManage/actorId read. A provider role here
// = tasks.view (reaches the section) WITHOUT tasks.manage (content-scoped).
function appWithAuthz({ permissions = ['tasks.view'], userId = PROVIDER_USER } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'kc-sub', email: 'p@x.com', crmUser: { id: userId } };
        req.authz = { scope: 'tenant', permissions, scopes: { job_visibility: 'assigned_only' }, membership: { role_key: 'provider' } };
        req.companyFilter = { company_id: COMPANY_A };
        next();
    });
    app.use('/', require('../backend/src/routes/tasks'));
    return app;
}

describe('ROLE-TASKS-SCOPE-001 — list visibility', () => {
    it('derives see-all from tasks.manage, never from a role_key literal', () => {
        expect(resolveTaskContentScope(['tasks.view'], PROVIDER_USER)).toEqual({
            canViewAll: false,
            userId: PROVIDER_USER,
        });
        expect(resolveTaskContentScope(['tasks.view', 'tasks.manage'], PROVIDER_USER)).toEqual({
            canViewAll: true,
            userId: null,
        });
        expect(resolveTaskContentScope(['tasks.view'], null)).toEqual({
            canViewAll: false,
            userId: null,
        });
    });

    it('a non-manager (provider) is scoped to their own owned/authored tasks', async () => {
        const res = await request(appWithAuthz({ permissions: ['tasks.view'] }), 'GET', '/');
        expect(res.status).toBe(200);
        expect(tasksQueries.listTasksPage).toHaveBeenCalledTimes(1);
        const [company, filters] = tasksQueries.listTasksPage.mock.calls[0];
        expect(company).toBe(COMPANY_A);
        expect(filters.scopeOwnerId).toBe(PROVIDER_USER);
    });

    it('a manager (tasks.manage) sees all — no owner scope applied', async () => {
        const res = await request(appWithAuthz({ permissions: ['tasks.view', 'tasks.manage'] }), 'GET', '/');
        expect(res.status).toBe(200);
        const [, filters] = tasksQueries.listTasksPage.mock.calls[0];
        expect(filters.scopeOwnerId).toBeUndefined();
    });

    it('the open-count badge is scoped the same way for a provider', async () => {
        await request(appWithAuthz({ permissions: ['tasks.view'] }), 'GET', '/count');
        const [, filters] = tasksQueries.countTasks.mock.calls[0];
        expect(filters.scopeOwnerId).toBe(PROVIDER_USER);
        expect(filters.snoozed).toBe('active');
    });
});

describe('ROLE-TASKS-SCOPE-001 — mutation access (canActOn)', () => {
    it("a provider cannot modify a teammate's task (not owner, not author) → 403", async () => {
        tasksQueries.getTaskById.mockResolvedValueOnce({ id: 7, owner_user_id: OTHER_USER, author_user_id: OTHER_USER });
        const res = await request(appWithAuthz({ permissions: ['tasks.view'] }), 'PATCH', '/7', { status: 'done' });
        expect(res.status).toBe(403);
        expect(tasksQueries.updateTask).not.toHaveBeenCalled();
    });

    it('a provider CAN modify a task they authored → 200', async () => {
        tasksQueries.getTaskById.mockResolvedValueOnce({ id: 7, owner_user_id: OTHER_USER, author_user_id: PROVIDER_USER });
        const res = await request(appWithAuthz({ permissions: ['tasks.view'] }), 'PATCH', '/7', { status: 'done' });
        expect(res.status).toBe(200);
        expect(tasksQueries.updateTask).toHaveBeenCalledTimes(1);
    });

    it("a manager CAN modify anyone's task → 200", async () => {
        tasksQueries.getTaskById.mockResolvedValueOnce({ id: 7, owner_user_id: OTHER_USER, author_user_id: OTHER_USER });
        const res = await request(appWithAuthz({ permissions: ['tasks.view', 'tasks.manage'] }), 'PATCH', '/7', { status: 'done' });
        expect(res.status).toBe(200);
    });
});
