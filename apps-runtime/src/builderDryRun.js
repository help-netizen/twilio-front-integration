'use strict';

const { runApplication, sourceMatchesExpected } = require('./runner');
const { AppRunnerError } = require('./errors');
const { validateApplicationSource } = require('./builderValidator');
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
const dryRunInput = () => Object.freeze({ today: new Date().toISOString().slice(0, 10) });
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
    signal,
}) {
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
            result_bytes: null,
            error_code: mismatch.code,
        };
        throw mismatch;
    }
    const validation = await validateApplicationSource(source);
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
    };
}

module.exports = {
    dryRunInput,
    TOOL_FIXTURES,
    validateAndDryRun,
};
