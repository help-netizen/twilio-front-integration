/**
 * TASKS-001 — tasks route tests.
 *
 * DB is mocked like the other route tests; the query layer (tasksQueries) runs
 * for real against the mocked db.query. The fake auth middleware sets
 * req.user/req.authz/req.companyFilter so the per-route requirePermission gating
 * and the own-vs-all visibility scoping are exercised. (401 is enforced by the
 * real `authenticate` at mount time in production, consistent with the suite.)
 */

const express = require('express');
const request = require('supertest');

const mockQuery = jest.fn();
jest.mock('../../backend/src/db/connection', () => ({ query: mockQuery }));
jest.mock('../../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../../backend/src/services/userService', () => ({ listUsers: jest.fn() }));

const tasksRouter = require('../../backend/src/routes/tasks');
const userService = require('../../backend/src/services/userService');

const COMPANY = '00000000-0000-0000-0000-000000000001';
const ME = 'crm-me';
const OTHER = 'crm-other';

function makeApp({ permissions = ['tasks.view', 'tasks.create', 'tasks.manage'], company = COMPANY, me = ME } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'kc', email: 'u@x.com', crmUser: { id: me } };
        req.authz = { scope: 'tenant', permissions };
        req.companyFilter = { company_id: company };
        next();
    });
    app.use('/api/tasks', tasksRouter);
    return app;
}

beforeEach(() => jest.clearAllMocks());

describe('gating', () => {
    test('GET / without tasks.view → 403, no query', async () => {
        const res = await request(makeApp({ permissions: ['jobs.view'] })).get('/api/tasks');
        expect(res.status).toBe(403);
        expect(mockQuery).not.toHaveBeenCalled();
    });

    test('POST / without tasks.create → 403, no query', async () => {
        const res = await request(makeApp({ permissions: ['tasks.view'] }))
            .post('/api/tasks').send({ parent_type: 'job', parent_id: 1, description: 'x' });
        expect(res.status).toBe(403);
        expect(mockQuery).not.toHaveBeenCalled();
    });
});

describe('GET / — visibility scope', () => {
    test('manager (tasks.manage) sees all — no owner scoping', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, parent_type: 'job' }] });
        const res = await request(makeApp()).get('/api/tasks');
        expect(res.status).toBe(200);
        expect(res.body.data.tasks).toHaveLength(1);
        const sql = mockQuery.mock.calls[0][0];
        expect(sql).not.toMatch(/t\.owner_user_id = \$/);
    });

    test('provider (no manage) is scoped to own tasks', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });
        const res = await request(makeApp({ permissions: ['tasks.view', 'tasks.create'] })).get('/api/tasks');
        expect(res.status).toBe(200);
        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toMatch(/t\.owner_user_id = \$2/);
        expect(params[1]).toBe(ME);
    });

    test('default filter is status=open; ?status=all drops it', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });
        await request(makeApp()).get('/api/tasks');
        expect(mockQuery.mock.calls[0][0]).toMatch(/t\.status = \$/);
        mockQuery.mockClear();
        mockQuery.mockResolvedValueOnce({ rows: [] });
        await request(makeApp()).get('/api/tasks?status=all');
        expect(mockQuery.mock.calls[0][0]).not.toMatch(/t\.status = \$/);
    });
});

describe('GET /count — open-task badge (TASKS-COUNT-BADGE-001)', () => {
    test('happy path → { ok, data: { count } } (TC-5)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ count: 7 }] });
        const res = await request(makeApp()).get('/api/tasks/count');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, data: { count: 7 } });
    });

    test('without tasks.view → 403, no query (TC-6)', async () => {
        const res = await request(makeApp({ permissions: ['jobs.view'] })).get('/api/tasks/count');
        expect(res.status).toBe(403);
        expect(mockQuery).not.toHaveBeenCalled();
    });

    test('manager: no owner scoping; filters forced status=open (TC-8)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ count: 3 }] });
        const res = await request(makeApp()).get('/api/tasks/count');
        expect(res.status).toBe(200);
        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toMatch(/SELECT COUNT\(\*\)::int AS count FROM tasks t WHERE/);
        expect(sql).not.toMatch(/t\.owner_user_id = \$/);
        expect(sql).toMatch(/t\.status = \$/);
        expect(params).toContain('open');
    });

    test('provider (no manage): scopeOwnerId = crmUser.id, never sub (TC-8)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ count: 2 }] });
        const res = await request(makeApp({ permissions: ['tasks.view', 'tasks.create'] })).get('/api/tasks/count');
        expect(res.status).toBe(200);
        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toMatch(/t\.owner_user_id = \$2/);
        expect(params[1]).toBe(ME);       // crmUser.id
        expect(params).not.toContain('kc'); // never the Keycloak sub
    });

    test('count reuses the list predicate — same conditions/$n as GET / (TC-9 mock)', async () => {
        // Provider scope: GET / list and GET /count must build the same owner+status predicate.
        mockQuery.mockResolvedValueOnce({ rows: [] });
        await request(makeApp({ permissions: ['tasks.view', 'tasks.create'] })).get('/api/tasks?status=open');
        const listSql = mockQuery.mock.calls[0][0];
        mockQuery.mockClear();
        mockQuery.mockResolvedValueOnce({ rows: [{ count: 0 }] });
        await request(makeApp({ permissions: ['tasks.view', 'tasks.create'] })).get('/api/tasks/count');
        const countSql = mockQuery.mock.calls[0][0];
        for (const frag of ['t.company_id = $1', 't.owner_user_id = $2', 't.status = $3']) {
            expect(listSql).toContain(frag);
            expect(countSql).toContain(frag);
        }
    });

    test('excludes auto timeline tasks via HAS_ENTITY_PARENT (TC-11 mock)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ count: 0 }] });
        await request(makeApp()).get('/api/tasks/count');
        const sql = mockQuery.mock.calls[0][0];
        expect(sql).toMatch(/t\.created_by IN \('user', 'agent'\)/);
    });

    test('route order: /count resolves to the count handler, not :id=count (TC-23)', async () => {
        // If /:id caught it, getTaskById would run first (SELECT_TASK with LEFT JOINs).
        mockQuery.mockResolvedValueOnce({ rows: [{ count: 4 }] });
        const res = await request(makeApp()).get('/api/tasks/count');
        expect(res.status).toBe(200);
        expect(res.body.data.count).toBe(4);
        expect(mockQuery.mock.calls[0][0]).toMatch(/SELECT COUNT\(\*\)/);
        expect(mockQuery.mock.calls[0][0]).not.toMatch(/LEFT JOIN/);
    });

    test('manager may pass ?assignee_id (parity with list); non-manager ignores it (TC-24)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ count: 1 }] });
        await request(makeApp()).get('/api/tasks/count?assignee_id=U2');
        let [sql, params] = mockQuery.mock.calls[0];
        // filters seed status='open' first ($2), then assignee_id owner cond ($3).
        expect(sql).toMatch(/t\.owner_user_id = \$3/);
        expect(params[2]).toBe('U2');

        mockQuery.mockClear();
        mockQuery.mockResolvedValueOnce({ rows: [{ count: 0 }] });
        await request(makeApp({ permissions: ['tasks.view', 'tasks.create'] })).get('/api/tasks/count?assignee_id=U2');
        [sql, params] = mockQuery.mock.calls[0];
        // Non-manager: assignee_id is ignored; owner scope pins to ME, not U2.
        expect(params).not.toContain('U2');
        expect(params[1]).toBe(ME);
    });

    test('DB error → 500 house envelope', async () => {
        mockQuery.mockRejectedValueOnce(new Error('boom'));
        const res = await request(makeApp()).get('/api/tasks/count');
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'Failed to count tasks' } });
    });

    // ── SOFTPHONE-WARMUP-SUMMARY-001 — parent_type pass-through (spec §5.3) ──
    test('?parent_type=timeline adds thread_id predicate, params unchanged (TC-WS-01)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ count: 5 }] });
        const res = await request(makeApp()).get('/api/tasks/count?parent_type=timeline');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, data: { count: 5 } });
        const [sql, params] = mockQuery.mock.calls[0];
        // The standalone predicate is APPENDED after status (HAS_ENTITY_PARENT already
        // holds one t.thread_id occurrence inside its OR-group — hence the AND-anchor).
        expect(sql).toMatch(/t\.status = \$2 AND t\.thread_id IS NOT NULL/);
        // No new $n: predicate is param-less; manager branch intact (no owner scoping).
        expect(params).toEqual([COMPANY, 'open']);
        expect(sql).not.toMatch(/t\.owner_user_id = \$/);
        // Tenant scoping: the filtered count stays company-scoped.
        expect(sql).toMatch(/t\.company_id = \$1/);
    });

    test('no parent_type param → SQL byte-identical to today (TC-WS-02 drift guard)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ count: 1 }] });
        await request(makeApp()).get('/api/tasks/count');
        const [sql, params] = mockQuery.mock.calls[0];
        // Pinned byte-for-byte to the pre-change (TASKS-COUNT-BADGE-001) manager SQL.
        expect(sql).toBe(
            "SELECT COUNT(*)::int AS count FROM tasks t WHERE t.company_id = $1 AND " +
            "(t.job_id IS NOT NULL OR t.lead_id IS NOT NULL OR t.estimate_id IS NOT NULL OR " +
            "t.invoice_id IS NOT NULL OR t.contact_id IS NOT NULL OR " +
            "(t.thread_id IS NOT NULL AND t.created_by IN ('user', 'agent'))) AND t.status = $2"
        );
        expect(params).toEqual([COMPANY, 'open']);
    });

    test('?parent_type=bogus silently ignored — SQL byte-equal to no-param (TC-WS-03)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ count: 1 }] });
        await request(makeApp()).get('/api/tasks/count');
        const [baseSql, baseParams] = mockQuery.mock.calls[0];
        mockQuery.mockClear();
        mockQuery.mockResolvedValueOnce({ rows: [{ count: 1 }] });
        const res = await request(makeApp()).get('/api/tasks/count?parent_type=bogus');
        expect(res.status).toBe(200);
        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toBe(baseSql);
        expect(params).toEqual(baseParams);
    });

    test('provider + ?parent_type=timeline → owner scope AND thread predicate (TC-WS-04)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ count: 2 }] });
        const res = await request(makeApp({ permissions: ['tasks.view', 'tasks.create'] }))
            .get('/api/tasks/count?parent_type=timeline');
        expect(res.status).toBe(200);
        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toMatch(/t\.owner_user_id = \$2/);
        expect(sql).toMatch(/t\.status = \$3 AND t\.thread_id IS NOT NULL/); // appended predicate
        // Full params: tenant $1, owner $2 = crmUser.id (never the Keycloak sub), status $3 = 'open'.
        expect(params).toEqual([COMPANY, ME, 'open']);
        expect(params).not.toContain('kc');
        expect(sql).toMatch(/t\.company_id = \$1/); // cross-tenant probe can only count own rows
    });
});

describe('GET /assignees', () => {
    test('403 without tasks.create/manage', async () => {
        const res = await request(makeApp({ permissions: ['tasks.view'] })).get('/api/tasks/assignees');
        expect(res.status).toBe(403);
    });

    test('returns id+name list', async () => {
        userService.listUsers.mockResolvedValueOnce({ users: [{ id: 'u1', full_name: 'Ann', email: 'a@x.com' }] });
        const res = await request(makeApp()).get('/api/tasks/assignees');
        expect(res.status).toBe(200);
        expect(userService.listUsers).toHaveBeenCalledWith(COMPANY, expect.objectContaining({ status: 'active' }));
        expect(res.body.data.users).toEqual([{ id: 'u1', name: 'Ann', email: 'a@x.com' }]);
    });
});

describe('GET /entity/:parentType/:parentId', () => {
    test('invalid parent type → 400, no query', async () => {
        const res = await request(makeApp()).get('/api/tasks/entity/widget/5');
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_PARENT_TYPE');
        expect(mockQuery).not.toHaveBeenCalled();
    });

    test('parent not in company → 404 (only the existence check ran)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] }); // parentExists → none
        const res = await request(makeApp()).get('/api/tasks/entity/job/999');
        expect(res.status).toBe(404);
        expect(mockQuery).toHaveBeenCalledTimes(1);
        expect(mockQuery.mock.calls[0][1]).toEqual(['999', COMPANY]);
    });

    test('valid → returns the parent tasks', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ 1: 1 }] });            // parentExists
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 7, parent_type: 'job' }] }); // listEntityTasks
        const res = await request(makeApp()).get('/api/tasks/entity/job/5');
        expect(res.status).toBe(200);
        expect(res.body.data.tasks).toHaveLength(1);
        expect(mockQuery.mock.calls[1][0]).toMatch(/t\.job_id = \$2/);
    });
});

describe('POST / — create', () => {
    test('missing parent → 400', async () => {
        const res = await request(makeApp()).post('/api/tasks').send({ description: 'x' });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('MISSING_PARENT');
        expect(mockQuery).not.toHaveBeenCalled();
    });

    test('invalid parent type → 400', async () => {
        const res = await request(makeApp()).post('/api/tasks').send({ parent_type: 'widget', parent_id: 1, description: 'x' });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_PARENT_TYPE');
    });

    test('empty description → 400', async () => {
        const res = await request(makeApp()).post('/api/tasks').send({ parent_type: 'job', parent_id: 1, description: '   ' });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('DESCRIPTION_REQUIRED');
    });

    test('invalid due_at → 400', async () => {
        const res = await request(makeApp()).post('/api/tasks').send({ parent_type: 'job', parent_id: 1, description: 'x', due_at: 'not-a-date' });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_DUE_AT');
    });

    test('parent not found → 404', async () => {
        // TASKS-LEAD-UUID-001: a lead parent resolves via uuid then a numeric-id
        // fallback — both miss here, so parentExists is false → 404.
        mockQuery.mockResolvedValueOnce({ rows: [] }); // resolveParentId: lead uuid miss
        mockQuery.mockResolvedValueOnce({ rows: [] }); // resolveParentId: numeric leads.id fallback miss
        const res = await request(makeApp()).post('/api/tasks').send({ parent_type: 'lead', parent_id: 42, description: 'Call' });
        expect(res.status).toBe(404);
    });

    test('valid → 201, author = crmUser.id, owner defaults to me, company-scoped', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ 1: 1 }] });          // parentExists
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 10 }] });         // INSERT RETURNING id
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 10, description: 'Call client', status: 'open', owner_user_id: ME, author_user_id: ME, parent_type: 'job', parent_id: 5 }] }); // getTaskById

        const res = await request(makeApp()).post('/api/tasks')
            .send({ parent_type: 'job', parent_id: 5, description: 'Call client' });

        expect(res.status).toBe(201);
        expect(res.body.data.task.id).toBe(10);
        const [sql, vals] = mockQuery.mock.calls[1];
        expect(sql).toMatch(/INSERT INTO tasks/i);
        expect(sql).toMatch(/author_user_id/);
        expect(vals[0]).toBe(COMPANY);
        expect(vals[1]).toBe('Call client'); // title holds the text
        expect(vals[5]).toBe(ME);            // owner defaults to me
        expect(vals[6]).toBe(ME);            // author = crmUser.id
        expect(vals[8]).toBe(5);             // parent id (job_id)
    });
});

describe('PATCH /:id — edit / complete / snooze', () => {
    test('not found (or cross-tenant) → 404', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] }); // getTaskById → none (company-scoped)
        const res = await request(makeApp()).patch('/api/tasks/123').send({ status: 'done' });
        expect(res.status).toBe(404);
        expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    test('provider modifying a task they neither own nor authored → 403', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 7, owner_user_id: OTHER, author_user_id: OTHER, status: 'open' }] });
        const res = await request(makeApp({ permissions: ['tasks.view', 'tasks.create'] }))
            .patch('/api/tasks/7').send({ status: 'done' });
        expect(res.status).toBe(403);
        expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    test('invalid status → 400', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 7, owner_user_id: ME, author_user_id: ME, status: 'open' }] });
        const res = await request(makeApp()).patch('/api/tasks/7').send({ status: 'archived' });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_STATUS');
    });

    test('done sets completed_at; returns updated task', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 7, owner_user_id: ME, author_user_id: ME, status: 'open' }] }); // getTaskById
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 7 }] });                                                          // UPDATE RETURNING id
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 7, status: 'done', completed_at: '2026-06-28T00:00:00Z' }] });    // getTaskById
        const res = await request(makeApp()).patch('/api/tasks/7').send({ status: 'done' });
        expect(res.status).toBe(200);
        expect(res.body.data.task.status).toBe('done');
        expect(mockQuery.mock.calls[1][0]).toMatch(/completed_at = CASE WHEN/i);
    });

    test('provider can complete their OWN task', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 8, owner_user_id: ME, author_user_id: OTHER, status: 'open' }] });
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 8 }] });
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 8, status: 'done' }] });
        const res = await request(makeApp({ permissions: ['tasks.view', 'tasks.create'] }))
            .patch('/api/tasks/8').send({ status: 'done' });
        expect(res.status).toBe(200);
    });
});

describe('DELETE /:id', () => {
    test('foreign/unknown id → 404', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });
        const res = await request(makeApp()).delete('/api/tasks/55');
        expect(res.status).toBe(404);
    });

    test('allowed → deletes', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 9, owner_user_id: ME, author_user_id: ME }] });
        mockQuery.mockResolvedValueOnce({ rowCount: 1 });
        const res = await request(makeApp()).delete('/api/tasks/9');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(mockQuery.mock.calls[1][0]).toMatch(/DELETE FROM tasks/i);
    });
});
