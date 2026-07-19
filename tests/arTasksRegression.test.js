'use strict';

const mockDb = { query: jest.fn() };
const mockGetUnifiedTimelinePage = jest.fn();

jest.mock('../backend/src/db/connection', () => mockDb);
jest.mock('../backend/src/db/queries', () => ({
    getUnifiedTimelinePage: (...args) => mockGetUnifiedTimelinePage(...args),
}));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../backend/src/services/userService', () => ({ listUsers: jest.fn(async () => ({ users: [] })) }));
jest.mock('../backend/src/services/tasksService', () => ({ emitTaskChange: jest.fn() }));
jest.mock('../backend/src/services/leadsService', () => ({ getLeadsByPhones: jest.fn(async () => ({})) }));
jest.mock('../backend/src/services/mailAgentService', () => ({
    getMutedSenderSet: jest.fn(async () => ({ emails: [], domains: [] })),
}));

const express = require('express');
const request = require('supertest');
const callsRouter = require('../backend/src/routes/calls');
const tasksRouter = require('../backend/src/routes/tasks');

const COMPANY = '00000000-0000-0000-0000-000000000001';
const ME = '11111111-1111-1111-1111-111111111111';
const TIMELINE_ID = 77;

let tasks;
let timeline;

function app() {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
        req.user = { sub: 'never-use-sub', email: 'owner@example.com', crmUser: { id: ME } };
        req.authz = { scope: 'tenant', permissions: ['pulse.view', 'tasks.view', 'tasks.create', 'tasks.manage'] };
        req.companyFilter = { company_id: COMPANY };
        next();
    });
    instance.use('/api/calls', callsRouter);
    instance.use('/api/tasks', tasksRouter);
    return instance;
}

function taskRow(task) {
    return {
        ...task,
        description: task.title,
        assignee_name: 'Owner',
        assignee_email: 'owner@example.com',
        author_name: 'Owner',
        parent_type: 'timeline',
        parent_id: TIMELINE_ID,
    };
}

function conversationRow() {
    const open = tasks.filter(task => task.status === 'open').map(taskRow);
    return {
        id: null,
        call_sid: null,
        parent_call_sid: null,
        direction: null,
        from_number: null,
        to_number: null,
        status: null,
        is_final: true,
        started_at: null,
        answered_at: null,
        ended_at: null,
        duration_sec: null,
        created_at: '2026-07-19T12:00:00.000Z',
        updated_at: '2026-07-19T12:00:00.000Z',
        contact: { id: 501, phone_e164: '+15085550100', full_name: 'Two Tasks' },
        tl_id: TIMELINE_ID,
        timeline_id: TIMELINE_ID,
        tl_phone: '+15085550100',
        tl_has_unread: false,
        any_unread: false,
        is_action_required: timeline.is_action_required,
        action_required_reason: timeline.action_required_reason,
        action_required_set_at: '2026-07-19T12:00:00.000Z',
        snoozed_until: null,
        owner_user_id: ME,
        open_tasks: open,
        open_task_count: open.length,
        total_count: 1,
    };
}

beforeEach(() => {
    tasks = [
        {
            id: 101, company_id: COMPANY, thread_id: TIMELINE_ID,
            title: 'Confirm access', status: 'open', due_at: '2026-07-20T13:00:00.000Z',
            completed_at: null, created_at: '2026-07-19T10:00:00.000Z',
            owner_user_id: ME, author_user_id: ME,
        },
        {
            id: 102, company_id: COMPANY, thread_id: TIMELINE_ID,
            title: 'Send revised estimate', status: 'open', due_at: '2026-07-20T15:00:00.000Z',
            completed_at: null, created_at: '2026-07-19T11:00:00.000Z',
            owner_user_id: ME, author_user_id: ME,
        },
    ];
    timeline = { id: TIMELINE_ID, company_id: COMPANY, is_action_required: true, action_required_reason: 'manual' };

    mockDb.query.mockReset();
    mockDb.query.mockImplementation(async (sql, params) => {
        if (/UPDATE tasks SET/i.test(sql)) {
            const task = tasks.find(candidate => candidate.company_id === params[0] && candidate.id === Number(params[1]));
            if (!task) return { rows: [] };
            const status = params[2];
            task.status = status;
            task.completed_at = status === 'done' ? '2026-07-19T13:00:00.000Z' : null;
            return { rows: [{ id: task.id }] };
        }
        if (/UPDATE timelines tl SET/i.test(sql)) {
            const hasOpen = tasks.some(task => task.company_id === params[0]
                && task.thread_id === params[1] && task.status === 'open');
            if (!hasOpen) timeline.is_action_required = false;
            return { rowCount: hasOpen ? 0 : 1, rows: [] };
        }
        if (/FROM tasks t/i.test(sql) && /t\.company_id = \$1 AND t\.id = \$2/i.test(sql)) {
            const task = tasks.find(candidate => candidate.company_id === params[0] && candidate.id === Number(params[1]));
            return { rows: task ? [taskRow(task)] : [] };
        }
        throw new Error(`Unexpected SQL in AR regression: ${sql}`);
    });
    mockGetUnifiedTimelinePage.mockReset();
    mockGetUnifiedTimelinePage.mockImplementation(async () => [conversationRow()]);
});

test('OB-11: completing one of two thread tasks leaves the other open and Action Required set', async () => {
    const before = await request(app()).get('/api/calls/by-contact');
    expect(before.body.conversations[0].open_tasks.map(task => task.id)).toEqual([101, 102]);

    const completed = await request(app()).patch('/api/tasks/101').send({ status: 'done' });
    expect(completed.status).toBe(200);

    expect(tasks.find(task => task.id === 101).status).toBe('done');
    expect(tasks.find(task => task.id === 102).status).toBe('open');
    expect(timeline.is_action_required).toBe(true);

    const after = await request(app()).get('/api/calls/by-contact');
    const conversation = after.body.conversations[0];
    expect(conversation.open_tasks.map(task => task.id)).toEqual([102]);
    expect(conversation.has_open_task).toBe(true);
    expect(conversation.is_action_required).toBe(true);

    const taskUpdate = mockDb.query.mock.calls.find(([sql]) => /UPDATE tasks SET/i.test(sql));
    expect(taskUpdate[0]).toContain('WHERE company_id = $1 AND id = $2');
    expect(taskUpdate[1].slice(0, 2)).toEqual([COMPANY, '101']);
});

test('completing the final open task clears the legacy timeline flag', async () => {
    tasks[0].status = 'done';
    await request(app()).patch('/api/tasks/102').send({ status: 'done' });

    expect(tasks.every(task => task.status === 'done')).toBe(true);
    expect(timeline.is_action_required).toBe(false);
    const after = await request(app()).get('/api/calls/by-contact');
    expect(after.body.conversations[0].has_open_task).toBe(false);
    expect(after.body.conversations[0].open_tasks).toEqual([]);
});
