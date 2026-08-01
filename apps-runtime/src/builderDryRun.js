'use strict';

const { runApplication } = require('./runner');
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

function fixtureResponse(toolName) {
    const data = TOOL_FIXTURES[toolName];
    if (!data) {
        return {
            ok: false,
            status: 404,
            json: async () => ({ ok: false, code: 'TOOL_NOT_FOUND', message: 'Tool not found.' }),
        };
    }
    return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, data, request_id: 'app-builder-dry-run' }),
    };
}

async function validateAndDryRun(source) {
    const validation = await validateApplicationSource(source);
    const result = await runApplication({
        source,
        input: DRY_RUN_INPUT,
        gatewayBaseUrl: DRY_RUN_GATEWAY,
        runToken: DRY_RUN_TOKEN,
        fetchImpl: async (url) => fixtureResponse(decodeURIComponent(url.pathname.split('/').pop())),
    });
    return {
        source_bytes: validation.sourceBytes,
        tools: [...validation.tools],
        entry_point: validation.entryPoint,
        returned_type: result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result,
    };
}

module.exports = {
    DRY_RUN_INPUT,
    TOOL_FIXTURES,
    validateAndDryRun,
};
