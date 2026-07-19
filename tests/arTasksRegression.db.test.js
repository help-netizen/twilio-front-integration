'use strict';

/**
 * AR-TASKS-001 — real-PostgreSQL regression for OB-11.
 *
 * The route-contract suite in arTasksRegression.test.js intentionally mocks the
 * connection. This companion suite executes the production SQL so restoring
 * markThreadHandled's former bulk task UPDATE cannot pass unnoticed.
 */

const { randomUUID } = require('crypto');
const express = require('express');
const request = require('supertest');

jest.mock('../backend/src/services/tasksService', () => ({ emitTaskChange: jest.fn() }));

const db = require('../backend/src/db/connection');
const timelinesQueries = require('../backend/src/db/timelinesQueries');
const tasksRouter = require('../backend/src/routes/tasks');

jest.setTimeout(30000);

const RUN_ID = `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
const ACTOR_ID = randomUUID();

let dbReady = false;
let skipReason = 'database unavailable';
let testClient = null;
const pooledQuery = db.query;

function taskApp(companyId) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = {
            sub: 'never-use-sub',
            email: 'ar-tasks-db@example.com',
            crmUser: { id: ACTOR_ID },
        };
        req.authz = {
            scope: 'tenant',
            permissions: ['tasks.view', 'tasks.manage'],
        };
        req.companyFilter = { company_id: companyId };
        next();
    });
    app.use('/api/tasks', tasksRouter);
    return app;
}

async function seedThreadWithTwoOpenTasks(label) {
    const timeline = await db.query(
        `INSERT INTO timelines
            (phone_e164, company_id, is_action_required, action_required_reason,
             action_required_set_at, action_required_set_by)
         VALUES ($1, $2, true, 'manual', now(), 'user')
         RETURNING id`,
        [`+ar-tasks-${RUN_ID}-${label}`, COMPANY_A]
    );
    const timelineId = timeline.rows[0].id;
    const inserted = await db.query(
        `INSERT INTO tasks (company_id, thread_id, title, status, due_at)
         VALUES
            ($1, $2, $3, 'open', now() + interval '1 hour'),
            ($1, $2, $4, 'open', now() + interval '2 hours')
         RETURNING id`,
        [COMPANY_A, timelineId, `${label} first`, `${label} second`]
    );
    const taskIds = inserted.rows.map(row => row.id).sort((left, right) => {
        if (BigInt(left) === BigInt(right)) return 0;
        return BigInt(left) < BigInt(right) ? -1 : 1;
    });
    return { timelineId, taskIds };
}

async function readState(timelineId) {
    const [tasks, timeline] = await Promise.all([
        db.query(
            `SELECT id, status
             FROM tasks
             WHERE company_id = $1 AND thread_id = $2
             ORDER BY id`,
            [COMPANY_A, timelineId]
        ),
        db.query(
            `SELECT is_action_required
             FROM timelines
             WHERE company_id = $1 AND id = $2`,
            [COMPANY_A, timelineId]
        ),
    ]);
    return {
        taskStatuses: tasks.rows.map(row => row.status),
        timelineActionRequired: timeline.rows[0]?.is_action_required,
    };
}

beforeAll(async () => {
    testClient = await db.pool.connect().catch(error => {
        skipReason = error.message;
        return null;
    });
    if (!testClient) return;

    try {
        await testClient.query('BEGIN');
        // Migration 139 removed this v1 index. The transaction-local DROP lets
        // the regression run on a developer database that has not applied 139;
        // ROLLBACK restores that stale schema and all fixtures after the suite.
        await testClient.query('DROP INDEX IF EXISTS uq_tasks_one_open_per_thread');
        db.query = (text, params) => testClient.query(text, params);
        await db.query(
            `INSERT INTO companies (id, name, slug)
             VALUES ($1, $2, $3), ($4, $5, $6)`,
            [
                COMPANY_A, 'AR Tasks DB Company A', `ar-tasks-a-${RUN_ID}`,
                COMPANY_B, 'AR Tasks DB Company B', `ar-tasks-b-${RUN_ID}`,
            ]
        );
        dbReady = true;
    } catch (error) {
        skipReason = error.message;
    }
});

afterAll(async () => {
    if (testClient) {
        try {
            await testClient.query('ROLLBACK');
        } catch (error) {
            console.warn('[arTasksRegression.db] rollback failed:', error.message);
        } finally {
            db.query = pooledQuery;
            testClient.release();
        }
    }
    try { await db.pool.end(); } catch (_) { /* ignore */ }
});

describe('AR-TASKS-001 — markThreadHandled and per-task completion (real PostgreSQL)', () => {
    test('OB-11: thread handling cannot bulk-close two open tasks; task completion clears AR only after the last task', async () => {
        if (!dbReady) return console.warn(`[arTasksRegression.db] SKIPPED-NEEDS-DB — ${skipReason}`);

        const { timelineId, taskIds } = await seedThreadWithTwoOpenTasks('ob11');

        const handled = await timelinesQueries.markThreadHandled(timelineId, COMPANY_A);
        const afterThreadHandle = await readState(timelineId);
        expect({
            returnedNull: handled === null,
            ...afterThreadHandle,
        }).toEqual({
            returnedNull: true,
            taskStatuses: ['open', 'open'],
            timelineActionRequired: true,
        });

        const firstCompletion = await request(taskApp(COMPANY_A))
            .patch(`/api/tasks/${taskIds[0]}`)
            .send({ status: 'done' });
        expect({
            responseStatus: firstCompletion.status,
            ...await readState(timelineId),
        }).toEqual({
            responseStatus: 200,
            taskStatuses: ['done', 'open'],
            timelineActionRequired: true,
        });

        const finalCompletion = await request(taskApp(COMPANY_A))
            .patch(`/api/tasks/${taskIds[1]}`)
            .send({ status: 'done' });
        expect({
            responseStatus: finalCompletion.status,
            ...await readState(timelineId),
        }).toEqual({
            responseStatus: 200,
            taskStatuses: ['done', 'done'],
            timelineActionRequired: false,
        });
    });

    test('T-foreign: markThreadHandled with another company cannot touch the timeline or its tasks', async () => {
        if (!dbReady) return console.warn(`[arTasksRegression.db] SKIPPED-NEEDS-DB — ${skipReason}`);

        const { timelineId } = await seedThreadWithTwoOpenTasks('foreign');
        const handled = await timelinesQueries.markThreadHandled(timelineId, COMPANY_B);

        expect({
            returnedNull: handled === null,
            ...await readState(timelineId),
        }).toEqual({
            returnedNull: true,
            taskStatuses: ['open', 'open'],
            timelineActionRequired: true,
        });
    });
});
