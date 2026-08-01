'use strict';

const DEFAULT_TIMEOUT_MS = 12000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const DRY_RUN_INPUT = Object.freeze({ today: '2026-07-31' });
const SANDBOX_SEED = 'app-studio-builder-v1';

class AppBuilderDryRunError extends Error {
    constructor(code, message, stage = 'dry_run') {
        super(message);
        this.name = 'AppBuilderDryRunError';
        this.code = code;
        this.stage = stage;
        this.httpStatus = 422;
    }
}

function timeoutMs() {
    const parsed = Number.parseInt(process.env.APP_BUILDER_DRY_RUN_TIMEOUT_MS || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function runnerConfigurationIssue() {
    if (!String(process.env.APP_RUNNER_BASE_URL || '').trim()) {
        return 'App runner service URL is not configured.';
    }
    try {
        runnerBaseUrl();
    } catch (_error) {
        return 'App runner service URL configuration is invalid.';
    }
    if (!String(process.env.APP_RUNNER_SERVICE_TOKEN || '').trim()) {
        return 'App runner service authentication is not configured.';
    }
    return null;
}

function runnerBaseUrl() {
    const configured = String(process.env.APP_RUNNER_BASE_URL || '').trim();
    let url;
    try {
        url = new URL(configured);
    } catch (_error) {
        throw new AppBuilderDryRunError(
            'RUNNER_NOT_CONFIGURED',
            'APP_RUNNER_BASE_URL must be a valid HTTP(S) origin.',
            'configuration'
        );
    }
    if (!['http:', 'https:'].includes(url.protocol)
        || url.username
        || url.password
        || url.search
        || url.hash
        || (url.pathname !== '/' && url.pathname !== '')) {
        throw new AppBuilderDryRunError(
            'RUNNER_NOT_CONFIGURED',
            'APP_RUNNER_BASE_URL must be a valid HTTP(S) origin.',
            'configuration'
        );
    }
    return url.origin;
}

function runnerServiceToken() {
    const token = String(process.env.APP_RUNNER_SERVICE_TOKEN || '').trim();
    if (!token) {
        throw new AppBuilderDryRunError(
            'RUNNER_NOT_CONFIGURED',
            'APP_RUNNER_SERVICE_TOKEN is required.',
            'configuration'
        );
    }
    return token;
}

async function readBoundedJson(response) {
    let text;
    try {
        if (response.body && typeof response.body.getReader === 'function') {
            const reader = response.body.getReader();
            const chunks = [];
            let bytes = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > MAX_RESPONSE_BYTES) {
                    await reader.cancel().catch(() => {});
                    throw new AppBuilderDryRunError(
                        'RUNNER_PROTOCOL_ERROR',
                        'App runner exceeded the dry-run response limit.',
                        'runner_protocol'
                    );
                }
                chunks.push(Buffer.from(value));
            }
            text = Buffer.concat(chunks, bytes).toString('utf8');
        } else {
            text = await response.text();
            if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
                throw new AppBuilderDryRunError(
                    'RUNNER_PROTOCOL_ERROR',
                    'App runner exceeded the dry-run response limit.',
                    'runner_protocol'
                );
            }
        }
        return JSON.parse(text);
    } catch (error) {
        if (error instanceof AppBuilderDryRunError) throw error;
        throw new AppBuilderDryRunError(
            'RUNNER_PROTOCOL_ERROR',
            'App runner returned an invalid dry-run response.',
            'runner_protocol'
        );
    }
}

function parseResult(payload, status = 200) {
    if (status === 401) {
        throw new AppBuilderDryRunError(
            'RUNNER_AUTH_FAILED',
            'App runner service authentication failed.',
            'configuration'
        );
    }
    if (!payload || payload.ok !== true) {
        throw new AppBuilderDryRunError(
            typeof payload?.error?.code === 'string' ? payload.error.code : 'DRY_RUN_FAILED',
            typeof payload?.error?.message === 'string'
                ? payload.error.message
                : 'Application dry run failed.',
            typeof payload?.error?.stage === 'string' ? payload.error.stage : 'dry_run'
        );
    }
    if (!Object.prototype.hasOwnProperty.call(payload, 'result')
        || !payload.validation
        || typeof payload.validation !== 'object'
        || Array.isArray(payload.validation)
        || !payload.usage
        || typeof payload.usage !== 'object'
        || Array.isArray(payload.usage)
        || !payload.fixtures_summary
        || typeof payload.fixtures_summary !== 'object'
        || Array.isArray(payload.fixtures_summary)) {
        throw new AppBuilderDryRunError(
            'RUNNER_PROTOCOL_ERROR',
            'App runner returned an invalid dry-run result.',
            'runner_protocol'
        );
    }
    return {
        ...payload.validation,
        usage: payload.usage,
        fixtures_summary: payload.fixtures_summary,
        result: payload.result,
    };
}

async function validateAndDryRun(
    { source, expectedSourceSha256 },
    { fetchImpl = globalThis.fetch } = {}
) {
    const baseUrl = runnerBaseUrl();
    const serviceToken = runnerServiceToken();
    if (typeof fetchImpl !== 'function') {
        throw new AppBuilderDryRunError(
            'RUNNER_UNAVAILABLE',
            'App runner service is unavailable.',
            'configuration'
        );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs());
    try {
        const response = await fetchImpl(`${baseUrl}/v1/dry-run`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${serviceToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                source,
                expectedSourceSha256,
                input: DRY_RUN_INPUT,
                seed: SANDBOX_SEED,
            }),
            signal: controller.signal,
        });
        const payload = await readBoundedJson(response);
        return parseResult(payload, response.status);
    } catch (error) {
        if (error instanceof AppBuilderDryRunError) throw error;
        if (controller.signal.aborted || error?.name === 'AbortError') {
            throw new AppBuilderDryRunError(
                'DRY_RUN_TIMEOUT',
                'Application dry run exceeded the runner service timeout.'
            );
        }
        throw new AppBuilderDryRunError(
            'RUNNER_UNAVAILABLE',
            'App runner service is unavailable.',
            'configuration'
        );
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {
    DEFAULT_TIMEOUT_MS,
    DRY_RUN_INPUT,
    MAX_RESPONSE_BYTES,
    SANDBOX_SEED,
    AppBuilderDryRunError,
    parseResult,
    runnerBaseUrl,
    runnerConfigurationIssue,
    runnerServiceToken,
    validateAndDryRun,
};
