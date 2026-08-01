'use strict';

const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const eventBus = require('../backend/src/services/eventBus');
const taskNotificationQueries = require('../backend/src/db/taskNotificationQueries');

jest.setTimeout(30000);

describe('typed notification producer PostgreSQL isolation', () => {
    test('T-own/T-foreign/T-blast and tenant-paired producer idempotency', async () => {
        const client = await db.pool.connect();
        const companyA = randomUUID();
        const companyB = randomUUID();
        const sharedKey = `producer-t4-${randomUUID()}`;
        try {
            await client.query('BEGIN');
            await client.query(
                `INSERT INTO companies (id, name, slug, status, timezone)
                 VALUES ($1, 'Producer A', $2, 'active', 'America/New_York'),
                        ($3, 'Producer B', $4, 'active', 'America/Los_Angeles')`,
                [companyA, `producer-a-${companyA}`, companyB, `producer-b-${companyB}`]
            );
            const tasks = await client.query(
                `INSERT INTO tasks (company_id, title, status, created_by, due_at)
                 VALUES ($1, 'A task', 'open', 'system', $3),
                        ($2, 'B task', 'open', 'system', $3),
                        ($1, 'A overdue restart task', 'open', 'system', $4)
                 RETURNING id, company_id`,
                [
                    companyA,
                    companyB,
                    '2026-08-01T16:00:00.000Z',
                    '2026-07-31T16:00:00.000Z',
                ]
            );
            const taskA = tasks.rows[0];
            const overdueTaskA = tasks.rows[2];

            const candidatesA = await taskNotificationQueries.listTaskBoundaryCandidates(
                companyA,
                'America/New_York',
                new Date('2026-08-01T12:00:00.000Z'),
                250,
                client
            );
            expect(candidatesA.map(row => row.company_id)).toEqual([companyA, companyA]);
            expect(candidatesA).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: taskA.id, boundary: 'due' }),
                expect.objectContaining({ id: overdueTaskA.id, boundary: 'overdue' }),
            ]));

            const firstA = await eventBus.emit(companyA, 'task.due', {
                task_id: taskA.id,
                record_refs: [{ type: 'task', id: taskA.id }],
            }, {
                aggregateType: 'task', aggregateId: taskA.id, idempotencyKey: sharedKey, client,
            });
            const duplicateA = await eventBus.emit(companyA, 'task.due', {
                task_id: taskA.id,
                record_refs: [{ type: 'task', id: taskA.id }],
            }, {
                aggregateType: 'task', aggregateId: taskA.id, idempotencyKey: sharedKey, client,
            });
            const firstB = await eventBus.emit(companyB, 'task.due', {
                task_id: tasks.rows.find(row => row.company_id === companyB).id,
                record_refs: [{ type: 'task', id: tasks.rows.find(row => row.company_id === companyB).id }],
            }, {
                aggregateType: 'task',
                aggregateId: tasks.rows.find(row => row.company_id === companyB).id,
                idempotencyKey: sharedKey,
                client,
            });

            expect(firstA).toBeTruthy();
            expect(duplicateA).toBeNull();
            expect(firstB).toBeTruthy();
            const counts = await client.query(
                `SELECT company_id, count(*)::int AS count
                 FROM domain_events
                 WHERE company_id = ANY($1::uuid[]) AND idempotency_key = $2
                 GROUP BY company_id`,
                [[companyA, companyB], sharedKey]
            );
            expect(new Map(counts.rows.map(row => [row.company_id, row.count]))).toEqual(
                new Map([[companyA, 1], [companyB, 1]])
            );
            expect(JSON.stringify(firstA.event_data)).not.toMatch(/body|amount|phone|address|summary/i);
        } finally {
            await client.query('ROLLBACK');
            client.release();
        }
    });
});

afterAll(async () => {
    try { await db.pool.end(); } catch { /* already closed */ }
});
