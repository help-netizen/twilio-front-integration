'use strict';

const crypto = require('node:crypto');
const ivm = require('isolated-vm');
const { LIMITS } = require('./config');
const { AppRunnerError, GatewayError } = require('./errors');
const { GatewayClient, containsSecret } = require('./gatewayClient');

const NS_PER_MS = 1000000n;

const BOOTSTRAP_SOURCE = String.raw`
'use strict';
const hostCallTool = $0;
const hostData = $1;
const hostHttp = $2;
const capabilityFailure = name => {
    const error = new Error('APP_RUNTIME_CAPABILITY_DISABLED: ' + name);
    Object.defineProperties(error, {
        name: { value: 'CapabilityError', enumerable: false },
        code: { value: 'APP_RUNTIME_CAPABILITY_DISABLED', enumerable: true },
    });
    throw error;
};

const OriginalFunction = Function;
const constructorFunctions = [
    OriginalFunction,
    Object.getPrototypeOf(async function () {}).constructor,
    Object.getPrototypeOf(function* () {}).constructor,
    Object.getPrototypeOf(async function* () {}).constructor,
];
const blockedConstructor = function () {
    return capabilityFailure('dynamic code generation');
};
for (const constructorFunction of constructorFunctions) {
    Object.defineProperty(constructorFunction.prototype, 'constructor', {
        value: blockedConstructor,
        writable: false,
        enumerable: false,
        configurable: false,
    });
}

const denyGlobal = name => {
    Object.defineProperty(globalThis, name, {
        get() { return capabilityFailure(name); },
        set() { return capabilityFailure(name); },
        enumerable: false,
        configurable: false,
    });
};
for (const name of [
    'require', 'process', 'fetch', 'eval', 'Function', 'WebAssembly',
    'setTimeout', 'setInterval', 'setImmediate',
    'clearTimeout', 'clearInterval', 'clearImmediate',
]) {
    denyGlobal(name);
}
denyGlobal('constructor');

const GatewayError = class GatewayError extends Error {
    constructor(code, message, status) {
        super(message);
        Object.defineProperties(this, {
            name: { value: 'GatewayError', enumerable: false },
            code: { value: code, enumerable: true },
            status: { value: status, enumerable: true },
        });
    }
};
const callTool = async function callTool(name, args = {}) {
    const envelope = await hostCallTool.apply(undefined, [name, args], {
        arguments: { copy: true },
        result: { promise: true, copy: true },
    });
    if (!envelope || envelope.ok !== true) {
        const failure = envelope && envelope.error ? envelope.error : {};
        throw new GatewayError(
            typeof failure.code === 'string' ? failure.code : 'APP_RUNTIME_GATEWAY_ERROR',
            typeof failure.message === 'string' ? failure.message : 'Gateway call failed.',
            Number.isInteger(failure.status) ? failure.status : 502
        );
    }
    return envelope.data;
};
Object.freeze(callTool);
const callData = async function callData(operation, collection, payload) {
    const envelope = await hostData.apply(undefined, [operation, collection, payload], {
        arguments: { copy: true },
        result: { promise: true, copy: true },
    });
    if (!envelope || envelope.ok !== true) {
        const failure = envelope && envelope.error ? envelope.error : {};
        throw new GatewayError(
            typeof failure.code === 'string' ? failure.code : 'APP_RUNTIME_GATEWAY_ERROR',
            typeof failure.message === 'string' ? failure.message : 'Gateway data call failed.',
            Number.isInteger(failure.status) ? failure.status : 502
        );
    }
    return envelope.data;
};
const data = Object.freeze({
    list: Object.freeze(async function list(collection, options = {}) {
        return callData('list', collection, options);
    }),
    upsert: Object.freeze(async function upsert(collection, rows) {
        return callData('upsert', collection, rows);
    }),
    delete: Object.freeze(async function remove(collection, keys) {
        return callData('delete', collection, keys);
    }),
});
const requestHttp = async function requestHttp(connection, request) {
    const envelope = await hostHttp.apply(undefined, [connection, request], {
        arguments: { copy: true },
        result: { promise: true, copy: true },
    });
    if (!envelope || envelope.ok !== true) {
        const failure = envelope && envelope.error ? envelope.error : {};
        throw new GatewayError(
            typeof failure.code === 'string' ? failure.code : 'APP_RUNTIME_GATEWAY_ERROR',
            typeof failure.message === 'string' ? failure.message : 'Gateway HTTP call failed.',
            Number.isInteger(failure.status) ? failure.status : 502
        );
    }
    return envelope.data;
};
const http = Object.freeze({ request: Object.freeze(requestHttp) });
Object.defineProperty(globalThis, 'albusto', {
    value: Object.freeze({ callTool, data, http }),
    writable: false,
    enumerable: true,
    configurable: false,
});

const harden = (value, seen = new Set()) => {
    if ((value === null || (typeof value !== 'object' && typeof value !== 'function'))
        || seen.has(value)) return value;
    seen.add(value);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
        if ('value' in descriptor) harden(descriptor.value, seen);
        if (descriptor.get) harden(descriptor.get, seen);
        if (descriptor.set) harden(descriptor.set, seen);
    }
    return Object.freeze(value);
};
for (const name of Reflect.ownKeys(globalThis)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    if (descriptor && 'value' in descriptor && name !== 'globalThis') {
        harden(descriptor.value);
        if (descriptor.configurable || descriptor.writable) {
            Object.defineProperty(globalThis, name, {
                ...descriptor,
                writable: false,
                configurable: false,
            });
        }
    }
}
for (const constructorFunction of constructorFunctions) harden(constructorFunction);
`;

const CREATE_INVOKER_SOURCE = String.raw`
'use strict';
const namespace = $0;
const exportNames = Object.keys(namespace);
if (exportNames.length !== 1 || exportNames[0] !== 'run') {
    throw new Error('APP_RUNTIME_APP_FORMAT_INVALID: module must export only run');
}
if (Object.prototype.toString.call(namespace.run) !== '[object AsyncFunction]') {
    throw new Error('APP_RUNTIME_APP_FORMAT_INVALID: run must be an async function');
}

const deepFreeze = (value, seen = new Set()) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) deepFreeze(child, seen);
    return Object.freeze(value);
};
const utf8Length = value => {
    let bytes = 0;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code < 0x80) bytes += 1;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff
            && index + 1 < value.length
            && value.charCodeAt(index + 1) >= 0xdc00
            && value.charCodeAt(index + 1) <= 0xdfff) {
            bytes += 4;
            index += 1;
        } else bytes += 3;
    }
    return bytes;
};

return async function invoke(inputJson, maxOutputBytes) {
    const input = deepFreeze(JSON.parse(inputJson));
    const ctx = Object.freeze({
        callTool: albusto.callTool,
        data: albusto.data,
        http: albusto.http,
        input,
    });
    const value = await namespace.run(ctx);
    const outputJson = JSON.stringify(value);
    if (outputJson === undefined) {
        throw new Error('APP_RUNTIME_OUTPUT_INVALID: result is not JSON-serializable');
    }
    if (outputJson.length > maxOutputBytes || utf8Length(outputJson) > maxOutputBytes) {
        throw new Error('APP_RUNTIME_OUTPUT_TOO_LARGE: result exceeds the configured limit');
    }
    return outputJson;
};
`;

function safeMessage(error) {
    return typeof error?.message === 'string' ? error.message : String(error);
}

function normalizeExecutionError(error) {
    if (error instanceof AppRunnerError) return error;
    const message = safeMessage(error);
    if (message.includes('APP_RUNTIME_CAPABILITY_DISABLED:')) {
        return new AppRunnerError('APP_RUNTIME_CAPABILITY_DISABLED', message);
    }
    if (message.includes('APP_RUNTIME_APP_FORMAT_INVALID:')) {
        return new AppRunnerError('APP_RUNTIME_APP_FORMAT_INVALID', message);
    }
    if (message.includes('APP_RUNTIME_OUTPUT_TOO_LARGE:')) {
        return new AppRunnerError('APP_RUNTIME_OUTPUT_TOO_LARGE', message);
    }
    if (message.includes('APP_RUNTIME_OUTPUT_INVALID:')) {
        return new AppRunnerError('APP_RUNTIME_OUTPUT_INVALID', message);
    }
    if (/timed out|timeout/i.test(message)) {
        return new AppRunnerError(
            'APP_RUNTIME_CPU_LIMIT',
            'Application exceeded the CPU limit.'
        );
    }
    if (/memory limit|allocation failed|out of memory/i.test(message)) {
        return new AppRunnerError(
            'APP_RUNTIME_MEMORY_LIMIT',
            'Application exceeded the memory limit.'
        );
    }
    return new AppRunnerError('APP_RUNTIME_EXECUTION_FAILED', message);
}

function jsonInput(input, runToken) {
    let serialized;
    try {
        serialized = JSON.stringify(input === undefined ? null : input);
    } catch (_error) {
        throw new AppRunnerError(
            'APP_RUNTIME_INPUT_INVALID',
            'Application input must be JSON-serializable.'
        );
    }
    if (serialized === undefined) {
        throw new AppRunnerError(
            'APP_RUNTIME_INPUT_INVALID',
            'Application input must be JSON-serializable.'
        );
    }
    if (serialized.includes(runToken)) {
        throw new AppRunnerError(
            'APP_RUNTIME_TOKEN_EXPOSURE_BLOCKED',
            'Application input may not contain the run token.'
        );
    }
    return serialized;
}

function remainingCpuMs(isolate, baseline) {
    const elapsedNs = isolate.cpuTime - baseline;
    const elapsedMs = Number(elapsedNs / NS_PER_MS);
    return Math.max(1, LIMITS.cpuTimeoutMs - elapsedMs);
}

function sourceSha256(source) {
    return crypto.createHash('sha256').update(source, 'utf8').digest('hex');
}

function sourceMatchesExpected(source, expectedSourceSha256) {
    if (typeof expectedSourceSha256 !== 'string'
        || !/^[0-9a-f]{64}$/.test(expectedSourceSha256)) return false;
    return crypto.timingSafeEqual(
        Buffer.from(sourceSha256(source), 'hex'),
        Buffer.from(expectedSourceSha256, 'hex')
    );
}

async function runApplication({
    source,
    expectedSourceSha256,
    input,
    gatewayBaseUrl,
    runToken,
    fetchImpl,
    executionMode = 'live',
    dataHandler,
    httpHandler,
    onUsage,
    signal,
}) {
    const startedAt = Date.now();
    if (typeof runToken !== 'string' || runToken.length === 0) {
        throw new AppRunnerError(
            'APP_RUNTIME_RUN_TOKEN_REQUIRED',
            'A run token is required.'
        );
    }
    if (!['live', 'sandbox'].includes(executionMode)) {
        throw new AppRunnerError(
            'APP_RUNTIME_EXECUTION_MODE_INVALID',
            'Application execution mode is invalid.'
        );
    }
    if (typeof source !== 'string' || source.trim().length === 0) {
        throw new AppRunnerError(
            'APP_RUNTIME_APP_FORMAT_INVALID',
            'Application source must be a non-empty JavaScript module.'
        );
    }
    if (source.includes(runToken)) {
        throw new AppRunnerError(
            'APP_RUNTIME_TOKEN_EXPOSURE_BLOCKED',
            'Application source may not contain the run token.'
        );
    }
    if (typeof expectedSourceSha256 !== 'string'
        || !/^[0-9a-f]{64}$/.test(expectedSourceSha256)) {
        throw new AppRunnerError(
            'APP_RUNTIME_SOURCE_HASH_REQUIRED',
            'An approved source SHA-256 is required.'
        );
    }
    const inputJson = jsonInput(input, runToken);
    const gateway = new GatewayClient({
        baseUrl: gatewayBaseUrl,
        runToken,
        fetchImpl,
    });
    const sandboxDataHandler = typeof dataHandler === 'function'
        ? dataHandler
        : async () => {
            throw new GatewayError(
                'APP_DATA_INVALID',
                'No data collections are declared by the dry-run artifact.',
                422
            );
        };
    const sandboxHttpHandler = typeof httpHandler === 'function'
        ? httpHandler
        : async (connection, request) => ({
            status: 200,
            body: {
                sandbox_echo: {
                    connection,
                    method: request?.method,
                    path: request?.path,
                },
            },
        });
    if (!sourceMatchesExpected(source, expectedSourceSha256)) {
        const mismatch = new AppRunnerError(
            'APP_RUNTIME_SOURCE_MISMATCH',
            'Application source does not match the approved artifact.'
        );
        const usage = {
            wall_ms: Date.now() - startedAt,
            gateway_calls: 0,
            data_calls: 0,
            egress_calls: 0,
            result_bytes: null,
            error_code: mismatch.code,
        };
        if (typeof onUsage === 'function') onUsage(usage);
        throw mismatch;
    }
    if (executionMode === 'live') {
        try {
            await gateway.authorizeRunSource(expectedSourceSha256, signal);
        } catch (error) {
            const usage = {
                wall_ms: Date.now() - startedAt,
                gateway_calls: 0,
                data_calls: 0,
                egress_calls: 0,
                result_bytes: null,
                error_code: error?.code || 'APP_RUNTIME_AUTHORIZATION_FAILED',
            };
            if (typeof onUsage === 'function') onUsage(usage);
            throw error;
        }
    }
    const isolate = new ivm.Isolate({ memoryLimit: LIMITS.memoryMb });
    const controllers = new Set();
    let gatewayCalls = 0;
    let dataCalls = 0;
    let egressCalls = 0;
    let terminationError = null;
    let applicationCpuBaseline = null;
    let resultBytes = null;
    let completionErrorCode = null;

    const terminate = error => {
        if (!terminationError) terminationError = error;
        for (const controller of controllers) controller.abort();
        controllers.clear();
        if (!isolate.isDisposed) isolate.dispose();
    };
    const abortExecution = () => terminate(new AppRunnerError(
        'APP_RUNTIME_REQUEST_TIMEOUT',
        'Application request exceeded the host timeout.'
    ));
    if (signal?.aborted) abortExecution();
    else signal?.addEventListener('abort', abortExecution, { once: true });

    try {
        if (terminationError) throw terminationError;
        const context = await isolate.createContext();
        const callback = new ivm.Reference(async (toolName, args) => {
            if (applicationCpuBaseline !== null
                && isolate.cpuTime - applicationCpuBaseline
                    >= BigInt(LIMITS.cpuTimeoutMs) * NS_PER_MS) {
                terminate(new AppRunnerError(
                    'APP_RUNTIME_CPU_LIMIT',
                    'Application exceeded the CPU limit.'
                ));
                return { ok: false };
            }
            if (gatewayCalls >= LIMITS.gatewayCallLimit) {
                terminate(new AppRunnerError(
                    'APP_RUNTIME_GATEWAY_CALL_LIMIT',
                    'Application exceeded the gateway call limit.'
                ));
                return { ok: false };
            }
            gatewayCalls += 1;

            const controller = new AbortController();
            controllers.add(controller);
            try {
                const data = await gateway.callTool(toolName, args, controller.signal);
                if (containsSecret(data, runToken)) {
                    terminate(new AppRunnerError(
                        'APP_RUNTIME_TOKEN_EXPOSURE_BLOCKED',
                        'Gateway response was blocked by secret hygiene.'
                    ));
                    return { ok: false };
                }
                return { ok: true, data };
            } catch (error) {
                if (error instanceof AppRunnerError) {
                    terminate(error);
                    return { ok: false };
                }
                const failure = error instanceof GatewayError
                    ? error
                    : new GatewayError(
                        'APP_RUNTIME_GATEWAY_UNAVAILABLE',
                        'Gateway call failed.',
                        502
                    );
                return {
                    ok: false,
                    error: {
                        code: failure.code,
                        message: failure.message,
                        status: failure.httpStatus,
                    },
                };
            } finally {
                controllers.delete(controller);
            }
        });

        const dataCallback = new ivm.Reference(async (operation, collection, payload) => {
            if (applicationCpuBaseline !== null
                && isolate.cpuTime - applicationCpuBaseline
                    >= BigInt(LIMITS.cpuTimeoutMs) * NS_PER_MS) {
                terminate(new AppRunnerError(
                    'APP_RUNTIME_CPU_LIMIT',
                    'Application exceeded the CPU limit.'
                ));
                return { ok: false };
            }
            if (dataCalls >= LIMITS.dataCallLimit) {
                return {
                    ok: false,
                    error: {
                        code: 'DATA_CALL_LIMIT',
                        message: 'Data call limit of 10 reached.',
                        status: 429,
                    },
                };
            }
            dataCalls += 1;
            const controller = new AbortController();
            controllers.add(controller);
            try {
                const value = executionMode === 'sandbox'
                    ? await sandboxDataHandler(operation, collection, payload)
                    : await gateway.callData(operation, collection, payload, controller.signal);
                if (containsSecret(value, runToken)) {
                    terminate(new AppRunnerError(
                        'APP_RUNTIME_TOKEN_EXPOSURE_BLOCKED',
                        'Gateway response was blocked by secret hygiene.'
                    ));
                    return { ok: false };
                }
                return { ok: true, data: value };
            } catch (error) {
                if (error instanceof AppRunnerError) {
                    terminate(error);
                    return { ok: false };
                }
                const failure = error instanceof GatewayError
                    ? error
                    : new GatewayError(
                        'APP_RUNTIME_GATEWAY_UNAVAILABLE',
                        'Gateway data call failed.',
                        502
                    );
                return {
                    ok: false,
                    error: {
                        code: failure.code,
                        message: failure.message,
                        status: failure.httpStatus,
                    },
                };
            } finally {
                controllers.delete(controller);
            }
        });

        const httpCallback = new ivm.Reference(async (connection, request) => {
            if (applicationCpuBaseline !== null
                && isolate.cpuTime - applicationCpuBaseline
                    >= BigInt(LIMITS.cpuTimeoutMs) * NS_PER_MS) {
                terminate(new AppRunnerError(
                    'APP_RUNTIME_CPU_LIMIT',
                    'Application exceeded the CPU limit.'
                ));
                return { ok: false };
            }
            if (egressCalls >= LIMITS.egressCallLimit) {
                return {
                    ok: false,
                    error: {
                        code: 'EGRESS_CALL_LIMIT',
                        message: 'Egress call limit of 5 reached.',
                        status: 429,
                    },
                };
            }
            egressCalls += 1;
            const controller = new AbortController();
            controllers.add(controller);
            try {
                const value = executionMode === 'sandbox'
                    ? await sandboxHttpHandler(connection, request)
                    : await gateway.callHttp(connection, request, controller.signal);
                if (containsSecret(value, runToken)) {
                    terminate(new AppRunnerError(
                        'APP_RUNTIME_TOKEN_EXPOSURE_BLOCKED',
                        'Gateway response was blocked by secret hygiene.'
                    ));
                    return { ok: false };
                }
                return { ok: true, data: value };
            } catch (error) {
                if (error instanceof AppRunnerError) {
                    terminate(error);
                    return { ok: false };
                }
                const failure = error instanceof GatewayError
                    ? error
                    : new GatewayError(
                        'APP_RUNTIME_GATEWAY_UNAVAILABLE',
                        'Gateway HTTP call failed.',
                        502
                    );
                return {
                    ok: false,
                    error: {
                        code: failure.code,
                        message: failure.message,
                        status: failure.httpStatus,
                    },
                };
            } finally {
                controllers.delete(controller);
            }
        });

        await context.evalClosure(BOOTSTRAP_SOURCE, [callback, dataCallback, httpCallback], {
            timeout: LIMITS.cpuTimeoutMs,
        });

        const module = await isolate.compileModule(source, {
            filename: 'app://source/app.js',
        });
        if (module.dependencySpecifiers.length > 0) {
            throw new AppRunnerError(
                'APP_RUNTIME_APP_FORMAT_INVALID',
                'Application modules may not import dependencies.'
            );
        }

        applicationCpuBaseline = isolate.cpuTime;
        await module.instantiate(context, () => {
            throw new AppRunnerError(
                'APP_RUNTIME_APP_FORMAT_INVALID',
                'Application modules may not import dependencies.'
            );
        });
        await module.evaluate({ timeout: LIMITS.cpuTimeoutMs });

        const invoker = await context.evalClosure(
            CREATE_INVOKER_SOURCE,
            [module.namespace.derefInto()],
            {
                timeout: remainingCpuMs(isolate, applicationCpuBaseline),
                result: { reference: true },
            }
        );
        const outputJson = await invoker.apply(undefined, [inputJson, LIMITS.maxOutputBytes], {
            timeout: remainingCpuMs(isolate, applicationCpuBaseline),
            arguments: { copy: true },
            result: { promise: true, copy: true },
        });
        if (isolate.cpuTime - applicationCpuBaseline
            > BigInt(LIMITS.cpuTimeoutMs) * NS_PER_MS) {
            terminate(new AppRunnerError(
                'APP_RUNTIME_CPU_LIMIT',
                'Application exceeded the CPU limit.'
            ));
            throw terminationError;
        }
        resultBytes = Buffer.byteLength(outputJson, 'utf8');
        return JSON.parse(outputJson);
    } catch (error) {
        if (terminationError) {
            completionErrorCode = terminationError.code;
            throw terminationError;
        }
        const normalized = normalizeExecutionError(error);
        completionErrorCode = normalized.code;
        if (normalized.code === 'APP_RUNTIME_CPU_LIMIT'
            || normalized.code === 'APP_RUNTIME_MEMORY_LIMIT') {
            terminate(normalized);
        }
        throw normalized;
    } finally {
        signal?.removeEventListener('abort', abortExecution);
        for (const controller of controllers) controller.abort();
        controllers.clear();
        if (!isolate.isDisposed) isolate.dispose();
        const usage = {
            wall_ms: Date.now() - startedAt,
            gateway_calls: gatewayCalls,
            data_calls: dataCalls,
            egress_calls: egressCalls,
            result_bytes: resultBytes,
            error_code: completionErrorCode,
        };
        if (typeof onUsage === 'function') onUsage(usage);
        if (executionMode === 'live') {
            await gateway.recordRunCompletion(usage);
        }
    }
}

module.exports = {
    runApplication,
    normalizeExecutionError,
    sourceSha256,
    sourceMatchesExpected,
};
