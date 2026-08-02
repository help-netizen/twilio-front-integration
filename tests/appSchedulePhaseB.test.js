'use strict';

const {
    forecastCost,
    nextRunAt,
    validateCadence,
} = require('../backend/src/services/appScheduleCadence');
const { createAppScheduleWorker } = require('../backend/src/services/appScheduleWorker');
const { createAppScheduleService } = require('../backend/src/services/appScheduleService');
const { createAppExecutionService } = require('../backend/src/services/appExecutionService');

const COMPANY_ID = '10000000-0000-4000-8000-000000000001';
const ACTOR_ID = '20000000-0000-4000-8000-000000000001';
const VERSION_ID = '30000000-0000-4000-8000-000000000001';

function transactionClient(queryImplementation) {
    return {
        query: jest.fn(queryImplementation),
        release: jest.fn(),
    };
}

describe('APP-VIEW-001 Phase B schedule contract', () => {
    test('1. all five cadence forms resolve the next run in company time and junk is rejected', () => {
        const timezone = 'America/New_York';
        const from = new Date('2026-08-02T12:07:30.000Z');
        const cases = [
            [{ kind: 'every_minutes', n: 15 }, '2026-08-02T12:15:00.000Z'],
            [{ kind: 'hourly', minute: 5 }, '2026-08-02T13:05:00.000Z'],
            [{ kind: 'daily', at: '07:00' }, '2026-08-03T11:00:00.000Z'],
            [{ kind: 'weekly', dow: 1, at: '07:00' }, '2026-08-03T11:00:00.000Z'],
            [{ kind: 'monthly', dom: 1, at: '07:00' }, '2026-09-01T11:00:00.000Z'],
        ];
        for (const [cadence, expected] of cases) {
            expect(validateCadence(cadence)).toEqual(cadence);
            expect(nextRunAt(cadence, timezone, from).toISOString()).toBe(expected);
        }
        for (const garbage of [
            { kind: 'cron', value: '* * * * *' },
            { kind: 'every_minutes', n: 0 },
            { kind: 'hourly', minute: 60 },
            { kind: 'daily', at: '7:00' },
            { kind: 'weekly', dow: 7, at: '07:00' },
            { kind: 'monthly', dom: 32, at: '07:00' },
            { kind: 'daily', at: '07:00', extra: true },
        ]) {
            expect(() => validateCadence(garbage)).toThrow(expect.objectContaining({
                code: 'INVALID_CADENCE',
            }));
        }
        expect(forecastCost({ kind: 'every_minutes', n: 1 })).toMatchObject({
            runs_per_day: 1440,
            runs_per_month: 43800,
            maximum_data_reads_per_month: 219000,
            maximum_compute_ms_per_day: 17280000,
        });
    });

    test('2. local-midnight daily cadence spans the 23-hour and 25-hour DST days', () => {
        const timezone = 'America/New_York';
        const cadence = { kind: 'daily', at: '00:00' };
        const springMidnight = new Date('2026-03-08T05:00:00.000Z');
        const afterSpring = nextRunAt(cadence, timezone, springMidnight);
        expect(afterSpring.toISOString()).toBe('2026-03-09T04:00:00.000Z');
        expect(afterSpring.getTime() - springMidnight.getTime()).toBe(23 * 60 * 60 * 1000);

        const fallMidnight = new Date('2026-11-01T04:00:00.000Z');
        const afterFall = nextRunAt(cadence, timezone, fallMidnight);
        expect(afterFall.toISOString()).toBe('2026-11-02T05:00:00.000Z');
        expect(afterFall.getTime() - fallMidnight.getTime()).toBe(25 * 60 * 60 * 1000);
    });

    test('3/9. SAB NO-BACKFILL: a two-hour-old minute window is claimed once and advances from now', async () => {
        const tickNow = new Date('2026-08-02T12:00:00.000Z');
        const oldWindow = new Date('2026-08-02T10:00:00.000Z');
        const client = transactionClient(async (sql, params) => {
            if (/SELECT schedule\.installation_id/.test(sql)) {
                return { rows: [{
                    installation_id: '91',
                    company_id: COMPANY_ID,
                    cadence: { kind: 'every_minutes', n: 1 },
                    next_run_at: oldWindow,
                    actor_id: ACTOR_ID,
                    timezone: 'America/New_York',
                    app_name: 'Parts digest',
                }] };
            }
            if (/UPDATE app_installation_schedules schedule/.test(sql)) {
                return { rows: [{ last_run_at: params[2], next_run_at: params[3] }] };
            }
            return { rows: [] };
        });
        const database = {
            getClient: jest.fn().mockResolvedValue(client),
            query: jest.fn().mockResolvedValue({ rows: [] }),
        };
        const execution = {
            run: jest.fn().mockResolvedValue({ status: 'completed' }),
        };
        const worker = createAppScheduleWorker({ database, execution });

        await expect(worker.tick(tickNow)).resolves.toEqual({
            claimed: 1,
            outcomes: ['succeeded'],
        });
        expect(execution.run).toHaveBeenCalledTimes(1);
        expect(execution.run).toHaveBeenCalledWith({
            companyId: COMPANY_ID,
            installationId: '91',
            trigger: 'schedule',
            actorId: ACTOR_ID,
        });
        const claimUpdate = client.query.mock.calls.find(([sql]) => (
            /SET next_run_at = \$4/.test(sql)
        ));
        expect(claimUpdate[1][3].toISOString()).toBe('2026-08-02T12:01:00.000Z');
        expect(claimUpdate[1][3].getTime()).toBeGreaterThan(tickNow.getTime());
    });

    test('4. the third consecutive failure disables the schedule and creates one English CRM task', async () => {
        let failureCount = 0;
        const writes = [];
        const client = transactionClient(async (sql) => {
            writes.push(sql);
            if (/SET failure_count = schedule\.failure_count \+ 1/.test(sql)) {
                failureCount += 1;
                return { rows: [{ failure_count: failureCount, enabled: failureCount < 3 }] };
            }
            return { rows: [] };
        });
        const database = {
            getClient: jest.fn().mockResolvedValue(client),
            query: jest.fn(),
        };
        const execution = {
            run: jest.fn().mockRejectedValue(Object.assign(new Error('Runner failed'), {
                code: 'APP_RUNNER_UNAVAILABLE',
            })),
        };
        const worker = createAppScheduleWorker({ database, execution });
        for (let index = 0; index < 3; index += 1) {
            const instant = new Date(Date.UTC(2026, 7, 2, 12, index));
            await worker.executeClaim({
                installation_id: '91',
                company_id: COMPANY_ID,
                actor_id: ACTOR_ID,
                app_name: 'Parts digest',
                claimed_at: instant,
                claimed_next_run_at: new Date(instant.getTime() + 60_000),
            });
        }
        expect(execution.run).toHaveBeenCalledTimes(3);
        expect(writes.filter(sql => /INSERT INTO tasks/.test(sql))).toHaveLength(1);
        const taskCall = client.query.mock.calls.find(([sql]) => /INSERT INTO tasks/.test(sql));
        expect(taskCall[1]).toEqual([
            COMPANY_ID,
            'App schedule disabled: Parts digest',
            expect.stringContaining('disabled after three consecutive failures'),
            ACTOR_ID,
        ]);
        expect(writes.join('\n')).toContain("THEN 'THREE_CONSECUTIVE_FAILURES'");
    });

    test('5. lost installer permission suspends before token mint and the worker records authority loss', async () => {
        const installation = {
            installation_id: '91',
            company_id: COMPANY_ID,
            app_id: '81',
            latest_run_id: null,
            version_id: VERSION_ID,
            source_code: 'export async function run() { return {}; }',
            source_sha256: 'a'.repeat(64),
            allowed_tools: ['svc.list_jobs'],
        };
        const serviceClient = transactionClient(async (sql) => {
            if (/FROM marketplace_installations installation/.test(sql)) {
                return { rows: [installation] };
            }
            return { rows: [] };
        });
        const tokens = { mintRunToken: jest.fn() };
        const executionService = createAppExecutionService({
            database: {
                getClient: jest.fn().mockResolvedValue(serviceClient),
                query: jest.fn(),
            },
            tokens,
            authorization: {
                resolveCompanyUserAuthz: jest.fn().mockRejectedValue(new Error('disabled')),
            },
            fetchImpl: jest.fn(),
        });
        await expect(executionService.run({
            companyId: COMPANY_ID,
            installationId: '91',
            trigger: 'schedule',
            actorId: ACTOR_ID,
        })).rejects.toMatchObject({ code: 'ACCESS_DENIED', httpStatus: 403 });
        expect(tokens.mintRunToken).not.toHaveBeenCalled();

        const workerDatabase = {
            getClient: jest.fn(),
            query: jest.fn().mockResolvedValue({ rows: [] }),
        };
        const worker = createAppScheduleWorker({
            database: workerDatabase,
            execution: {
                run: jest.fn().mockRejectedValue(Object.assign(new Error('denied'), {
                    code: 'ACCESS_DENIED',
                })),
            },
        });
        const claimedAt = new Date('2026-08-02T12:00:00.000Z');
        await expect(worker.executeClaim({
            installation_id: '91',
            company_id: COMPANY_ID,
            actor_id: ACTOR_ID,
            claimed_at: claimedAt,
            claimed_next_run_at: new Date('2026-08-02T12:01:00.000Z'),
        })).resolves.toBe('suspended');
        expect(workerDatabase.query).toHaveBeenCalledWith(
            expect.stringContaining("suspended_reason = $5"),
            expect.arrayContaining(['INSTALLER_AUTHORITY_LOST'])
        );
    });

    test('all three schedule/version operations fail closed through the Phase A live viewer permission gate', async () => {
        const context = {
            installation_id: '91',
            company_id: COMPANY_ID,
            app_id: '81',
            installed_by: ACTOR_ID,
            timezone: 'America/New_York',
            version_id: VERSION_ID,
            version_number: '1.0.0',
            consented_tools: ['svc.list_jobs'],
            allowed_tools: ['svc.list_jobs'],
            daily_run_limit: 1000,
            daily_wall_ms_limit: 600000,
            daily_gateway_call_limit: 1000,
            available_version_id: '40000000-0000-4000-8000-000000000001',
            available_version_number: '2.0.0',
            available_tools: ['svc.list_jobs'],
        };
        const client = transactionClient(async (sql) => {
            if (/FROM marketplace_installations installation/.test(sql)) {
                return { rows: [context] };
            }
            return { rows: [] };
        });
        const execution = {
            requireViewerAccess: jest.fn().mockRejectedValue(Object.assign(new Error('denied'), {
                code: 'ACCESS_DENIED',
                httpStatus: 403,
            })),
        };
        const service = createAppScheduleService({
            database: { getClient: jest.fn().mockResolvedValue(client) },
            execution,
        });
        const base = { companyId: COMPANY_ID, installationId: '91', actorId: ACTOR_ID };

        await expect(service.getSchedule(base)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
        await expect(service.updateSchedule({
            ...base,
            body: { enabled: true, cadence: { kind: 'daily', at: '07:00' } },
        })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
        await expect(service.acceptVersion({
            ...base,
            body: { version_id: context.available_version_id },
        })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
        expect(execution.requireViewerAccess).toHaveBeenCalledTimes(3);
        expect(client.query.mock.calls.map(([sql]) => sql).join('\n'))
            .not.toMatch(/INSERT INTO app_installation_schedules|UPDATE marketplace_installations/);
    });
});
