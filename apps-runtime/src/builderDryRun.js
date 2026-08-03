'use strict';

const { runApplication, sourceMatchesExpected } = require('./runner');
const { AppRunnerError } = require('./errors');
const { validateApplicationSource } = require('./builderValidator');
const { createDryRunDataStore } = require('./dataCollections');
const {
    DEFAULT_SANDBOX_SEED,
    SandboxFixtureError,
    generateSandboxFixtures,
    projectSandboxTool,
    summarizeSandboxFixtures,
} = require('./sandboxFixtures');

// The sandbox is anchored to the real current day, so the dry-run input must be
// too: a frozen 'today' made every date-aware app test against a day the
// fixtures no longer contain and report zero while the code was correct.
const ACTION_ID_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const DRY_RUN_EVENT_TYPES = Object.freeze([
    'estimate.approved',
    'job.status_changed',
    'lead.created',
    'payment.recorded',
    'invoice.sent',
]);
const DRY_RUN_EVENT_TYPE_SET = new Set(DRY_RUN_EVENT_TYPES);
const MAX_EVENT_PAYLOAD_BYTES = 8 * 1024;
const dryRunInput = (action, event) => Object.freeze({
    today: new Date().toISOString().slice(0, 10),
    ...(action ? { action: Object.freeze({ ...action }) } : {}),
    ...(event ? { event: Object.freeze({ ...event }) } : {}),
});
const DRY_RUN_TOKEN = 'app-builder-dry-run-host-token-0000000000000000';
const DRY_RUN_GATEWAY = 'https://app-builder-fixtures.albusto.invalid';
const defaultFixtureGraph = () => generateSandboxFixtures(DEFAULT_SANDBOX_SEED);
const TOOL_FIXTURES = Object.freeze({
    'svc.list_jobs': projectSandboxTool(defaultFixtureGraph(), 'svc.list_jobs'),
    'svc.get_job': projectSandboxTool(defaultFixtureGraph(), 'svc.get_job', {
        job_id: defaultFixtureGraph().jobs[0].id,
    }),
    'svc.list_tasks': projectSandboxTool(defaultFixtureGraph(), 'svc.list_tasks'),
    'svc.list_estimates': projectSandboxTool(defaultFixtureGraph(), 'svc.list_estimates'),
    'svc.get_estimate': projectSandboxTool(defaultFixtureGraph(), 'svc.get_estimate', {
        estimate_id: defaultFixtureGraph().estimates[0].id,
    }),
});

function validDryRunInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    const keys = Object.keys(input);
    if (keys.some(key => key !== 'today' && key !== 'action' && key !== 'event')) return false;
    if (typeof input.today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.today)) return false;
    if (input.action !== undefined) {
        const action = input.action;
        if (!(Boolean(action)
            && typeof action === 'object'
            && !Array.isArray(action)
            && Object.keys(action).length === 2
            && typeof action.id === 'string'
            && ACTION_ID_PATTERN.test(action.id)
            && typeof action.row_key === 'string'
            && action.row_key.trim().length > 0
            && Array.from(action.row_key).length <= 256
            && Object.prototype.hasOwnProperty.call(action, 'id')
            && Object.prototype.hasOwnProperty.call(action, 'row_key'))) return false;
    }
    if (input.event !== undefined) {
        const event = input.event;
        if (!event || typeof event !== 'object' || Array.isArray(event)
            || Object.keys(event).length !== 2
            || !Object.prototype.hasOwnProperty.call(event, 'type')
            || !Object.prototype.hasOwnProperty.call(event, 'payload')
            || typeof event.type !== 'string'
            || !DRY_RUN_EVENT_TYPE_SET.has(event.type)
            || !event.payload
            || typeof event.payload !== 'object'
            || Array.isArray(event.payload)) return false;
        let encoded;
        try {
            encoded = JSON.stringify(event.payload);
        } catch (_error) {
            return false;
        }
        if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_EVENT_PAYLOAD_BYTES) {
            return false;
        }
    }
    return true;
}

function isFixtureGraph(fixtures) {
    return fixtures && Array.isArray(fixtures.jobs) && Array.isArray(fixtures.tasks);
}

function fixtureResponse(toolName, args, fixtures) {
    try {
        const data = isFixtureGraph(fixtures)
            ? projectSandboxTool(fixtures, toolName, args)
            : fixtures[toolName];
        if (!data) throw new SandboxFixtureError('TOOL_NOT_FOUND', 'Tool not found.', 404);
        const payload = { ok: true, data, request_id: 'app-builder-dry-run' };
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(payload),
        };
    } catch (error) {
        const payload = {
            ok: false,
            code: error?.code || 'DRY_RUN_FIXTURE_ERROR',
            message: String(error?.message || 'Sandbox fixture projection failed.'),
        };
        return {
            ok: false,
            status: Number(error?.httpStatus) || 500,
            text: async () => JSON.stringify(payload),
        };
    }
}

async function validateAndDryRun({
    source,
    expectedSourceSha256,
    input = dryRunInput(),
    fixtures,
    seed = DEFAULT_SANDBOX_SEED,
    anchor = null,
    data_collections = [],
    signal,
}) {
    if (!validDryRunInput(input)) {
        const error = new Error('Dry-run input is invalid.');
        error.code = 'DRY_RUN_INPUT_INVALID';
        throw error;
    }
    if (typeof expectedSourceSha256 !== 'string'
        || !/^[0-9a-f]{64}$/.test(expectedSourceSha256)) {
        throw new AppRunnerError(
            'APP_RUNTIME_SOURCE_HASH_REQUIRED',
            'An approved source SHA-256 is required.'
        );
    }
    if (!sourceMatchesExpected(source, expectedSourceSha256)) {
        const mismatch = new AppRunnerError(
            'APP_RUNTIME_SOURCE_MISMATCH',
            'Application source does not match the approved artifact.'
        );
        mismatch.usage = {
            wall_ms: 0,
            gateway_calls: 0,
            data_calls: 0,
            result_bytes: null,
            error_code: mismatch.code,
        };
        throw mismatch;
    }
    const validation = await validateApplicationSource(source);
    const dataStore = createDryRunDataStore(data_collections);
    const activeFixtures = fixtures === undefined
        ? generateSandboxFixtures(seed, anchor)
        : fixtures;
    if (!activeFixtures || typeof activeFixtures !== 'object' || Array.isArray(activeFixtures)) {
        const error = new Error('Dry-run fixtures must be an object.');
        error.code = 'DRY_RUN_FIXTURES_INVALID';
        throw error;
    }
    let usage = null;
    let result;
    try {
        result = await runApplication({
            source,
            expectedSourceSha256,
            input,
            gatewayBaseUrl: DRY_RUN_GATEWAY,
            runToken: DRY_RUN_TOKEN,
            executionMode: 'sandbox',
            fetchImpl: async (url, options) => {
                let args;
                try {
                    args = JSON.parse(options.body);
                } catch (_error) {
                    args = {};
                }
                return fixtureResponse(
                    decodeURIComponent(url.pathname.split('/').pop()),
                    args,
                    activeFixtures
                );
            },
            onUsage: value => { usage = value; },
            dataHandler: dataStore.handle,
            signal,
        });
    } catch (error) {
        if (usage) error.usage = usage;
        throw error;
    }
    return {
        result,
        validation: {
            source_bytes: validation.sourceBytes,
            tools: [...validation.tools],
            entry_point: validation.entryPoint,
            returned_type: result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result,
        },
        usage,
        fixturesSummary: summarizeSandboxFixtures(activeFixtures),
        dataOps: dataStore.report(),
    };
}

module.exports = {
    DRY_RUN_EVENT_TYPES,
    MAX_EVENT_PAYLOAD_BYTES,
    dryRunInput,
    TOOL_FIXTURES,
    validDryRunInput,
    validateAndDryRun,
};
