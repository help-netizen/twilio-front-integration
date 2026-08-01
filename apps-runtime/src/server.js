'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { validateAndDryRun } = require('./builderDryRun');
const { runApplication } = require('./runner');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4010;
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_BODY_BYTES = 256 * 1024;

class RunnerHttpError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'RunnerHttpError';
        this.status = status;
        this.code = code;
    }
}

function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(String(value || ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function authorizeRequest(header, expectedToken) {
    const match = /^Bearer ([^\s]+)$/.exec(String(header || ''));
    const supplied = match?.[1] || '';
    const expectedDigest = crypto.createHash('sha256').update(String(expectedToken || '')).digest();
    const suppliedDigest = crypto.createHash('sha256').update(supplied).digest();
    return Boolean(expectedToken) && Boolean(match)
        && crypto.timingSafeEqual(expectedDigest, suppliedDigest);
}

function writeJson(res, status, payload) {
    if (res.writableEnded) return;
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

async function readJsonBody(req) {
    const declaredLength = Number.parseInt(String(req.headers['content-length'] || ''), 10);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
        throw new RunnerHttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds 256 KB.');
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
            throw new RunnerHttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds 256 KB.');
        }
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
    } catch (_error) {
        throw new RunnerHttpError(400, 'INVALID_REQUEST', 'Request body must be valid JSON.');
    }
}

function validEnvelope(body, endpoint) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    if (typeof body.source !== 'string' || body.source.length === 0) return false;
    if (typeof body.expectedSourceSha256 !== 'string'
        || !/^[0-9a-f]{64}$/.test(body.expectedSourceSha256)) return false;
    if (endpoint === 'dry-run') {
        return body.fixtures && typeof body.fixtures === 'object' && !Array.isArray(body.fixtures)
            && Object.prototype.hasOwnProperty.call(body, 'input');
    }
    return typeof body.runToken === 'string' && body.runToken.length > 0
        && Object.prototype.hasOwnProperty.call(body, 'input');
}

function usageFor(error, startedAt) {
    return error?.usage || {
        wall_ms: Date.now() - startedAt,
        gateway_calls: 0,
        result_bytes: null,
        error_code: error?.code || 'APP_RUNTIME_EXECUTION_FAILED',
    };
}

function responseStatus(error) {
    if (error instanceof RunnerHttpError) return error.status;
    if (error?.code === 'APP_RUNTIME_REQUEST_TIMEOUT') return 504;
    if (error?.code === 'APP_RUNTIME_GATEWAY_CONFIG_INVALID') return 503;
    if (error?.code === 'APP_RUNTIME_GATEWAY_UNAVAILABLE') return 502;
    return 422;
}

async function withTimeout(timeoutMs, work) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new RunnerHttpError(
                504,
                'APP_RUNTIME_REQUEST_TIMEOUT',
                'Application request exceeded the host timeout.'
            ));
        }, timeoutMs);
    });
    try {
        return await Promise.race([work(controller.signal), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

function createRequestHandler({
    serviceToken = process.env.APP_RUNNER_SERVICE_TOKEN,
    gatewayBaseUrl = process.env.APP_RUNTIME_GATEWAY_BASE_URL,
    timeoutMs = positiveInteger(process.env.APP_RUNNER_REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    dryRunImpl = validateAndDryRun,
    runApplicationImpl = runApplication,
} = {}) {
    return async function requestHandler(req, res) {
        if (req.method === 'GET' && req.url === '/health') {
            writeJson(res, 200, { ok: true });
            return;
        }
        const endpoint = req.method === 'POST' && req.url === '/v1/dry-run'
            ? 'dry-run'
            : req.method === 'POST' && req.url === '/v1/run' ? 'run' : null;
        if (!endpoint) {
            writeJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Not found.' } });
            return;
        }
        if (!authorizeRequest(req.headers.authorization, serviceToken)) {
            writeJson(res, 401, {
                ok: false,
                error: { code: 'APP_RUNNER_AUTH_REQUIRED', message: 'Runner service authentication required.' },
            });
            return;
        }

        const startedAt = Date.now();
        try {
            const execution = await withTimeout(timeoutMs, async signal => {
                const body = await readJsonBody(req);
                if (!validEnvelope(body, endpoint)) {
                    throw new RunnerHttpError(400, 'INVALID_REQUEST', 'Runner request is invalid.');
                }
                if (endpoint === 'dry-run') {
                    return dryRunImpl({
                        source: body.source,
                        expectedSourceSha256: body.expectedSourceSha256,
                        input: body.input,
                        fixtures: body.fixtures,
                        signal,
                    });
                }
                if (!gatewayBaseUrl) {
                    throw new RunnerHttpError(
                        503,
                        'APP_RUNTIME_GATEWAY_CONFIG_INVALID',
                        'CRM gateway is not configured.'
                    );
                }
                let usage = null;
                try {
                    const result = await runApplicationImpl({
                        source: body.source,
                        expectedSourceSha256: body.expectedSourceSha256,
                        runToken: body.runToken,
                        input: body.input,
                        gatewayBaseUrl,
                        onUsage: value => { usage = value; },
                        signal,
                    });
                    return { result, usage };
                } catch (error) {
                    if (usage) error.usage = usage;
                    throw error;
                }
            });
            writeJson(res, 200, {
                ok: true,
                result: execution.result,
                usage: execution.usage || usageFor(null, startedAt),
            });
        } catch (error) {
            writeJson(res, responseStatus(error), {
                ok: false,
                error: {
                    code: error?.code || 'APP_RUNTIME_EXECUTION_FAILED',
                    message: String(error?.message || 'Application execution failed.').slice(0, 500),
                },
                usage: usageFor(error, startedAt),
            });
        }
    };
}

function createRunnerServer(options) {
    return http.createServer(createRequestHandler(options));
}

function start() {
    const serviceToken = String(process.env.APP_RUNNER_SERVICE_TOKEN || '').trim();
    if (!serviceToken) throw new Error('APP_RUNNER_SERVICE_TOKEN is required.');
    const host = String(process.env.APP_RUNNER_HOST || DEFAULT_HOST).trim();
    const port = positiveInteger(process.env.APP_RUNNER_PORT, DEFAULT_PORT);
    const server = createRunnerServer({ serviceToken });
    server.requestTimeout = positiveInteger(
        process.env.APP_RUNNER_REQUEST_TIMEOUT_MS,
        DEFAULT_TIMEOUT_MS
    );
    server.listen(port, host, () => {
        process.stdout.write(`apps-runtime listening on ${host}:${port}\n`);
    });
    return server;
}

if (require.main === module) {
    try {
        start();
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}

module.exports = {
    DEFAULT_HOST,
    DEFAULT_PORT,
    DEFAULT_TIMEOUT_MS,
    MAX_BODY_BYTES,
    RunnerHttpError,
    authorizeRequest,
    createRequestHandler,
    createRunnerServer,
    start,
};
