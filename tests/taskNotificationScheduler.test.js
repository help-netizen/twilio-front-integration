'use strict';

const {
    createTaskNotificationScheduler,
    idempotencyKey,
} = require('../backend/src/services/taskNotificationScheduler');

const COMPANY_A = '00000000-0000-4000-8000-00000000a001';
const COMPANY_B = '00000000-0000-4000-8000-00000000b001';

describe('task due/overdue notification scheduler', () => {
    test('SAB-M1-T4-DUE-DEDUPE: company, task, boundary, timezone and local window form the key', () => {
        const task = {
            company_id: COMPANY_A,
            id: 42,
            boundary: 'due',
            local_due_date: '2026-08-01',
        };
        expect(idempotencyKey(task, 'America/New_York')).toBe(
            `task.due:${COMPANY_A}:42:America/New_York:2026-08-01`
        );
        expect(idempotencyKey({ ...task, company_id: COMPANY_B }, 'America/New_York'))
            .not.toBe(idempotencyKey(task, 'America/New_York'));
        expect(idempotencyKey({ ...task, boundary: 'overdue' }, 'America/New_York'))
            .not.toBe(idempotencyKey(task, 'America/New_York'));
        expect(idempotencyKey(task, 'America/Los_Angeles'))
            .not.toBe(idempotencyKey(task, 'America/New_York'));
    });

    test('emits tenant-scoped PII-safe events and dedupes across ticks/restarts', async () => {
        const companies = [
            { company_id: COMPANY_A, timezone: 'America/New_York' },
            { company_id: COMPANY_B, timezone: 'America/Los_Angeles' },
        ];
        const candidates = {
            [COMPANY_A]: [{
                id: 42, company_id: COMPANY_A, boundary: 'due', local_due_date: '2026-08-01',
            }],
            [COMPANY_B]: [{
                id: 42, company_id: COMPANY_B, boundary: 'overdue', local_due_date: '2026-07-31',
            }],
        };
        const queries = {
            listActiveCompanyTimezones: jest.fn().mockResolvedValue(companies),
            listTaskBoundaryCandidates: jest.fn(async companyId => candidates[companyId]),
        };
        const persisted = new Set();
        const bus = {
            emit: jest.fn(async (companyId, _eventType, _payload, options) => {
                const tenantKey = `${companyId}:${options.idempotencyKey}`;
                if (persisted.has(tenantKey)) return null;
                persisted.add(tenantKey);
                return { id: persisted.size };
            }),
        };
        const firstProcess = createTaskNotificationScheduler({ queries, eventBus: bus });
        const restartedProcess = createTaskNotificationScheduler({ queries, eventBus: bus });
        const now = new Date('2026-08-01T12:00:00.000Z');

        await expect(firstProcess.tick(now)).resolves.toEqual({ companies: 2, emitted: 2 });
        await expect(restartedProcess.tick(now)).resolves.toEqual({ companies: 2, emitted: 0 });
        expect(queries.listTaskBoundaryCandidates).toHaveBeenCalledWith(
            COMPANY_A, 'America/New_York', now
        );
        expect(queries.listTaskBoundaryCandidates).toHaveBeenCalledWith(
            COMPANY_B, 'America/Los_Angeles', now
        );
        expect(bus.emit).toHaveBeenCalledWith(
            COMPANY_A,
            'task.due',
            { task_id: 42, record_refs: [{ type: 'task', id: 42 }] },
            expect.objectContaining({
                actorType: 'system',
                aggregateType: 'task',
                aggregateId: 42,
            })
        );
        expect(JSON.stringify(bus.emit.mock.calls)).not.toMatch(/title|description|amount|phone|address/i);
    });
});
