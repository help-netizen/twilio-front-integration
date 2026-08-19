'use strict';

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));

const tasksQueries = require('../backend/src/db/tasksQueries');

const COMPANY = '00000000-0000-0000-0000-000000000001';
const ME = '00000000-0000-0000-0000-000000000002';

beforeEach(() => jest.clearAllMocks());

function facetCondition(filters) {
    const result = tasksQueries.buildTaskListFilters(COMPANY, filters);
    return {
        ...result,
        condition: result.conditions.at(-1),
    };
}

describe('TASKS-ASSIGNEE-FILTERS-001 — shared OR-union predicate', () => {
    test('role only supports repeatable/csv-normalized role keys and unassigned', () => {
        const { condition, params } = facetCondition({
            roleKeys: ['dispatcher', 'provider', 'unassigned'],
        });

        expect(condition).toContain('om_filter.user_id = t.owner_user_id');
        expect(condition).toContain('om_filter.company_id = t.company_id');
        expect(condition).toContain('om_filter.role_key = ANY($2::text[])');
        expect(condition).toContain('OR t.owner_user_id IS NULL');
        expect(params).toEqual([COMPANY, ['dispatcher', 'provider']]);
    });

    test('assignee only matches the selected owner ids', () => {
        const { condition, params } = facetCondition({ assigneeIds: ['u1', 'u2'] });
        expect(condition).toBe('(t.owner_user_id::text = ANY($2::text[]))');
        expect(params).toEqual([COMPANY, ['u1', 'u2']]);
    });

    test('author_mine only matches the caller as author', () => {
        const { condition, params } = facetCondition({ authorMineId: ME });
        expect(condition).toBe('(t.author_user_id = $2)');
        expect(params).toEqual([COMPANY, ME]);
    });

    test('assignee_mine only matches the caller as owner', () => {
        const { condition, params } = facetCondition({ assigneeMineId: ME });
        expect(condition).toBe('(t.owner_user_id = $2)');
        expect(params).toEqual([COMPANY, ME]);
    });

    test('all provided facets form one OR group, ANDed after provider content scope', () => {
        const { conditions, params } = tasksQueries.buildTaskListFilters(COMPANY, {
            scopeOwnerId: ME,
            status: 'open',
            roleKeys: ['manager', 'unassigned'],
            assigneeIds: ['u7'],
            authorMineId: ME,
            assigneeMineId: ME,
        });
        const sql = conditions.join(' AND ');
        const orGroup = conditions.at(-1);

        expect(conditions).toHaveLength(5);
        expect(conditions[3]).toBe('t.status = $3');
        expect(conditions[1]).not.toContain('om_filter');
        expect(sql).toContain('t.owner_user_id = $2');
        expect(sql).toContain('t.author_user_id = $2');
        expect(orGroup).toContain('om_filter.role_key = ANY($4::text[])');
        expect(orGroup).toContain('OR t.owner_user_id IS NULL');
        expect(orGroup).toContain('OR t.owner_user_id::text = ANY($5::text[])');
        expect(orGroup).toContain('OR t.author_user_id = $6');
        expect(orGroup).toContain('OR t.owner_user_id = $7');
        expect(params).toEqual([
            COMPANY,
            ME,
            'open',
            ['manager'],
            ['u7'],
            ME,
            ME,
        ]);
    });

    test('listTasks and countTasks consume the same facet predicate', async () => {
        const filters = {
            status: 'open',
            snoozed: 'active',
            roleKeys: ['provider'],
            assigneeIds: ['u8'],
            authorMineId: ME,
        };
        mockQuery.mockResolvedValueOnce({ rows: [] });
        await tasksQueries.listTasks(COMPANY, filters);
        mockQuery.mockResolvedValueOnce({ rows: [{ count: 0 }] });
        await tasksQueries.countTasks(COMPANY, filters);

        const listWhere = mockQuery.mock.calls[0][0].split(' WHERE ')[1].split(' ORDER BY ')[0];
        const countWhere = mockQuery.mock.calls[1][0].split(' WHERE ')[1];
        expect(countWhere.trim()).toBe(listWhere.trim());
        expect(mockQuery.mock.calls[1][1]).toEqual(mockQuery.mock.calls[0][1].slice(0, -2));
    });
});

describe('GET /facets query contract', () => {
    test('returns per-role/per-user/mine/total counts and includes future snoozes', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [
                { owner_user_id: 'admin', role_key: 'tenant_admin', task_count: 2, mine_author_count: 1, mine_assignee_count: 0 },
                { owner_user_id: 'manager', role_key: 'manager', task_count: 3, mine_author_count: 0, mine_assignee_count: 0 },
                { owner_user_id: 'dispatcher', role_key: 'dispatcher', task_count: 4, mine_author_count: 2, mine_assignee_count: 0 },
                { owner_user_id: ME, role_key: 'provider', task_count: 5, mine_author_count: 1, mine_assignee_count: 5 },
                { owner_user_id: null, role_key: null, task_count: 6, mine_author_count: 1, mine_assignee_count: 0 },
            ],
        });

        await expect(tasksQueries.getOpenTaskFacets(COMPANY, ME)).resolves.toEqual({
            byRole: {
                tenant_admin: 2,
                manager: 3,
                dispatcher: 4,
                provider: 5,
                unassigned: 6,
            },
            byUser: {
                admin: 2,
                manager: 3,
                dispatcher: 4,
                [ME]: 5,
            },
            mineAuthor: 5,
            mineAssignee: 5,
            total: 20,
        });

        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toContain('t.company_id = $1');
        expect(sql).toContain('t.status = $2');
        expect(sql).toContain('om.company_id = t.company_id');
        expect(sql).not.toContain('snoozed_until');
        expect(params).toEqual([COMPANY, 'open', ME]);
    });

    test('always includes every role and unassigned even when no tasks exist', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });
        await expect(tasksQueries.getOpenTaskFacets(COMPANY, ME)).resolves.toEqual({
            byRole: {
                tenant_admin: 0,
                manager: 0,
                dispatcher: 0,
                provider: 0,
                unassigned: 0,
            },
            byUser: {},
            mineAuthor: 0,
            mineAssignee: 0,
            total: 0,
        });
    });

    test('provider facets reuse the exact assigned-or-authored content predicate', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });
        await tasksQueries.getOpenTaskFacets(COMPANY, ME, { scopeOwnerId: ME });

        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toContain('t.owner_user_id = $2');
        expect(sql).toContain('t.author_user_id = $2');
        expect(sql).toContain('t.status = $3');
        expect(params).toEqual([COMPANY, ME, 'open', ME]);
    });
});

describe('GET /assignees query contract', () => {
    test('returns active tenant members with configured role label and title-case fallback', async () => {
        const users = [{
            id: 'u1',
            name: 'Ann',
            email: 'ann@example.test',
            role_key: 'tenant_admin',
            role_label: 'Owner',
        }];
        mockQuery.mockResolvedValueOnce({ rows: users });

        await expect(tasksQueries.listTaskAssignees(COMPANY)).resolves.toEqual(users);
        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toContain('WHERE m.company_id = $1');
        expect(sql).toContain("m.status = 'active'");
        expect(sql).toContain('rc.company_id = m.company_id');
        expect(sql).toContain('rc.role_key = m.role_key');
        expect(sql).toContain("INITCAP(REPLACE(m.role_key, '_', ' '))");
        expect(params).toEqual([COMPANY]);
    });
});
