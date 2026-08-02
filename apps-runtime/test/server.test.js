'use strict';

const dataset = require('../src/sandboxDataset');

const { sourceSha256 } = require('../src/runner');
const { MAX_BODY_BYTES, createRunnerServer } = require('../src/server');

const SERVICE_TOKEN = 'runner-service-test-token-with-enough-entropy';
const SOURCE = 'export async function run(ctx) { return { today: ctx.input.today }; }';
const DRY_RUN_BODY = {
    source: SOURCE,
    expectedSourceSha256: sourceSha256(SOURCE),
    input: { today: '2026-07-31' },
    seed: 'server-test-seed',
};

const servers = [];

async function startServer(options = {}) {
    const server = createRunnerServer({ serviceToken: SERVICE_TOKEN, ...options });
    servers.push(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
}

async function post(baseUrl, path, { token = SERVICE_TOKEN, body = DRY_RUN_BODY } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    return fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

describe('APP-SVC-001 runner HTTP service', () => {
    test('health is public and a valid service token runs a pinned dry-run', async () => {
        const baseUrl = await startServer();
        const health = await fetch(`${baseUrl}/health`);
        expect(health.status).toBe(200);
        await expect(health.json()).resolves.toEqual({ ok: true });

        const response = await post(baseUrl, '/v1/dry-run');
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            ok: true,
            result: { today: '2026-07-31' },
            validation: { entry_point: 'run', returned_type: 'object' },
            usage: { gateway_calls: 0, error_code: null },
            fixtures_summary: {
                companies: 1,
                contacts: dataset.customers.length,
                leads: dataset.leads.length,
                jobs: dataset.jobs.length,
                tasks: dataset.tasks.length,
            },
        });
    });

    test.each([
        ['missing', null],
        ['wrong', 'wrong-runner-service-token'],
    ])('SAB APP-SVC-001 service auth: %s token returns 401', async (_label, token) => {
        const baseUrl = await startServer();
        const response = await post(baseUrl, '/v1/dry-run', { token });
        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toMatchObject({
            ok: false,
            error: { code: 'APP_RUNNER_AUTH_REQUIRED' },
        });
    });

    test('request bodies larger than 256 KB return 413', async () => {
        const baseUrl = await startServer();
        const response = await post(baseUrl, '/v1/dry-run', {
            body: JSON.stringify({ padding: 'x'.repeat(MAX_BODY_BYTES + 1) }),
        });
        expect(response.status).toBe(413);
        await expect(response.json()).resolves.toMatchObject({
            error: { code: 'PAYLOAD_TOO_LARGE' },
        });
    });

    test('source hash mismatch is refused before execution', async () => {
        const baseUrl = await startServer();
        const response = await post(baseUrl, '/v1/dry-run', {
            body: { ...DRY_RUN_BODY, expectedSourceSha256: '0'.repeat(64) },
        });
        expect(response.status).toBe(422);
        await expect(response.json()).resolves.toMatchObject({
            ok: false,
            error: { code: 'APP_RUNTIME_SOURCE_MISMATCH' },
            usage: { gateway_calls: 0, error_code: 'APP_RUNTIME_SOURCE_MISMATCH' },
        });
    });

    test('execution timeout returns 504 without waiting for stalled work', async () => {
        const baseUrl = await startServer({
            timeoutMs: 25,
            dryRunImpl: () => new Promise(() => {}),
        });
        const startedAt = Date.now();
        const response = await post(baseUrl, '/v1/dry-run');
        expect(response.status).toBe(504);
        expect(Date.now() - startedAt).toBeLessThan(1000);
        await expect(response.json()).resolves.toMatchObject({
            error: {
                code: 'APP_RUNTIME_REQUEST_TIMEOUT',
                message: 'Application request exceeded the host timeout.',
            },
            usage: { error_code: 'APP_RUNTIME_REQUEST_TIMEOUT' },
        });
    });

    test('an app that names a nonexistent tool returns the honest static error', async () => {
        const source = "export async function run(ctx) { return ctx.callTool('svc.missing', {}); }";
        const baseUrl = await startServer();
        const response = await post(baseUrl, '/v1/dry-run', {
            body: {
                ...DRY_RUN_BODY,
                source,
                expectedSourceSha256: sourceSha256(source),
            },
        });
        expect(response.status).toBe(422);
        await expect(response.json()).resolves.toMatchObject({
            ok: false,
            error: {
                code: 'UNKNOWN_TOOL',
                message: 'Application calls an unknown tool: svc.missing.',
            },
            usage: { gateway_calls: 0, error_code: 'UNKNOWN_TOOL' },
        });
    });

    test('an application CPU timeout is reported as a timeout, never as a completed run', async () => {
        const source = 'export async function run(ctx) { while (ctx) {} }';
        const baseUrl = await startServer();
        const response = await post(baseUrl, '/v1/dry-run', {
            body: {
                ...DRY_RUN_BODY,
                source,
                expectedSourceSha256: sourceSha256(source),
            },
        });
        expect(response.status).toBe(422);
        await expect(response.json()).resolves.toMatchObject({
            ok: false,
            error: {
                code: 'APP_RUNTIME_CPU_LIMIT',
                message: 'Application exceeded the CPU limit.',
            },
            usage: { error_code: 'APP_RUNTIME_CPU_LIMIT' },
        });
    });

    test('run endpoint passes the run token only to the real CRM gateway bridge', async () => {
        const runApplicationImpl = jest.fn().mockImplementation(async options => {
            options.onUsage({ wall_ms: 1, gateway_calls: 0, result_bytes: 11, error_code: null });
            return { ok: 'ran' };
        });
        const baseUrl = await startServer({
            gatewayBaseUrl: 'https://crm.albusto.test',
            runApplicationImpl,
        });
        const response = await post(baseUrl, '/v1/run', {
            body: {
                source: DRY_RUN_BODY.source,
                expectedSourceSha256: DRY_RUN_BODY.expectedSourceSha256,
                input: DRY_RUN_BODY.input,
                runToken: 'host-only-run-token',
            },
        });
        expect(response.status).toBe(200);
        expect(runApplicationImpl).toHaveBeenCalledWith(expect.objectContaining({
            expectedSourceSha256: DRY_RUN_BODY.expectedSourceSha256,
            runToken: 'host-only-run-token',
            gatewayBaseUrl: 'https://crm.albusto.test',
            executionMode: 'live',
        }));
    });

    test('SAB APP-FINAL sandbox and live envelopes cannot cross fixture or run-token fields', async () => {
        const dryRunImpl = jest.fn().mockResolvedValue({
            result: null,
            validation: { source_bytes: 1, tools: [], entry_point: 'run', returned_type: 'null' },
            usage: { wall_ms: 1, gateway_calls: 0, result_bytes: 4, error_code: null },
            fixturesSummary: {},
        });
        const runApplicationImpl = jest.fn();
        const baseUrl = await startServer({ dryRunImpl, runApplicationImpl });
        const fixtureIntoLive = await post(baseUrl, '/v1/run', {
            body: {
                source: SOURCE,
                expectedSourceSha256: sourceSha256(SOURCE),
                runToken: 'host-only-run-token',
                input: {},
                fixtures: { 'svc.list_jobs': { results: [] } },
            },
        });
        expect(fixtureIntoLive.status).toBe(400);
        expect(runApplicationImpl).not.toHaveBeenCalled();

        const tokenIntoDryRun = await post(baseUrl, '/v1/dry-run', {
            body: { ...DRY_RUN_BODY, runToken: 'must-not-reach-sandbox' },
        });
        expect(tokenIntoDryRun.status).toBe(400);
        expect(dryRunImpl).not.toHaveBeenCalled();
    });
});
