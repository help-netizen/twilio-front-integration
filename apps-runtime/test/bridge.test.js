'use strict';

const { TEST_TOKEN, GATEWAY_BASE_URL, app, response, runApplication } = require('./helpers');
const runner = require('../src/runner');

describe('APP-RUN-001 host gateway bridge', () => {
    test('callTool sends the exact name and arguments with the host-held token', async () => {
        const fetchImpl = jest.fn(async () => response({ tasks: [{ id: 21 }] }));
        const result = await runApplication({
            source: app("return ctx.callTool('svc.list_tasks', { status: 'open', limit: 3 });"),
            input: {},
            gatewayBaseUrl: GATEWAY_BASE_URL,
            runToken: TEST_TOKEN,
            fetchImpl,
        });

        expect(result).toEqual({ tasks: [{ id: 21 }] });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, options] = fetchImpl.mock.calls[0];
        expect(url).toBeInstanceOf(URL);
        expect(url.href).toBe(
            'https://crm.albusto.test/internal/app-runtime/v1/tools/svc.list_tasks'
        );
        expect(options).toMatchObject({
            method: 'POST',
            headers: {
                Authorization: `Bearer ${TEST_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ status: 'open', limit: 3 }),
        });
    });

    test.each([
        [403, 'ACCESS_DENIED'],
        [429, 'RATE_LIMITED'],
    ])('gateway %s is thrown inside the application with code and status', async (status, code) => {
        const fetchImpl = jest.fn(async () => response(null, {
            ok: false,
            status,
            code,
            message: 'Denied by the gateway.',
        }));
        const result = await runApplication({
            source: app(`
                try {
                    await albusto.callTool('svc.list_jobs', { limit: 1 });
                    return { caught: false };
                } catch (error) {
                    return {
                        caught: true,
                        name: error.name,
                        code: error.code,
                        status: error.status,
                        message: error.message,
                    };
                }
            `, ''),
            input: {},
            gatewayBaseUrl: GATEWAY_BASE_URL,
            runToken: TEST_TOKEN,
            fetchImpl,
        });

        expect(result).toEqual({
            caught: true,
            name: 'GatewayError',
            code,
            status,
            message: 'Denied by the gateway.',
        });
    });

    test('gateway data containing the token is blocked before isolate delivery', async () => {
        const fetchImpl = jest.fn(async () => response({ leaked: TEST_TOKEN }));
        await expect(runApplication({
            source: app("return ctx.callTool('svc.list_jobs', { limit: 1 });"),
            input: {},
            gatewayBaseUrl: GATEWAY_BASE_URL,
            runToken: TEST_TOKEN,
            fetchImpl,
        })).rejects.toMatchObject({ code: 'APP_RUNTIME_TOKEN_EXPOSURE_BLOCKED' });
    });

    test('ctx.data bridges collection and rows to the live CRM with the host-held run token', async () => {
        const source = app("return ctx.data.upsert('purchases', [{ estimate_id: 41, part_number: 'P-41' }]);");
        const fetchImpl = jest.fn(async url => {
            if (url.pathname.endsWith('/upsert')) return response({ upserted: 1 });
            return response(null);
        });
        let usage;
        const result = await runner.runApplication({
            source,
            expectedSourceSha256: runner.sourceSha256(source),
            input: {},
            gatewayBaseUrl: GATEWAY_BASE_URL,
            runToken: TEST_TOKEN,
            fetchImpl,
            executionMode: 'live',
            onUsage: value => { usage = value; },
        });
        expect(result).toEqual({ upserted: 1 });
        const dataCall = fetchImpl.mock.calls.find(([url]) => url.pathname.endsWith('/upsert'));
        expect(dataCall[0].href).toBe(
            'https://crm.albusto.test/internal/app-runtime/v1/data/purchases/upsert'
        );
        expect(dataCall[1]).toMatchObject({
            method: 'POST',
            headers: {
                Authorization: `Bearer ${TEST_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify([{ estimate_id: 41, part_number: 'P-41' }]),
        });
        expect(usage).toMatchObject({ gateway_calls: 0, data_calls: 1, error_code: null });
    });
});
