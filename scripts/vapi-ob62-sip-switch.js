#!/usr/bin/env node
'use strict';

const PHONE_NUMBER_ID = 'd446b324-f016-48ba-b536-78c61652184d';
const STATIC_ASSISTANT_ID = '30e85a87-9d7e-4694-828e-1fea7d10f3ef';
const DEFAULT_ASSISTANT_REQUEST_URL =
    'https://api.albusto.com/api/vapi/call-status/assistant-request';
const REQUEST_TIMEOUT_MS = 15000;

class Ob62SwitchError extends Error {
    constructor(code, detail = '') {
        super(detail ? `${code}: ${detail}` : code);
        this.name = 'Ob62SwitchError';
        this.code = code;
    }
}

function parseArgs(argv) {
    const [operation, ...flags] = argv;
    if (!['inspect', 'switch', 'rollback'].includes(operation) || flags.some((flag) => flag !== '--apply')) {
        throw new Ob62SwitchError(
            'OB62_ARGUMENTS_INVALID',
            'usage: inspect | switch [--apply] | rollback [--apply]',
        );
    }
    if (operation === 'inspect' && flags.includes('--apply')) {
        throw new Ob62SwitchError('OB62_INSPECT_APPLY_FORBIDDEN');
    }
    return { operation, apply: flags.includes('--apply') };
}

function requireNonEmpty(value, code) {
    if (typeof value !== 'string' || value.trim() === '') throw new Ob62SwitchError(code);
    return value.trim();
}

function runtimeConfig(environment) {
    const serverUrl = requireNonEmpty(
        environment.VAPI_OB62_ASSISTANT_REQUEST_URL || DEFAULT_ASSISTANT_REQUEST_URL,
        'OB62_ASSISTANT_REQUEST_URL_REQUIRED',
    );
    let parsed;
    try {
        parsed = new URL(serverUrl);
    } catch (_error) {
        throw new Ob62SwitchError('OB62_ASSISTANT_REQUEST_URL_INVALID');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Ob62SwitchError('OB62_ASSISTANT_REQUEST_URL_INVALID');
    }
    return { serverUrl: parsed.toString() };
}

function safeReadback(value) {
    return {
        id: value?.id || null,
        name: value?.name || null,
        sipUri: value?.sipUri || null,
        assistantId: value?.assistantId ?? null,
        serverUrl: value?.server?.url || null,
        serverTimeoutSeconds: value?.server?.timeoutSeconds ?? null,
        isServerUrlSecretSet: value?.isServerUrlSecretSet === true,
        updatedAt: value?.updatedAt || null,
    };
}

function createProviderClient({ environment = process.env, fetchImpl = global.fetch } = {}) {
    const apiKey = requireNonEmpty(environment.VAPI_API_KEY, 'OB62_VAPI_API_KEY_REQUIRED');
    if (typeof fetchImpl !== 'function') throw new Ob62SwitchError('OB62_FETCH_UNAVAILABLE');

    async function request(method, body) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const response = await fetchImpl(
                `https://api.vapi.ai/phone-number/${encodeURIComponent(PHONE_NUMBER_ID)}`,
                {
                    method,
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                    },
                    body: body === undefined ? undefined : JSON.stringify(body),
                    signal: controller.signal,
                },
            );
            const raw = await response.text();
            let parsed;
            try {
                parsed = raw ? JSON.parse(raw) : null;
            } catch (_error) {
                throw new Ob62SwitchError('OB62_PROVIDER_RESPONSE_INVALID');
            }
            if (!response.ok) {
                throw new Ob62SwitchError('OB62_PROVIDER_REQUEST_FAILED', `HTTP ${response.status}`);
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
                || parsed.id !== PHONE_NUMBER_ID) {
                throw new Ob62SwitchError('OB62_PROVIDER_READBACK_INVALID');
            }
            return parsed;
        } catch (error) {
            if (error instanceof Ob62SwitchError) throw error;
            throw new Ob62SwitchError(
                'OB62_PROVIDER_UNAVAILABLE',
                error?.name === 'AbortError' ? 'timeout' : 'network error',
            );
        } finally {
            clearTimeout(timeout);
        }
    }

    return {
        get: () => request('GET'),
        patch: (body) => request('PATCH', body),
    };
}

function assertSwitchReadback(value, serverUrl) {
    if (
        value.assistantId != null
        || value.server?.url !== serverUrl
        || value.server?.timeoutSeconds !== 20
        || value.isServerUrlSecretSet !== true
    ) {
        throw new Ob62SwitchError('OB62_SWITCH_READBACK_MISMATCH');
    }
}

function assertRollbackReadback(value) {
    if (value.assistantId !== STATIC_ASSISTANT_ID || value.server?.url) {
        throw new Ob62SwitchError('OB62_ROLLBACK_READBACK_MISMATCH');
    }
}

async function run(argv, dependencies = {}) {
    const environment = dependencies.environment || process.env;
    const { operation, apply } = parseArgs(argv);
    const { serverUrl } = runtimeConfig(environment);
    const plannedBody = operation === 'switch'
        ? {
            assistantId: null,
            server: {
                url: serverUrl,
                secret: '<redacted>',
                timeoutSeconds: 20,
            },
        }
        : { assistantId: STATIC_ASSISTANT_ID, server: null };

    if (!apply && operation !== 'inspect') {
        return { mode: 'dry-run', operation, phoneNumberId: PHONE_NUMBER_ID, body: plannedBody };
    }

    const provider = dependencies.provider || createProviderClient({
        environment,
        fetchImpl: dependencies.fetchImpl,
    });
    const before = await provider.get();
    if (operation === 'inspect') {
        return { mode: 'inspect', readback: safeReadback(before) };
    }

    if (operation === 'switch') {
        if (before.assistantId != null && before.assistantId !== STATIC_ASSISTANT_ID) {
            throw new Ob62SwitchError('OB62_UNEXPECTED_STATIC_ASSISTANT');
        }
        const secret = requireNonEmpty(
            environment.VAPI_ASSISTANT_REQUEST_SECRET,
            'OB62_ASSISTANT_REQUEST_SECRET_REQUIRED',
        );
        await provider.patch({
            assistantId: null,
            server: { url: serverUrl, secret, timeoutSeconds: 20 },
        });
        const after = await provider.get();
        assertSwitchReadback(after, serverUrl);
        return {
            mode: 'applied',
            operation,
            before: safeReadback(before),
            after: safeReadback(after),
        };
    }

    await provider.patch({ assistantId: STATIC_ASSISTANT_ID, server: null });
    const after = await provider.get();
    assertRollbackReadback(after);
    return {
        mode: 'applied',
        operation,
        before: safeReadback(before),
        after: safeReadback(after),
    };
}

async function main() {
    try {
        const result = await run(process.argv.slice(2));
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
        process.stderr.write(`${error?.code || 'OB62_SWITCH_FAILED'}\n`);
        process.exitCode = 1;
    }
}

if (require.main === module) main();

module.exports = {
    PHONE_NUMBER_ID,
    STATIC_ASSISTANT_ID,
    DEFAULT_ASSISTANT_REQUEST_URL,
    Ob62SwitchError,
    parseArgs,
    safeReadback,
    assertSwitchReadback,
    assertRollbackReadback,
    run,
};
