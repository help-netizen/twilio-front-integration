'use strict';

const { runApplication, sourceMatchesExpected } = require('./runner');
const { AppRunnerError } = require('./errors');
const { validateApplicationSource } = require('./builderValidator');

const DRY_RUN_INPUT = Object.freeze({ today: '2026-07-31' });
const DRY_RUN_TOKEN = 'app-builder-dry-run-host-token-0000000000000000';
const DRY_RUN_GATEWAY = 'https://app-builder-fixtures.albusto.invalid';
const TOOL_FIXTURES = Object.freeze({
    'svc.list_jobs': Object.freeze({
        results: Object.freeze([Object.freeze({
            id: 101,
            job_number: 'TEST-101',
            service_name: 'Fixture inspection',
            status: 'scheduled',
            scheduled_start: '2026-07-31T09:00:00-04:00',
        })]),
        total: 1,
    }),
    'svc.get_job': Object.freeze({
        id: 101,
        job_number: 'TEST-101',
        service_name: 'Fixture inspection',
        status: 'scheduled',
    }),
    'svc.list_tasks': Object.freeze({
        tasks: Object.freeze([Object.freeze({
            id: 201,
            title: 'Fixture follow-up',
            status: 'open',
            due_at: '2026-07-31T16:00:00Z',
        })]),
        total: 1,
    }),
});

function fixtureResponse(toolName, fixtures) {
    const data = fixtures[toolName];
    if (!data) {
        const payload = { ok: false, code: 'TOOL_NOT_FOUND', message: 'Tool not found.' };
        return {
            ok: false,
            status: 404,
            text: async () => JSON.stringify(payload),
        };
    }
    const payload = { ok: true, data, request_id: 'app-builder-dry-run' };
    return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload),
    };
}

async function validateAndDryRun({
    source,
    expectedSourceSha256,
    input = DRY_RUN_INPUT,
    fixtures = TOOL_FIXTURES,
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
    if (!fixtures || typeof fixtures !== 'object' || Array.isArray(fixtures)) {
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
            fetchImpl: async (url) => fixtureResponse(
                decodeURIComponent(url.pathname.split('/').pop()),
                fixtures
            ),
            reportRunUsage: false,
            onUsage: value => { usage = value; },
            signal,
        });
    } catch (error) {
        if (usage) error.usage = usage;
        throw error;
    }
    return {
        result: {
            source_bytes: validation.sourceBytes,
            tools: [...validation.tools],
            entry_point: validation.entryPoint,
            returned_type: result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result,
        },
        usage,
    };
}

module.exports = {
    DRY_RUN_INPUT,
    TOOL_FIXTURES,
    validateAndDryRun,
};
