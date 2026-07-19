'use strict';

const COMPANY = '00000000-0000-0000-0000-00000000c101';
const ME = '00000000-0000-0000-0000-00000000c102';
const OTHER = '00000000-0000-0000-0000-00000000c103';
const DUE_TS = '2026-07-18T16:00:00.123456Z';
const CREATED_TS = '2026-07-17T12:00:00.654321Z';

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../backend/src/services/userService', () => ({ listUsers: jest.fn() }));

const express = require('express');
const request = require('supertest');
const tasksQueries = require('../backend/src/db/tasksQueries');
const tasksRouter = require('../backend/src/routes/tasks');

function taskRow(id, overrides = {}) {
    return {
        id,
        company_id: COMPANY,
        description: `Task ${id}`,
        status: 'open',
        due_at: new Date('2026-07-18T16:00:00.123Z'),
        created_at: new Date('2026-07-17T12:00:00.654Z'),
        assignee_name: 'Alex Tech',
        assignee_email: 'alex@example.com',
        parent_type: 'job',
        parent_id: id,
        parent_label: `Job ${id}`,
        __cursor_null: false,
        __cursor_value: DUE_TS,
        __cursor_created: CREATED_TS,
        __cursor_id: String(id),
        ...overrides,
    };
}

function usePageDispatch({ total = 0, rows = [] } = {}) {
    mockQuery.mockImplementation(async (sql) => {
        if (/SELECT COUNT\(\*\)::int AS total/i.test(sql)) return { rows: [{ total }] };
        if (/SELECT page_base\.\*/i.test(sql)) return { rows };
        throw new Error(`Unexpected Tasks page SQL: ${sql}`);
    });
}

function appFor({ manage = true, actor = ME } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'kc-sub', crmUser: { id: actor } };
        req.authz = {
            scope: 'tenant',
            permissions: manage ? ['tasks.view', 'tasks.manage'] : ['tasks.view'],
        };
        req.companyFilter = { company_id: COMPANY };
        next();
    });
    app.use('/api/tasks', tasksRouter);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    usePageDispatch();
});

describe('Tasks route-only page contract', () => {
    test('manager gets cursor pagination while non-manager rows and total share owner scope', async () => {
        const managerResponse = await request(appFor()).get('/api/tasks');
        expect(managerResponse.status).toBe(200);
        expect(managerResponse.body.data.pagination).toMatchObject({
            mode: 'cursor',
            limit: 50,
            total: 0,
        });
        expect(mockQuery.mock.calls[0][0]).not.toMatch(/t\.owner_user_id = \$/);

        jest.clearAllMocks();
        usePageDispatch();
        const providerResponse = await request(appFor({ manage: false })).get('/api/tasks');
        expect(providerResponse.status).toBe(200);
        for (const [sql, params] of mockQuery.mock.calls) {
            expect(sql).toMatch(/t\.company_id = \$1/);
            expect(sql).toMatch(/t\.owner_user_id = \$2/);
            expect(params.slice(0, 3)).toEqual([COMPANY, ME, 'open']);
        }
    });

    test('route forwards search/sort/filter controls and rejects malformed sort/cursor input as 400', async () => {
        const response = await request(appFor()).get('/api/tasks').query({
            status: 'all',
            parent_type: 'job',
            search: 'boiler',
            sort_by: 'parent_label',
            sort_order: 'desc',
            limit: '25',
        });
        expect(response.status).toBe(200);
        const dataSql = mockQuery.mock.calls[1][0];
        expect(dataSql).toMatch(/t\.job_id IS NOT NULL/);
        expect(dataSql).toMatch(/t\.title ILIKE \$2/);
        expect(dataSql).toMatch(/page_base\.parent_label/);
        expect(dataSql).toMatch(/page_base\.id DESC/);
        expect(mockQuery.mock.calls[1][1].at(-1)).toBe(26);

        jest.clearAllMocks();
        usePageDispatch();
        const badSort = await request(appFor()).get('/api/tasks').query({ sort_by: 'drop_table' });
        expect(badSort.status).toBe(400);
        expect(badSort.body.error.code).toBe('INVALID_QUERY');
        expect(mockQuery).not.toHaveBeenCalled();

        const mixed = await request(appFor()).get('/api/tasks').query({ cursor: 'opaque', offset: '0' });
        expect(mixed.status).toBe(400);
        expect(mixed.body.error.code).toBe('INVALID_CURSOR_REQUEST');
        expect(mockQuery).not.toHaveBeenCalled();
    });
});

describe('Tasks complete search/sort/count predicates', () => {
    test('search matches description, shared parent label, and tenant-scoped assignee in rows and count', async () => {
        await tasksQueries.listTasksPage(COMPANY, {
            status: 'open',
            scopeOwnerId: ME,
            search: 'Boiler',
            sort_by: 'description',
            sort_order: 'asc',
            limit: 50,
        });

        const [countSql, countParams] = mockQuery.mock.calls[0];
        const [pageSql, pageParams] = mockQuery.mock.calls[1];
        for (const sql of [countSql, pageSql]) {
            expect(sql).toMatch(/t\.company_id = \$1/);
            expect(sql).toMatch(/t\.owner_user_id = \$2/);
            expect(sql).toMatch(/t\.title ILIKE \$4/);
            expect(sql).toMatch(/WHEN t\.job_id\s+IS NOT NULL THEN COALESCE/);
            expect(sql).toMatch(/ow\.full_name ILIKE \$4/);
            expect(sql).toMatch(/ow\.company_id = t\.company_id/);
        }
        expect(countParams).toEqual([COMPANY, ME, 'open', '%Boiler%']);
        expect(pageParams.slice(0, 4)).toEqual(countParams);
    });

    test.each(['description', 'parent_type', 'parent_label', 'assignee_name'])(
        '%s uses the normalized backend expression plus ID',
        async (sortBy) => {
            await tasksQueries.listTasksPage(COMPANY, {
                sort_by: sortBy,
                sort_order: 'desc',
            });
            const dataSql = mockQuery.mock.calls[1][0];
            expect(dataSql).toMatch(new RegExp(`page_base\\.${sortBy}`));
            expect(dataSql).toMatch(/page_base\.id DESC/);
        },
    );

    test('legacy listTasks remains array-returning and /count keeps its bare-table contract', async () => {
        mockQuery.mockReset();
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });
        const legacy = await tasksQueries.listTasks(COMPANY, { status: 'open' });
        expect(legacy).toEqual([{ id: 1 }]);
        expect(mockQuery).toHaveBeenCalledTimes(1);
        expect(mockQuery.mock.calls[0][0]).toMatch(/LIMIT \$3 OFFSET \$4/);

        mockQuery.mockReset();
        mockQuery.mockResolvedValueOnce({ rows: [{ count: 7 }] });
        expect(await tasksQueries.countTasks(COMPANY, { status: 'open' })).toBe(7);
        expect(mockQuery.mock.calls[0][0]).toBe(
            "SELECT COUNT(*)::int AS count FROM tasks t WHERE t.company_id = $1 AND "
            + "(t.job_id IS NOT NULL OR t.lead_id IS NOT NULL OR t.estimate_id IS NOT NULL OR "
            + "t.invoice_id IS NOT NULL OR t.contact_id IS NOT NULL OR "
            + "(t.thread_id IS NOT NULL AND t.created_by IN ('user', 'agent'))) AND t.status = $2",
        );
    });
});

describe('Tasks cursor boundaries', () => {
    test('default due/created/ID tuple returns 50 then one and continuation skips count', async () => {
        const rows = Array.from({ length: 51 }, (_unused, index) => taskRow(100 - index));
        usePageDispatch({ total: 51, rows });

        const first = await tasksQueries.listTasksPage(COMPANY, { limit: 50 });

        expect(first.tasks).toHaveLength(50);
        expect(first.tasks[0]).not.toHaveProperty('__cursor_value');
        expect(first.pagination).toMatchObject({ total: 51, has_more: true });
        expect(first.pagination.next_cursor).toEqual(expect.any(String));

        jest.clearAllMocks();
        usePageDispatch({ rows: [taskRow(50)] });
        const second = await tasksQueries.listTasksPage(COMPANY, {
            limit: 50,
            cursor: first.pagination.next_cursor,
        });

        expect(second.tasks.map(task => task.id)).toEqual([50]);
        expect(second.pagination).toMatchObject({ total: null, has_more: false, next_cursor: null });
        expect(mockQuery).toHaveBeenCalledTimes(1);
        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toMatch(/\(page_base\.due_at IS NULL\) > \$2::boolean/);
        expect(sql).toMatch(/page_base\.created_at < \$4::timestamptz/);
        expect(sql).toMatch(/page_base\.id < \$5::bigint/);
        expect(params.slice(0, 5)).toEqual([COMPANY, false, DUE_TS, CREATED_TS, '51']);
    });

    test('null due values remain last and continue through ID without duplicates', async () => {
        const nullRows = Array.from({ length: 3 }, (_unused, index) => taskRow(3 - index, {
            due_at: null,
            __cursor_null: true,
            __cursor_value: null,
        }));
        usePageDispatch({ total: 3, rows: nullRows });

        const first = await tasksQueries.listTasksPage(COMPANY, { limit: 2, sort_order: 'desc' });
        expect(first.pagination.has_more).toBe(true);

        jest.clearAllMocks();
        usePageDispatch({ rows: [nullRows[2]] });
        await tasksQueries.listTasksPage(COMPANY, {
            limit: 2,
            sort_order: 'desc',
            cursor: first.pagination.next_cursor,
        });
        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toMatch(/page_base\.due_at IS NOT DISTINCT FROM \$3::timestamptz/);
        expect(params.slice(0, 5)).toEqual([COMPANY, true, null, CREATED_TS, '2']);
    });

    test('actor-scope changes reject the cursor before SQL', async () => {
        usePageDispatch({ total: 51, rows: Array.from({ length: 51 }, (_unused, index) => taskRow(100 - index)) });
        const first = await tasksQueries.listTasksPage(COMPANY, { scopeOwnerId: ME, limit: 50 });

        jest.clearAllMocks();
        await expect(tasksQueries.listTasksPage(COMPANY, {
            scopeOwnerId: OTHER,
            limit: 50,
            cursor: first.pagination.next_cursor,
        })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
        expect(mockQuery).not.toHaveBeenCalled();
    });

    test('legacy offset mode remains additive and probes one extra row', async () => {
        usePageDispatch({ total: 3, rows: [taskRow(3), taskRow(2), taskRow(1)] });
        const page = await tasksQueries.listTasksPage(COMPANY, { limit: 2, offset: 4 });
        expect(page.pagination).toMatchObject({
            mode: 'offset',
            total: 3,
            returned: 2,
            has_more: true,
            next_cursor: null,
        });
        expect(mockQuery.mock.calls[1][1].slice(-2)).toEqual([3, 4]);
    });
});
