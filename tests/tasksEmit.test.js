/**
 * TASKS-COUNT-BADGE-001-T2 — `task.changed` SSE emit.
 *
 * DB + realtimeService are mocked; the query layer / route handlers run for real
 * against the mocked db.query. Covers the emit sites and their guards:
 *   - emitTaskChange payload is EXACTLY { company_id } (PII-free), best-effort,
 *     early-returns on a missing companyId (TC-12 / TC-37 / TC-38).
 *   - routes: POST create emits; PATCH emits ONLY on status|owner (not due/desc);
 *     DELETE emits (TC-19 / TC-20 / TC-21).
 *   - timelinesQueries.createTask: fresh INSERT emits for user|agent, NOT for
 *     system/automation, and the AUTO-upsert-UPDATE branch never emits (TC-22).
 */

const express = require('express');
const request = require('supertest');

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));
jest.mock('../backend/src/services/realtimeService', () => ({ broadcast: jest.fn() }));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../backend/src/services/userService', () => ({ listUsers: jest.fn() }));

const realtimeService = require('../backend/src/services/realtimeService');
const tasksService = require('../backend/src/services/tasksService');
const tasksRouter = require('../backend/src/routes/tasks');
const timelinesQueries = require('../backend/src/db/timelinesQueries');

const COMPANY = '00000000-0000-0000-0000-000000000001';
const ME = 'crm-me';

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

// ── emitTaskChange — payload shape + best-effort (TC-12 / TC-37 / TC-38) ──────
describe('emitTaskChange', () => {
    test('broadcasts task.changed with EXACTLY { company_id } — no PII (TC-12)', () => {
        tasksService.emitTaskChange(COMPANY);
        expect(realtimeService.broadcast).toHaveBeenCalledTimes(1);
        const [eventType, payload] = realtimeService.broadcast.mock.calls[0];
        expect(eventType).toBe('task.changed');
        expect(payload).toEqual({ company_id: COMPANY });
        // The only key is company_id — no owner/status/id/PII leaks the global channel.
        expect(Object.keys(payload)).toEqual(['company_id']);
        expect(payload).not.toHaveProperty('owner_user_id');
        expect(payload).not.toHaveProperty('status');
        expect(payload).not.toHaveProperty('id');
    });

    test('emitTaskChange(null) → early return, no broadcast (TC-38)', () => {
        tasksService.emitTaskChange(null);
        tasksService.emitTaskChange(undefined);
        tasksService.emitTaskChange('');
        expect(realtimeService.broadcast).not.toHaveBeenCalled();
    });

    test('a broadcast throw is swallowed — never propagates (TC-37 best-effort)', () => {
        realtimeService.broadcast.mockImplementationOnce(() => { throw new Error('SSE down'); });
        expect(() => tasksService.emitTaskChange(COMPANY)).not.toThrow();
    });
});

// ── routes: POST / PATCH / DELETE emit sites (TC-19 / TC-20 / TC-21) ──────────
describe('POST / — emits once after create (TC-20)', () => {
    test('successful create → one task.changed { company_id }', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ 1: 1 }] });   // parentExists
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 10 }] });  // INSERT RETURNING id
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 10, status: 'open', owner_user_id: ME, author_user_id: ME, parent_type: 'job', parent_id: 5 }] }); // getTaskById

        const res = await request(makeApp()).post('/api/tasks')
            .send({ parent_type: 'job', parent_id: 5, description: 'Call client' });

        expect(res.status).toBe(201);
        expect(realtimeService.broadcast).toHaveBeenCalledTimes(1);
        expect(realtimeService.broadcast.mock.calls[0][0]).toBe('task.changed');
        expect(realtimeService.broadcast.mock.calls[0][1]).toEqual({ company_id: COMPANY });
    });

    test('a validation 400 (before create) does NOT emit', async () => {
        const res = await request(makeApp()).post('/api/tasks').send({ description: 'x' });
        expect(res.status).toBe(400);
        expect(realtimeService.broadcast).not.toHaveBeenCalled();
    });

    test('a broadcast throw does not break the create (TC-37) — still 201', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ 1: 1 }] });
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 11 }] });
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 11, status: 'open', owner_user_id: ME, author_user_id: ME, parent_type: 'job', parent_id: 5 }] });
        realtimeService.broadcast.mockImplementationOnce(() => { throw new Error('SSE down'); });

        const res = await request(makeApp()).post('/api/tasks')
            .send({ parent_type: 'job', parent_id: 5, description: 'Call client' });
        expect(res.status).toBe(201);
    });
});

describe('PATCH /:id — emits only on status|owner (TC-19)', () => {
    // getTaskById (auth) → updateTask RETURNING id → getTaskById (return) : 3 queries.
    function primePatch(existing = { id: 7, owner_user_id: ME, author_user_id: ME, status: 'open' }) {
        mockQuery.mockResolvedValueOnce({ rows: [existing] });       // getTaskById (canActOn)
        mockQuery.mockResolvedValueOnce({ rows: [{ id: existing.id }] }); // updateTask RETURNING id
        mockQuery.mockResolvedValueOnce({ rows: [{ id: existing.id }] }); // getTaskById (response)
    }

    test('status change → emits once', async () => {
        primePatch();
        const res = await request(makeApp()).patch('/api/tasks/7').send({ status: 'done' });
        expect(res.status).toBe(200);
        expect(realtimeService.broadcast).toHaveBeenCalledTimes(1);
        expect(realtimeService.broadcast.mock.calls[0][0]).toBe('task.changed');
    });

    test('owner_user_id change → emits once', async () => {
        primePatch();
        const res = await request(makeApp()).patch('/api/tasks/7').send({ owner_user_id: 'crm-other' });
        expect(res.status).toBe(200);
        expect(realtimeService.broadcast).toHaveBeenCalledTimes(1);
    });

    test('status AND owner in one patch → emits exactly ONCE (no double-emit)', async () => {
        primePatch();
        const res = await request(makeApp()).patch('/api/tasks/7').send({ status: 'open', owner_user_id: 'crm-other' });
        expect(res.status).toBe(200);
        expect(realtimeService.broadcast).toHaveBeenCalledTimes(1);
    });

    test('due_at-only patch → NO emit (S7)', async () => {
        primePatch();
        const res = await request(makeApp()).patch('/api/tasks/7').send({ due_at: '2026-09-01T00:00:00Z' });
        expect(res.status).toBe(200);
        expect(realtimeService.broadcast).not.toHaveBeenCalled();
    });

    test('description-only patch → NO emit (S7)', async () => {
        primePatch();
        const res = await request(makeApp()).patch('/api/tasks/7').send({ description: 'reworded' });
        expect(res.status).toBe(200);
        expect(realtimeService.broadcast).not.toHaveBeenCalled();
    });

    test('403 (not owner/author) → NO emit', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 7, owner_user_id: 'crm-other', author_user_id: 'crm-other', status: 'open' }] });
        const res = await request(makeApp({ permissions: ['tasks.view', 'tasks.create'] }))
            .patch('/api/tasks/7').send({ status: 'done' });
        expect(res.status).toBe(403);
        expect(realtimeService.broadcast).not.toHaveBeenCalled();
    });
});

describe('DELETE /:id — emits once (TC-21)', () => {
    test('successful delete → one task.changed { company_id }', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 9, owner_user_id: ME, author_user_id: ME }] }); // getTaskById
        mockQuery.mockResolvedValueOnce({ rowCount: 1 });                                                // deleteTask
        const res = await request(makeApp()).delete('/api/tasks/9');
        expect(res.status).toBe(200);
        expect(realtimeService.broadcast).toHaveBeenCalledTimes(1);
        expect(realtimeService.broadcast.mock.calls[0][0]).toBe('task.changed');
        expect(realtimeService.broadcast.mock.calls[0][1]).toEqual({ company_id: COMPANY });
    });

    test('404 (unknown id) → NO emit', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });
        const res = await request(makeApp()).delete('/api/tasks/55');
        expect(res.status).toBe(404);
        expect(realtimeService.broadcast).not.toHaveBeenCalled();
    });
});

// ── timelinesQueries.createTask — provenance guard at the INSERT site (TC-22) ─
describe('timelinesQueries.createTask — INSERT-branch emit guard (TC-22)', () => {
    test('fresh INSERT with provenance=user (default) → emits', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 't1' }] }); // INSERT RETURNING *
        await timelinesQueries.createTask({ companyId: COMPANY, threadId: 'th', title: 'x' }); // createdBy omitted → 'user'
        expect(realtimeService.broadcast).toHaveBeenCalledTimes(1);
        expect(realtimeService.broadcast.mock.calls[0][0]).toBe('task.changed');
        expect(realtimeService.broadcast.mock.calls[0][1]).toEqual({ company_id: COMPANY });
    });

    test('fresh INSERT with provenance=agent → emits (MAIL-AGENT-001 / HAS_ENTITY_PARENT)', async () => {
        // AUTO branch first probes for an existing open task; none → falls through to INSERT.
        mockQuery.mockResolvedValueOnce({ rows: [] });             // AUTO existing-open probe → none
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 't2' }] }); // INSERT RETURNING *
        await timelinesQueries.createTask({ companyId: COMPANY, threadId: 'th', title: 'x', createdBy: 'agent' });
        expect(realtimeService.broadcast).toHaveBeenCalledTimes(1);
        expect(realtimeService.broadcast.mock.calls[0][0]).toBe('task.changed');
    });

    test('fresh INSERT with provenance=system → NO emit (Pulse-only, count-excluded)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });             // AUTO existing-open probe → none
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 't3' }] }); // INSERT RETURNING *
        await timelinesQueries.createTask({ companyId: COMPANY, threadId: 'th', title: 'x', createdBy: 'system' });
        expect(realtimeService.broadcast).not.toHaveBeenCalled();
    });

    test('fresh INSERT with provenance=automation → NO emit', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });             // AUTO existing-open probe → none
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 't4' }] }); // INSERT RETURNING *
        await timelinesQueries.createTask({ companyId: COMPANY, threadId: 'th', title: 'x', createdBy: 'automation' });
        expect(realtimeService.broadcast).not.toHaveBeenCalled();
    });

    test('AUTO-upsert UPDATE branch (existing open task) → NO emit even for agent', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 'existing' }] }); // AUTO existing-open probe → found
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 'existing' }] }); // UPDATE RETURNING *
        await timelinesQueries.createTask({ companyId: COMPANY, threadId: 'th', title: 'x', createdBy: 'agent' });
        expect(realtimeService.broadcast).not.toHaveBeenCalled();
    });
});
