'use strict';

const dryRunner = require('../backend/src/services/appBuilderDryRunService');

const SOURCE = 'export async function run(ctx) { return ctx.input; }';
const SOURCE_SHA256 = 'a'.repeat(64);
const ORIGINAL_BASE_URL = process.env.APP_RUNNER_BASE_URL;
const ORIGINAL_SERVICE_TOKEN = process.env.APP_RUNNER_SERVICE_TOKEN;

beforeEach(() => {
    process.env.APP_RUNNER_BASE_URL = 'https://runner.albusto.test';
    process.env.APP_RUNNER_SERVICE_TOKEN = 'crm-to-runner-service-token';
});

afterAll(() => {
    if (ORIGINAL_BASE_URL === undefined) delete process.env.APP_RUNNER_BASE_URL;
    else process.env.APP_RUNNER_BASE_URL = ORIGINAL_BASE_URL;
    if (ORIGINAL_SERVICE_TOKEN === undefined) delete process.env.APP_RUNNER_SERVICE_TOKEN;
    else process.env.APP_RUNNER_SERVICE_TOKEN = ORIGINAL_SERVICE_TOKEN;
});

describe('APP-SVC-001 CRM-to-runner HTTP seam', () => {
    test('sends the pinned artifact and deterministic sandbox seed with service authentication', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({
            status: 200,
            text: async () => JSON.stringify({
                ok: true,
                result: { today: '2026-07-31' },
                validation: { entry_point: 'run', tools: [], returned_type: 'object' },
                usage: { wall_ms: 2, gateway_calls: 0, result_bytes: 22, error_code: null },
                fixtures_summary: {
                    companies: 1, contacts: 6, leads: 6, jobs: 6,
                    tasks: 8, invoices: 5, payments: 4,
                },
            }),
        });
        await expect(dryRunner.validateAndDryRun({
            source: SOURCE,
            expectedSourceSha256: SOURCE_SHA256,
        }, { fetchImpl })).resolves.toEqual({
            entry_point: 'run',
            tools: [],
            returned_type: 'object',
            usage: { wall_ms: 2, gateway_calls: 0, result_bytes: 22, error_code: null },
            fixtures_summary: {
                companies: 1, contacts: 6, leads: 6, jobs: 6,
                tasks: 8, invoices: 5, payments: 4,
            },
            result: { today: '2026-07-31' },
        });

        const [url, options] = fetchImpl.mock.calls[0];
        expect(url).toBe('https://runner.albusto.test/v1/dry-run');
        expect(options.headers.Authorization).toBe('Bearer crm-to-runner-service-token');
        expect(JSON.parse(options.body)).toMatchObject({
            source: SOURCE,
            expectedSourceSha256: SOURCE_SHA256,
            // The sandbox is anchored to the real current day, so the dry-run input
            // must follow it: a pinned date silently made every date-aware draft
            // test against a day the fixtures no longer contain.
            input: { today: new Date().toISOString().slice(0, 10) },
            seed: 'app-studio-builder-v1',
        });
        expect(JSON.parse(options.body)).not.toHaveProperty('fixtures');
    });

    test('runner authentication and validation failures preserve safe error codes', () => {
        expect(() => dryRunner.parseResult({
            ok: false,
            error: { code: 'FORBIDDEN_IDENTIFIER', message: 'Rejected.' },
        }, 422)).toThrow(expect.objectContaining({ code: 'FORBIDDEN_IDENTIFIER' }));
        expect(() => dryRunner.parseResult({ ok: false }, 401))
            .toThrow(expect.objectContaining({ code: 'RUNNER_AUTH_FAILED' }));
    });

    test('missing runner URL fails closed before an HTTP request', async () => {
        delete process.env.APP_RUNNER_BASE_URL;
        const fetchImpl = jest.fn();
        await expect(dryRunner.validateAndDryRun({
            source: SOURCE,
            expectedSourceSha256: SOURCE_SHA256,
        }, { fetchImpl })).rejects.toMatchObject({
            code: 'RUNNER_NOT_CONFIGURED',
            stage: 'configuration',
        });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('network failure becomes a clear unavailable error with no local fallback', async () => {
        const fetchImpl = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
        await expect(dryRunner.validateAndDryRun({
            source: SOURCE,
            expectedSourceSha256: SOURCE_SHA256,
        }, { fetchImpl })).rejects.toMatchObject({
            code: 'RUNNER_UNAVAILABLE',
            stage: 'configuration',
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});
