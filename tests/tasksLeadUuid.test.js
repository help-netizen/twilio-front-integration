'use strict';

/**
 * TASKS-LEAD-UUID-001 — leads are addressed app-wide by their VARCHAR `uuid`
 * (e.g. "0NMHI5"), but tasks.lead_id is a BIGINT FK → leads.id. Creating/listing
 * a task on a lead sent the uuid straight into the numeric column →
 * "invalid input syntax for type bigint: 0NMHI5" (prod "Failed to create the task").
 * tasksQueries now resolves the uuid → numeric leads.id.
 */

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: (...args) => mockQuery(...args), pool: {} }));

const q = require('../backend/src/db/tasksQueries');
const CO = 'company-1';

beforeEach(() => jest.clearAllMocks());

describe('tasksQueries lead uuid → numeric id resolution', () => {
    test('resolveParentId maps a lead uuid to the numeric leads.id (uuid-first)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 42 }] });
        const id = await q.resolveParentId(CO, 'lead', '0NMHI5');
        expect(id).toBe(42);
        expect(mockQuery).toHaveBeenCalledTimes(1);
        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toMatch(/WHERE uuid = \$1/);
        expect(params).toEqual(['0NMHI5', CO]);
    });

    test('resolveParentId passes non-lead parents through without a query', async () => {
        const id = await q.resolveParentId(CO, 'job', 7);
        expect(id).toBe(7);
        expect(mockQuery).not.toHaveBeenCalled();
    });

    test('resolveParentId returns null for an unknown lead uuid', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });
        expect(await q.resolveParentId(CO, 'lead', 'NOPE12')).toBeNull();
    });

    test('resolveParentId falls back to a numeric id when the uuid misses', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [] })            // uuid miss
            .mockResolvedValueOnce({ rows: [{ id: 99 }] }); // numeric id hit
        expect(await q.resolveParentId(CO, 'lead', '99')).toBe(99);
        expect(mockQuery.mock.calls[1][0]).toMatch(/WHERE id = \$1/);
        expect(mockQuery.mock.calls[1][1]).toEqual([99, CO]);
    });

    test('parentExists(lead, uuid) is true only when the lead resolves', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 42 }] });
        expect(await q.parentExists(CO, 'lead', '0NMHI5')).toBe(true);
        mockQuery.mockResolvedValueOnce({ rows: [] });
        expect(await q.parentExists(CO, 'lead', 'GONE99')).toBe(false);
    });

    test('createTask stores the NUMERIC leads.id, never the uuid (the bug)', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ id: 42 }] })                  // resolve uuid→id
            .mockResolvedValueOnce({ rows: [{ id: 900 }] })                 // INSERT ... RETURNING id
            .mockResolvedValueOnce({ rows: [{ id: 900, lead_id: 42 }] });   // getTaskById
        await q.createTask(CO, { parentType: 'lead', parentId: '0NMHI5', description: 'Call back' });
        const insert = mockQuery.mock.calls.find(([sql]) => /INSERT INTO tasks/.test(sql));
        expect(insert).toBeTruthy();
        expect(insert[1]).toContain(42);          // numeric lead_id stored
        expect(insert[1]).not.toContain('0NMHI5'); // never the raw uuid
    });

    test('listEntityTasks(lead, uuid) queries by the numeric lead_id', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ id: 42 }] })  // resolve
            .mockResolvedValueOnce({ rows: [] });           // the list query
        await q.listEntityTasks(CO, { parentType: 'lead', parentId: '0NMHI5' });
        const listCall = mockQuery.mock.calls.find(([sql]) => /t\.lead_id = \$2/.test(sql));
        expect(listCall).toBeTruthy();
        expect(listCall[1]).toEqual([CO, 42]);
    });

    test('listEntityTasks returns [] for an unknown lead uuid (no bigint cast)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] }); // resolve miss
        expect(await q.listEntityTasks(CO, { parentType: 'lead', parentId: 'GONE99' })).toEqual([]);
    });
});
