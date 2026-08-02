'use strict';

const { LIMITS } = require('../src/config');
const { TEST_TOKEN, GATEWAY_BASE_URL, app, response, runApplication } = require('./helpers');

describe('APP-RUN-001 resource limits', () => {
    test('an infinite loop is terminated by the 100 ms CPU limit', async () => {
        await expect(runApplication({
            source: app('while (true) {}', ''),
            input: {},
            gatewayBaseUrl: GATEWAY_BASE_URL,
            runToken: TEST_TOKEN,
            fetchImpl: jest.fn(),
        })).rejects.toMatchObject({ code: 'APP_RUNTIME_CPU_LIMIT' });
    });

    test('an allocation larger than the 32 MB isolate limit is terminated', async () => {
        await expect(runApplication({
            source: app(`
                const bytes = new Uint8Array(40 * 1024 * 1024);
                for (let index = 0; index < bytes.length; index += 4096) bytes[index] = 1;
                return bytes.length;
            `, ''),
            input: {},
            gatewayBaseUrl: GATEWAY_BASE_URL,
            runToken: TEST_TOKEN,
            fetchImpl: jest.fn(),
        })).rejects.toMatchObject({ code: 'APP_RUNTIME_MEMORY_LIMIT' });
    });

    test('the sixth gateway call is rejected and no sixth request leaves the host', async () => {
        const fetchImpl = jest.fn(async () => response({ accepted: true }));
        await expect(runApplication({
            source: app(`
                for (let index = 0; index < 6; index += 1) {
                    await ctx.callTool('svc.list_tasks', { limit: 1 });
                }
                return 'unreachable';
            `),
            input: {},
            gatewayBaseUrl: GATEWAY_BASE_URL,
            runToken: TEST_TOKEN,
            fetchImpl,
        })).rejects.toMatchObject({ code: 'APP_RUNTIME_GATEWAY_CALL_LIMIT' });
        expect(fetchImpl).toHaveBeenCalledTimes(LIMITS.gatewayCallLimit);
    });

    test('five gateway calls are allowed', async () => {
        const fetchImpl = jest.fn(async () => response({ accepted: true }));
        const result = await runApplication({
            source: app(`
                const results = [];
                for (let index = 0; index < 5; index += 1) {
                    results.push(await ctx.callTool('svc.list_tasks', { limit: 1 }));
                }
                return results.length;
            `),
            input: {},
            gatewayBaseUrl: GATEWAY_BASE_URL,
            runToken: TEST_TOKEN,
            fetchImpl,
        });
        expect(result).toBe(5);
        expect(fetchImpl).toHaveBeenCalledTimes(5);
    });

    test('output larger than the view-document ceiling is rejected before it is copied to the host', async () => {
        await expect(runApplication({
            source: app("return 'x'.repeat(256 * 1024 + 1);", ''),
            input: {},
            gatewayBaseUrl: GATEWAY_BASE_URL,
            runToken: TEST_TOKEN,
            fetchImpl: jest.fn(),
        })).rejects.toMatchObject({ code: 'APP_RUNTIME_OUTPUT_TOO_LARGE' });
    });
});
