'use strict';

const { LIMITS } = require('../src/config');
const { GatewayClient } = require('../src/gatewayClient');
const { runApplication, sourceSha256 } = require('../src/runner');
const { TEST_TOKEN, GATEWAY_BASE_URL, app } = require('./helpers');

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
    return {
        ok,
        status,
        text: async () => JSON.stringify(payload),
    };
}

describe('APP-GAP-FIX-001 runtime artifact and host-fetch controls', () => {
    test('SAB APP-GAP-F1 source pinning: approved bytes run and one changed byte is rejected', async () => {
        const approvedSource = app("return 'approved';", '');
        const expectedSourceSha256 = sourceSha256(approvedSource);
        await expect(runApplication({
            source: approvedSource,
            expectedSourceSha256,
            input: {},
            gatewayBaseUrl: GATEWAY_BASE_URL,
            runToken: TEST_TOKEN,
            fetchImpl: jest.fn(),
            executionMode: 'sandbox',
        })).resolves.toBe('approved');

        const fetchImpl = jest.fn();
        await expect(runApplication({
            source: `${approvedSource} `,
            expectedSourceSha256,
            input: {},
            gatewayBaseUrl: GATEWAY_BASE_URL,
            runToken: TEST_TOKEN,
            fetchImpl,
            executionMode: 'sandbox',
        })).rejects.toMatchObject({ code: 'APP_RUNTIME_SOURCE_MISMATCH' });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('expected source SHA-256 is mandatory', async () => {
        await expect(runApplication({
            source: app('return true;', ''),
            input: {},
            gatewayBaseUrl: GATEWAY_BASE_URL,
            runToken: TEST_TOKEN,
            fetchImpl: jest.fn(),
            executionMode: 'sandbox',
        })).rejects.toMatchObject({ code: 'APP_RUNTIME_SOURCE_HASH_REQUIRED' });
    });

    test('host gateway response bytes are capped before JSON delivery', async () => {
        const client = new GatewayClient({
            baseUrl: GATEWAY_BASE_URL,
            runToken: TEST_TOKEN,
            fetchImpl: async () => ({
                ok: true,
                status: 200,
                text: async () => 'x'.repeat(LIMITS.maxGatewayResponseBytes + 1),
            }),
        });
        await expect(client.callTool('svc.list_jobs', {})).rejects.toMatchObject({
            code: 'APP_RUNTIME_GATEWAY_RESPONSE_TOO_LARGE',
        });
    });

    test('host gateway request timeout aborts a stalled fetch', async () => {
        jest.useFakeTimers();
        try {
            const client = new GatewayClient({
                baseUrl: GATEWAY_BASE_URL,
                runToken: TEST_TOKEN,
                fetchImpl: jest.fn(() => new Promise(() => {})),
            });
            const pending = expect(client.callTool('svc.list_jobs', {})).rejects.toMatchObject({
                code: 'APP_RUNTIME_GATEWAY_TIMEOUT',
            });
            await jest.advanceTimersByTimeAsync(LIMITS.gatewayRequestTimeoutMs + 1);
            await pending;
        } finally {
            jest.useRealTimers();
        }
    });

    test('runner reports actual wall/call/result consumption through the host seam', async () => {
        const source = app("return { status: 'ok' };", '');
        const fetchImpl = jest.fn(async () => jsonResponse({ ok: true }));
        await expect(runApplication({
            source,
            expectedSourceSha256: sourceSha256(source),
            input: {},
            gatewayBaseUrl: GATEWAY_BASE_URL,
            runToken: TEST_TOKEN,
            fetchImpl,
        })).resolves.toEqual({ status: 'ok' });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        const [authorizationUrl, authorizationOptions] = fetchImpl.mock.calls[0];
        expect(authorizationUrl.pathname).toBe('/internal/app-runtime/v1/runs/authorize');
        expect(JSON.parse(authorizationOptions.body)).toEqual({
            source_sha256: sourceSha256(source),
        });
        const [url, options] = fetchImpl.mock.calls[1];
        expect(url.pathname).toBe('/internal/app-runtime/v1/runs/complete');
        expect(JSON.parse(options.body)).toMatchObject({
            wall_ms: expect.any(Number),
            gateway_calls: 0,
            result_bytes: Buffer.byteLength(JSON.stringify({ status: 'ok' })),
            error_code: null,
        });
    });

    test('SAB APP-FINAL-P0 live execution requires CRM-authoritative artifact authorization before compile', async () => {
        const source = app("return 'must-not-run';", '');
        const fetchImpl = jest.fn(async () => jsonResponse({
            ok: false,
            code: 'APP_RUNTIME_SOURCE_MISMATCH',
            message: 'Application source does not match the approved artifact.',
        }, { ok: false, status: 403 }));
        await expect(runApplication({
            source,
            expectedSourceSha256: sourceSha256(source),
            input: {},
            gatewayBaseUrl: GATEWAY_BASE_URL,
            runToken: TEST_TOKEN,
            fetchImpl,
        })).rejects.toMatchObject({
            code: 'APP_RUNTIME_SOURCE_MISMATCH',
            httpStatus: 403,
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, options] = fetchImpl.mock.calls[0];
        expect(url.pathname).toBe('/internal/app-runtime/v1/runs/authorize');
        expect(options.headers.Authorization).toBe(`Bearer ${TEST_TOKEN}`);

        const unavailable = jest.fn().mockRejectedValue(new Error(
            'connect ECONNREFUSED secret-internal-host.example'
        ));
        await expect(runApplication({
            source,
            expectedSourceSha256: sourceSha256(source),
            input: {},
            gatewayBaseUrl: GATEWAY_BASE_URL,
            runToken: TEST_TOKEN,
            fetchImpl: unavailable,
        })).rejects.toMatchObject({
            code: 'APP_RUNTIME_GATEWAY_UNAVAILABLE',
            message: 'Gateway request failed.',
        });
        expect(unavailable).toHaveBeenCalledTimes(1);
    });
});
