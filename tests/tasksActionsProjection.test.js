/**
 * OUTBOUND-PARTS-CALL-BTN-001 — read-projection tests (BTN-01 + BTN-02).
 *
 * The typed task-action backend (registry + execute route + `tasks.actions` jsonb,
 * mig 157) already shipped, but the READ projection never returned `actions`, so
 * TaskCard's `task.actions?.length` guard was always false and the buttons rendered
 * nowhere. These two slices are the data-plumbing fix:
 *
 *   BTN-01  backend/src/db/tasksQueries.js — SELECT_TASK now projects `t.actions`,
 *           so getTaskById / listEntityTasks / listTasks (+ the createTask return
 *           which re-reads via getTaskById) carry it. Asserted on the SQL string the
 *           mocked db.query receives + the row passthrough.
 *   BTN-02  backend/src/routes/calls.js — the Pulse by-contact `open_task` object
 *           maps `open_task_actions` → `actions` (`|| null`). Asserted through the
 *           real route over a mocked getUnifiedTimelinePage row.
 *
 * Scope honesty (LIST-PAGINATION-001 lesson): the db/query facade is MOCKED, so
 * these prove the PROJECTION + MAPPING shape and company scoping — NOT that Postgres
 * actually returns the jsonb column.
 */

'use strict';

// ── BTN-01: real tasksQueries over a mocked db connection ─────────────────────
const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));

// ── BTN-02: mock the query facade + the enrichment seams the calls route pulls ─
const mockGetUnifiedTimelinePage = jest.fn();
jest.mock('../backend/src/db/queries', () => ({
    getUnifiedTimelinePage: (...a) => mockGetUnifiedTimelinePage(...a),
}));
jest.mock('../backend/src/services/leadsService', () => ({
    getLeadsByPhones: jest.fn(async () => ({})),
}));
jest.mock('../backend/src/services/mailAgentService', () => ({
    getMutedSenderSet: jest.fn(async () => ({ emails: [], domains: [] })),
}));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));

const http = require('http');
const express = require('express');
const tasksQueries = require('../backend/src/db/tasksQueries');

const CO = '00000000-0000-0000-0000-000000000001';

const ROBOT = { type: 'robot_call', label: '🤖 Let the robot call' };
const MANUAL = { type: 'manual_call', label: "📞 I'll call myself" };

// ══ BTN-01 ═══════════════════════════════════════════════════════════════════
describe('BTN-01: SELECT_TASK projects t.actions (getTaskById / listEntityTasks)', () => {
    beforeEach(() => mockQuery.mockReset());

    test('getTaskById — SQL includes `t.actions`, company-scoped params, row.actions untouched', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 5, company_id: CO, actions: [ROBOT, MANUAL] }] });

        const out = await tasksQueries.getTaskById(CO, 5);

        const [sql, params] = mockQuery.mock.calls[0];
        // THE bug fix: the projection must select t.actions (revert → this fails RED).
        expect(sql).toMatch(/t\.actions/);
        // Still company-scoped ($1 company, $2 id) — isolation unchanged.
        expect(params).toEqual([CO, 5]);
        // The jsonb array is passed through verbatim (the DB layer does NOT re-map it).
        expect(out.actions).toEqual([ROBOT, MANUAL]);
    });

    test('getTaskById — a task with no actions passes through as null (not dropped/renamed)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 6, company_id: CO, actions: null }] });
        const out = await tasksQueries.getTaskById(CO, 6);
        expect(out.actions).toBeNull();
    });

    test('listEntityTasks(job) — SQL includes `t.actions`, company-scoped, per-row actions untouched', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [
                { id: 5, actions: [ROBOT, MANUAL] },
                { id: 6, actions: null },
            ],
        });

        const rows = await tasksQueries.listEntityTasks(CO, { parentType: 'job', parentId: 50 });

        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toMatch(/t\.actions/);
        expect(params[0]).toBe(CO);   // company scope ($1)
        expect(params[1]).toBe(50);   // parent id ($2)
        expect(rows[0].actions).toEqual([ROBOT, MANUAL]);
        expect(rows[1].actions).toBeNull();
    });
});

// ══ BTN-02 ═══════════════════════════════════════════════════════════════════
function request(app, path) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const req = http.request({
                hostname: '127.0.0.1', port: server.address().port, path, method: 'GET',
                headers: { 'Content-Type': 'application/json' },
            }, (res) => {
                let data = '';
                res.on('data', c => (data += c));
                res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); });
            });
            req.on('error', e => { server.close(); reject(e); });
            req.end();
        });
    });
}

function callsApp({ permissions = ['pulse.view'], company = CO } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'kc-sub', email: 'p@x.com', crmUser: { id: 'u1' } };
        req.authz = { scope: 'tenant', permissions, scopes: {}, membership: { role_key: 'manager' } };
        if (company) req.companyFilter = { company_id: company };
        next();
    });
    app.use('/api/calls', require('../backend/src/routes/calls'));
    return app;
}

// Minimal by-contact row (as getUnifiedTimelinePage returns) carrying an open task.
function taskRow(over = {}) {
    return {
        id: 1, call_sid: 'CA1', parent_call_sid: null, direction: 'inbound',
        from_number: '+15085551000', to_number: '+15085550000',
        status: 'completed', is_final: true,
        started_at: '2026-07-08T10:00:00Z', answered_at: null, ended_at: null, duration_sec: 30,
        created_at: '2026-07-08T10:00:00Z', updated_at: '2026-07-08T10:00:00Z',
        contact: { id: 1001, phone_e164: '+15085551000', full_name: 'C1' },
        tl_id: 1, timeline_id: 1, tl_has_unread: false, tl_phone: '+15085551000',
        is_action_required: false, action_required_reason: null, action_required_set_at: null,
        snoozed_until: null, owner_user_id: null, contact_has_unread: false,
        sms_last_message_at: null, sms_last_message_direction: null, sms_has_unread: false,
        sms_conversation_id: null, email_thread_id: null, email_subject: null,
        email_last_message_at: null, email_last_message_direction: null, email_unread_count: 0,
        any_unread: false, total_count: 1,
        // open task present (a part_arrived_call typed-action task on the timeline).
        open_task_id: 900, open_task_title: 'Part arrived — schedule completion visit',
        open_task_description: null, open_task_due_at: null, open_task_priority: 'p2',
        open_task_kind: 'part_arrived_call', open_task_agent_output: null,
        open_task_count: 1,
        ...over,
    };
}

describe('BTN-02: Pulse by-contact open_task carries `actions`', () => {
    beforeEach(() => mockGetUnifiedTimelinePage.mockReset());

    test('open_task_actions array → open_task.actions equals it', async () => {
        mockGetUnifiedTimelinePage.mockResolvedValue([taskRow({ open_task_actions: [ROBOT, MANUAL] })]);
        const res = await request(callsApp(), '/api/calls/by-contact');
        expect(res.status).toBe(200);
        const conv = res.body.conversations[0];
        expect(conv.has_open_task).toBe(true);
        expect(conv.open_task.id).toBe(900);
        // THE mapping under test (revert → the actions key is gone → this fails RED).
        expect(conv.open_task.actions).toEqual([ROBOT, MANUAL]);
    });

    test('open_task_actions absent → open_task.actions is null (|| null default)', async () => {
        mockGetUnifiedTimelinePage.mockResolvedValue([taskRow()]); // no open_task_actions
        const res = await request(callsApp(), '/api/calls/by-contact');
        const conv = res.body.conversations[0];
        expect(conv.open_task).not.toBeNull();
        // present-but-null in the mapping; on revert the key is undefined → fails RED.
        expect(conv.open_task.actions).toBeNull();
    });
});
