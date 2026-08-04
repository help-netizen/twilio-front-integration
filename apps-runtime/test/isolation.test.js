'use strict';

const { TEST_TOKEN, GATEWAY_BASE_URL, app, runApplication } = require('./helpers');

describe('APP-RUN-001 isolate capability boundary', () => {
    test.each([
        ['require', 'return require;'],
        ['process', 'return process;'],
        ['fetch', 'return fetch;'],
        ['globalThis.constructor', 'return globalThis.constructor;'],
        ['eval', "return eval('1 + 1');"],
        ['Function constructor', "return Function('return this')();"],
        [
            'indirect Function constructor',
            "return ({}).constructor.constructor('return this')();",
        ],
    ])('%s cannot be reached', async (_name, body) => {
        await expect(runApplication({
            source: app(body, ''),
            input: {},
            gatewayBaseUrl: GATEWAY_BASE_URL,
            runToken: TEST_TOKEN,
            fetchImpl: jest.fn(),
        })).rejects.toMatchObject({ code: 'APP_RUNTIME_CAPABILITY_DISABLED' });
    });

    test('static module imports are rejected without resolving them', async () => {
        await expect(runApplication({
            source: "import value from 'node:fs'; export async function run() { return value; }",
            input: {},
            gatewayBaseUrl: GATEWAY_BASE_URL,
            runToken: TEST_TOKEN,
            fetchImpl: jest.fn(),
        })).rejects.toMatchObject({ code: 'APP_RUNTIME_APP_FORMAT_INVALID' });
    });

    test('dynamic module imports have no loader', async () => {
        await expect(runApplication({
            source: app("return import('node:fs');", ''),
            input: {},
            gatewayBaseUrl: GATEWAY_BASE_URL,
            runToken: TEST_TOKEN,
            fetchImpl: jest.fn(),
        })).rejects.toMatchObject({ code: 'APP_RUNTIME_EXECUTION_FAILED' });
    });

    test('the module has exactly one async run entry point', async () => {
        await expect(runApplication({
            source: 'export function run() { return 1; }',
            input: {},
            gatewayBaseUrl: GATEWAY_BASE_URL,
            runToken: TEST_TOKEN,
            fetchImpl: jest.fn(),
        })).rejects.toMatchObject({ code: 'APP_RUNTIME_APP_FORMAT_INVALID' });
        await expect(runApplication({
            source: 'export async function run() { return 1; } export const other = true;',
            input: {},
            gatewayBaseUrl: GATEWAY_BASE_URL,
            runToken: TEST_TOKEN,
            fetchImpl: jest.fn(),
        })).rejects.toMatchObject({ code: 'APP_RUNTIME_APP_FORMAT_INVALID' });
    });

    test('run token is absent from globals, albusto, and ctx', async () => {
        const result = await runApplication({
            source: app(`
                const globals = [];
                for (const key of Reflect.ownKeys(globalThis)) {
                    const label = typeof key === 'symbol' ? key.toString() : key;
                    try {
                        globals.push([label, String(globalThis[key])]);
                    } catch (error) {
                        globals.push([label, String(error && error.message)]);
                    }
                }
                return {
                    globals,
                    ctxKeys: Object.keys(ctx),
                    ctxValues: Object.values(ctx).map(value => String(value)),
                    albustoKeys: Object.keys(albusto),
                    albustoValue: String(albusto.callTool),
                };
            `),
            input: { harmless: 'value' },
            gatewayBaseUrl: GATEWAY_BASE_URL,
            runToken: TEST_TOKEN,
            fetchImpl: jest.fn(),
        });

        expect(JSON.stringify(result)).not.toContain(TEST_TOKEN);
        expect(result.ctxKeys).toEqual([
            'callTool', 'data', 'http', 'input', 'company', 'settings', 'log',
        ]);
        expect(result.albustoKeys).toEqual(['callTool', 'data', 'http']);
    });

    test('source and input cannot smuggle the host run token into the isolate', async () => {
        await expect(runApplication({
            source: app(`return ${JSON.stringify(TEST_TOKEN)};`, ''),
            input: {},
            gatewayBaseUrl: GATEWAY_BASE_URL,
            runToken: TEST_TOKEN,
            fetchImpl: jest.fn(),
        })).rejects.toMatchObject({ code: 'APP_RUNTIME_TOKEN_EXPOSURE_BLOCKED' });
        await expect(runApplication({
            source: app('return ctx.input;'),
            input: { secret: TEST_TOKEN },
            gatewayBaseUrl: GATEWAY_BASE_URL,
            runToken: TEST_TOKEN,
            fetchImpl: jest.fn(),
        })).rejects.toMatchObject({ code: 'APP_RUNTIME_TOKEN_EXPOSURE_BLOCKED' });
    });

    test('application global state never survives into another run', async () => {
        const source = app(`
            globalThis.runCounter = (globalThis.runCounter || 0) + 1;
            return globalThis.runCounter;
        `, '');
        const options = {
            source,
            input: {},
            gatewayBaseUrl: GATEWAY_BASE_URL,
            runToken: TEST_TOKEN,
            fetchImpl: jest.fn(),
        };

        await expect(runApplication(options)).resolves.toBe(1);
        await expect(runApplication(options)).resolves.toBe(1);
    });
});
