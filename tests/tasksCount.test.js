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
        expect(conditions.join(' ')).toContain('t.owner_user_id = $2');
        expect(conditions.join(' ')).toContain('t.author_user_id = $2');
        expect(conditions).toContain('t.status = $3');
        expect(params).toEqual([COMPANY, ME, 'open']);
    });

    test('present but missing scopeOwnerId adds an impossible predicate', () => {
        const { conditions, params } = tasksQueries.buildTaskListFilters(COMPANY, {
            status: 'open',
            scopeOwnerId: null,
        });
        expect(conditions).toContain('FALSE');
        expect(conditions).toContain('t.status = $2');
        expect(params).toEqual([COMPANY, 'open']);
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
        expect(conditions).toContain('t.due_at < $4::timestamptz');
        expect(params).toEqual([
            COMPANY,
            'open',
            '2026-01-01T00:00:00.000Z',
            '2027-01-01T00:00:00.000Z',
        ]);
    });

    test('$n numbering is stable regardless of caller (pure function of inputs)', () => {
        const a = tasksQueries.buildTaskListFilters(COMPANY, { status: 'open', scopeOwnerId: ME });
        const b = tasksQueries.buildTaskListFilters(COMPANY, { status: 'open', scopeOwnerId: ME });
        expect(a.conditions).toEqual(b.conditions);
        expect(a.params).toEqual(b.params);
    });

    test('active and snoozed filters partition at query time without changing due_at', () => {
        const active = tasksQueries.buildTaskListFilters(COMPANY, { snoozed: 'active' });
        const snoozed = tasksQueries.buildTaskListFilters(COMPANY, { snoozed: 'snoozed' });
        const all = tasksQueries.buildTaskListFilters(COMPANY, { snoozed: 'all' });

        expect(active.conditions).toContain('(t.snoozed_until IS NULL OR t.snoozed_until <= now())');
        expect(snoozed.conditions).toContain('t.snoozed_until > now()');
        expect(all.conditions.join(' ')).not.toContain('snoozed_until');
        expect(active.conditions.join(' ')).not.toContain('due_at');
        expect(snoozed.conditions.join(' ')).not.toContain('due_at');
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
        const filters = { status: 'open', scopeOwnerId: ME, snoozed: 'active' };

        mockQuery.mockResolvedValueOnce({ rows: [] });            // listTasks
        await tasksQueries.listTasks(COMPANY, filters);
        mockQuery.mockResolvedValueOnce({ rows: [{ count: 0 }] }); // countTasks
        await tasksQueries.countTasks(COMPANY, filters);

        const listWhere = whereClause(mockQuery.mock.calls[0][0]);
        const countWhere = whereClause(mockQuery.mock.calls[1][0]);

        // The full predicate is identical — same source builder, no drift.
        expect(countWhere).toBe(listWhere);
        expect(listWhere).toBe(
            "t.company_id = $1 AND " + HAS_ENTITY_PARENT
            + " AND (\n                t.owner_user_id = $2\n"
            + "                OR t.author_user_id = $2\n"
            + "            ) AND t.status = $3"
            + " AND (t.snoozed_until IS NULL OR t.snoozed_until <= now())"
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
        expect(countSql).toContain('(t.snoozed_until IS NULL OR t.snoozed_until <= now())');
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
        expect(sql).toContain('t.author_user_id = $2');
        expect(sql).toContain('(t.snoozed_until IS NULL OR t.snoozed_until <= now())');
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

    test('future snoozes are excluded and elapsed snoozes are re-included by now()', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ count: 2 }] });
        expect(await tasksQueries.countTasks(COMPANY, { status: 'open', snoozed: 'all' })).toBe(2);

        const [sql] = mockQuery.mock.calls[0];
        expect(sql).toContain('(t.snoozed_until IS NULL OR t.snoozed_until <= now())');
        expect(sql).not.toContain('t.snoozed_until > now()');
    });
});

describe('snoozeTask — deadline separation', () => {
    test('sets snoozed_until while leaving due_at unchanged', async () => {
        const dueAt = '2026-08-14T21:00:00.000Z';
        const snoozedUntil = '2026-08-15T13:00:00.000Z';
        mockQuery
            .mockResolvedValueOnce({ rows: [{ id: 41 }] })
            .mockResolvedValueOnce({ rows: [{ id: 41, due_at: dueAt, snoozed_until: snoozedUntil }] });

        const task = await tasksQueries.snoozeTask(COMPANY, 41, snoozedUntil);

        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toContain('UPDATE tasks SET snoozed_until = $3::timestamptz');
        expect(sql).toContain('WHERE company_id = $1 AND id = $2');
        expect(sql).not.toMatch(/SET[\s\S]*due_at/);
        expect(params).toEqual([COMPANY, 41, snoozedUntil]);
        expect(task).toMatchObject({ due_at: dueAt, snoozed_until: snoozedUntil });
    });

    test('null clears snoozed_until without changing due_at', async () => {
        const dueAt = '2026-08-14T21:00:00.000Z';
        mockQuery
            .mockResolvedValueOnce({ rows: [{ id: 41 }] })
            .mockResolvedValueOnce({ rows: [{ id: 41, due_at: dueAt, snoozed_until: null }] });

        const task = await tasksQueries.snoozeTask(COMPANY, 41, null);

        expect(mockQuery.mock.calls[0][1]).toEqual([COMPANY, 41, null]);
        expect(task).toMatchObject({ due_at: dueAt, snoozed_until: null });
    });
});

describe('listTasksPage — snooze partition and ordering', () => {
    test('snoozed rows carry snoozed_until and can sort by their wake time', async () => {
        const wakeAt = '2026-08-15T13:00:00.000Z';
        mockQuery
            .mockResolvedValueOnce({ rows: [{ total: 1 }] })
            .mockResolvedValueOnce({
                rows: [{
                    id: 51,
                    due_at: '2026-08-14T21:00:00.000Z',
                    snoozed_until: wakeAt,
                    created_at: '2026-08-13T12:00:00.000Z',
                    __cursor_null: false,
                    __cursor_value: wakeAt,
                    __cursor_created: '2026-08-13T12:00:00.000Z',
                    __cursor_id: '51',
                }],
            });

        const page = await tasksQueries.listTasksPage(COMPANY, {
            snoozed: 'snoozed',
            sort_by: 'snoozed_until',
        });

        expect(page.tasks).toEqual([expect.objectContaining({ id: 51, snoozed_until: wakeAt })]);
        expect(page.tasks[0]).not.toHaveProperty('__cursor_value');
        for (const [sql] of mockQuery.mock.calls) {
            expect(sql).toContain('t.snoozed_until > now()');
        }
        const dataSql = mockQuery.mock.calls[1][0];
        expect(dataSql).toMatch(/SELECT t\.id,[\s\S]*t\.due_at,\s+t\.snoozed_until,/);
        expect(dataSql).toContain('(page_base.snoozed_until IS NULL) ASC');
        expect(dataSql).toContain('page_base.snoozed_until ASC');
    });

    test('active uses the complementary query-time predicate', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ total: 0 }] })
            .mockResolvedValueOnce({ rows: [] });

        await tasksQueries.listTasksPage(COMPANY, { snoozed: 'active' });

        for (const [sql] of mockQuery.mock.calls) {
            expect(sql).toContain('(t.snoozed_until IS NULL OR t.snoozed_until <= now())');
            expect(sql).not.toContain('t.snoozed_until > now()');
        }
    });
});

describe('countTasks — company scoping (TC-4)', () => {
    test('missing companyId throws requireCompanyId; no query issued', async () => {
        await expect(tasksQueries.countTasks(null, { status: 'open' })).rejects.toThrow(/companyId is required/);
        expect(mockQuery).not.toHaveBeenCalled();
    });
});
