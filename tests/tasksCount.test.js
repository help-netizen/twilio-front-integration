/**
 * TASKS-COUNT-BADGE-001 — query-layer tests for the shared predicate builder and
 * the count sibling. DB is mocked (like the route tests); the query layer runs
 * for real against the mocked db.query.
 *
 * These cover the load-bearing invariant *structurally* (AC-1..AC-3): both
 * `listTasks` and `countTasks` consume the SAME `buildTaskListFilters`, so the
 * count can never diverge from the list. Jest mocks the DB, so the true
 * count == list.length equality over real rows is proven by the T4 verify
 * script — here we assert the drift-proof shape (per LIST-PAGINATION-001 lesson).
 */

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));

const tasksQueries = require('../backend/src/db/tasksQueries');

const COMPANY = '00000000-0000-0000-0000-000000000001';
const ME = 'crm-me';

// The exact HAS_ENTITY_PARENT fragment listTasks/countTasks seed as conditions[1].
const HAS_ENTITY_PARENT =
    "(t.job_id IS NOT NULL OR t.lead_id IS NOT NULL OR t.estimate_id IS NOT NULL OR t.invoice_id IS NOT NULL OR t.contact_id IS NOT NULL OR (t.thread_id IS NOT NULL AND t.created_by IN ('user', 'agent')))";

beforeEach(() => jest.clearAllMocks());

describe('buildTaskListFilters — shared predicate (TC-2)', () => {
    test('seed: company_id first, HAS_ENTITY_PARENT second, params=[companyId]', () => {
        const { conditions, params } = tasksQueries.buildTaskListFilters(COMPANY, {});
        expect(conditions[0]).toBe('t.company_id = $1');
        expect(conditions[1]).toBe(HAS_ENTITY_PARENT);
        expect(params).toEqual([COMPANY]);
    });

    test('scopeOwnerId + status push in order with stable $n numbering', () => {
        const { conditions, params } = tasksQueries.buildTaskListFilters(COMPANY, {
            status: 'open',
            scopeOwnerId: ME,
        });
        // scopeOwnerId pushes before status → $2 owner, $3 status.
        expect(conditions).toContain('t.owner_user_id = $2');
        expect(conditions).toContain('t.status = $3');
        expect(params).toEqual([COMPANY, ME, 'open']);
    });

    test('parent_type / overdue add conditions WITHOUT a param; due_from/due_to cast timestamptz', () => {
        const { conditions, params } = tasksQueries.buildTaskListFilters(COMPANY, {
            status: 'open',
            parent_type: 'job',
            overdue: true,
            due_from: '2026-01-01',
            due_to: '2026-12-31',
        });
        expect(conditions).toContain('t.job_id IS NOT NULL');
        expect(conditions).toContain("t.status = 'open' AND t.due_at IS NOT NULL AND t.due_at < now()");
        // status $2 (param), then due_from $3, due_to $4 (parent_type/overdue = no param).
        expect(conditions).toContain('t.due_at >= $3::timestamptz');
        expect(conditions).toContain('t.due_at <= $4::timestamptz');
        expect(params).toEqual([COMPANY, 'open', '2026-01-01', '2026-12-31']);
    });

    test('$n numbering is stable regardless of caller (pure function of inputs)', () => {
        const a = tasksQueries.buildTaskListFilters(COMPANY, { status: 'open', scopeOwnerId: ME });
        const b = tasksQueries.buildTaskListFilters(COMPANY, { status: 'open', scopeOwnerId: ME });
        expect(a.conditions).toEqual(b.conditions);
        expect(a.params).toEqual(b.params);
    });
});

// Extract the WHERE predicate (everything between "WHERE " and the first of
// ORDER BY / end-of-string). Both callers build this from buildTaskListFilters,
// so for identical inputs the extracted clauses MUST be byte-identical — that is
// the structural drift guard (AC-1..AC-3), independent of jest DB mocking.
function whereClause(sql) {
    const start = sql.indexOf('WHERE ') + 'WHERE '.length;
    const order = sql.indexOf('ORDER BY');
    const end = order === -1 ? sql.length : order;
    return sql.slice(start, end).trim();
}

describe('drift guard — listTasks & countTasks share the builder (TC-9 mock)', () => {
    test('both emit a byte-identical WHERE clause for identical inputs', async () => {
        const filters = { status: 'open', scopeOwnerId: ME };

        mockQuery.mockResolvedValueOnce({ rows: [] });            // listTasks
        await tasksQueries.listTasks(COMPANY, filters);
        mockQuery.mockResolvedValueOnce({ rows: [{ count: 0 }] }); // countTasks
        await tasksQueries.countTasks(COMPANY, filters);

        const listWhere = whereClause(mockQuery.mock.calls[0][0]);
        const countWhere = whereClause(mockQuery.mock.calls[1][0]);

        // The full predicate is identical — same source builder, no drift.
        expect(countWhere).toBe(listWhere);
        expect(listWhere).toBe(
            "t.company_id = $1 AND " + HAS_ENTITY_PARENT + " AND t.owner_user_id = $2 AND t.status = $3"
        );

        // Shared param prefix identical; count carries no limit/offset tail.
        expect(mockQuery.mock.calls[1][1]).toEqual([COMPANY, ME, 'open']);
        expect(mockQuery.mock.calls[0][1].slice(0, 3)).toEqual([COMPANY, ME, 'open']);
    });

    test('listTasks appends limit/offset AFTER the shared block; countTasks does not', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });
        await tasksQueries.listTasks(COMPANY, { status: 'open' });
        const [listSql, listParams] = mockQuery.mock.calls[0];
        expect(listSql).toMatch(/LIMIT \$3 OFFSET \$4/);
        expect(listParams).toEqual([COMPANY, 'open', 100, 0]); // default limit 100, offset 0

        mockQuery.mockClear();
        mockQuery.mockResolvedValueOnce({ rows: [{ count: 0 }] });
        await tasksQueries.countTasks(COMPANY, { status: 'open' });
        const [countSql, countParams] = mockQuery.mock.calls[0];
        expect(countSql).not.toMatch(/LIMIT/);
        expect(countSql).not.toMatch(/OFFSET/);
        expect(countParams).toEqual([COMPANY, 'open']);
    });
});

describe('countTasks — SQL shape + return (TC-3)', () => {
    test('COUNT(*) over bare tasks t; company_id/HAS_ENTITY_PARENT/status present; NO join block', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ count: 5 }] });
        const n = await tasksQueries.countTasks(COMPANY, { status: 'open', scopeOwnerId: ME });
        expect(n).toBe(5);

        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toMatch(/SELECT COUNT\(\*\)::int AS count FROM tasks t WHERE/);
        expect(sql).toContain('t.company_id = $1');
        expect(sql).toContain(HAS_ENTITY_PARENT);
        expect(sql).toContain('t.status = $3');
        expect(sql).toContain('t.owner_user_id = $2');
        // Must NOT carry any SELECT_TASK label-hydration joins.
        expect(sql).not.toMatch(/LEFT JOIN/);
        expect(sql).not.toMatch(/crm_users ow/);
        expect(sql).not.toMatch(/parent_label/);
        expect(sql).not.toMatch(/SELECT_TASK/);
        expect(params).toEqual([COMPANY, ME, 'open']);
    });

    test('empty result set → 0 (rows[0]?.count || 0)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });
        expect(await tasksQueries.countTasks(COMPANY, { status: 'open' })).toBe(0);
    });
});

describe('countTasks — company scoping (TC-4)', () => {
    test('missing companyId throws requireCompanyId; no query issued', async () => {
        await expect(tasksQueries.countTasks(null, { status: 'open' })).rejects.toThrow(/companyId is required/);
        expect(mockQuery).not.toHaveBeenCalled();
    });
});
