'use strict';

const { TEST_TOKEN, GATEWAY_BASE_URL, app, response, runApplication } = require('./helpers');

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
});
