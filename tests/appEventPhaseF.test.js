'use strict';

const {
    RETRY_DELAYS_MS,
    SINGLE_FLIGHT_DELAY_MS,
    createAppEventWorker,
} = require('../backend/src/services/appEventWorker');

const COMPANY_ID = '10000000-0000-4000-8000-000000000001';
const ACTOR_ID = '20000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-08-02T12:00:00.000Z');

function claim(overrides = {}) {
    return {
        id: '71',
        company_id: COMPANY_ID,
        installation_id: '91',
        event_type: 'estimate.approved',
        payload: { estimate_id: 41, order_list_count: 2 },
        attempts: 0,
        actor_id: ACTOR_ID,
        ...overrides,
    };
}

describe('APP-DATA-001 Phase F event dispatcher', () => {
    test('a claimed event runs through the shared core with input.event and becomes delivered', async () => {
        const database = {
            query: jest.fn().mockResolvedValue({ rows: [] }),
        };
        const execution = {
            run: jest.fn().mockResolvedValue({ status: 'completed' }),
        };
        const worker = createAppEventWorker({ database, execution });
        const delivery = claim();

        await expect(worker.executeClaim(delivery, NOW)).resolves.toBe('delivered');
        expect(execution.run).toHaveBeenCalledWith({
            companyId: COMPANY_ID,
            installationId: '91',
            trigger: 'event',
            actorId: ACTOR_ID,
            event: {
                type: 'estimate.approved',
                payload: delivery.payload,
            },
        });
        expect(database.query).toHaveBeenCalledWith(
            expect.stringContaining("SET status = 'delivered'"),
            ['71', COMPANY_ID, '91']
        );
    });

    test('execution failures retry after one and five minutes, then fail with last_error', async () => {
        const database = {
            query: jest.fn(async (_sql, params) => {
                const attempts = Number(params[0]) - 70;
                return { rows: [{
                    status: attempts >= 3 ? 'failed' : 'pending',
                    attempts,
                    next_attempt_at: params[3],
                    last_error: params[4],
                }] };
            }),
        };
        const execution = { run: jest.fn().mockRejectedValue(new Error('runner exploded')) };
        const worker = createAppEventWorker({ database, execution });

        await expect(worker.executeClaim(claim({ id: '71', attempts: 0 }), NOW))
            .resolves.toBe('pending');
        await expect(worker.executeClaim(claim({ id: '72', attempts: 1 }), NOW))
            .resolves.toBe('pending');
        await expect(worker.executeClaim(claim({ id: '73', attempts: 2 }), NOW))
            .resolves.toBe('failed');

        const params = database.query.mock.calls.map(([, values]) => values);
        expect(params[0][3]).toEqual(new Date(NOW.getTime() + RETRY_DELAYS_MS[0]));
        expect(params[1][3]).toEqual(new Date(NOW.getTime() + RETRY_DELAYS_MS[1]));
        expect(params[2][3]).toEqual(NOW);
        expect(params[2][4]).toBe('runner exploded');
    });

    test('single-flight defers for 30 seconds without consuming a retry or starting a rival', async () => {
        const database = { query: jest.fn().mockResolvedValue({ rows: [] }) };
        const execution = { run: jest.fn().mockResolvedValue({ status: 'running' }) };
        const worker = createAppEventWorker({ database, execution });

        await expect(worker.executeClaim(claim(), NOW)).resolves.toBe('deferred');
        expect(execution.run).toHaveBeenCalledTimes(1);
        expect(database.query).toHaveBeenCalledWith(
            expect.stringContaining("SET status = 'pending'"),
            ['71', COMPANY_ID, '91', new Date(NOW.getTime() + SINGLE_FLIGHT_DELAY_MS)]
        );
        expect(database.query.mock.calls[0][0]).not.toContain('attempts =');
    });

    test('claim SQL pairs every delivery to its own tenant installation and uses SKIP LOCKED', async () => {
        const query = jest.fn(async sql => {
            if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
            if (/SELECT delivery.id/.test(sql)) return { rows: [] };
            return { rows: [] };
        });
        const worker = createAppEventWorker({
            database: {
                getClient: jest.fn().mockResolvedValue({ query, release: jest.fn() }),
            },
            execution: { run: jest.fn() },
        });
        await worker.claimDue(NOW);
        const claimSql = query.mock.calls.find(([sql]) => /SELECT delivery.id/.test(sql))[0];
        expect(claimSql).toContain('installation.company_id = delivery.company_id');
        expect(claimSql).toContain('installation.id = delivery.installation_id');
        expect(claimSql).toContain('FOR UPDATE OF delivery SKIP LOCKED');
    });
});
