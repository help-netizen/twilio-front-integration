'use strict';

const { runApplication, sourceMatchesExpected } = require('./runner');
const { AppRunnerError } = require('./errors');
const { validateApplicationSource } = require('./builderValidator');
const { createDryRunDataStore } = require('./dataCollections');
const {
    DEFAULT_SANDBOX_SEED,
    SandboxFixtureError,
    companyDateFilterBounds,
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
    'svc.create_task': { task_id: 1, status: 'open' },
    'svc.list_estimates': projectSandboxTool(defaultFixtureGraph(), 'svc.list_estimates'),
    'svc.get_estimate': projectSandboxTool(defaultFixtureGraph(), 'svc.get_estimate', {
        estimate_id: defaultFixtureGraph().estimates[0].id,
    }),
});

const CREATE_TASK_PARENT_COLLECTIONS = Object.freeze({
    job: 'jobs',
    lead: 'leads',
    estimate: 'estimates',
    invoice: 'invoices',
    contact: 'contacts',
});
const DRY_RUN_WRITE_CALL_LIMIT = 3;

function validIsoDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validIsoDateTime(value) {
    return typeof value === 'string'
        && /[tT]/.test(value)
        && /(Z|[+-]\d{2}:\d{2})$/.test(value)
        && Number.isFinite(Date.parse(value));
}

function createDryRunTaskStore(fixtures) {
    const created = [];
    let writeCalls = 0;
    const fixtureIds = isFixtureGraph(fixtures)
        ? fixtures.tasks.map(task => Number(task.id)).filter(Number.isFinite)
        : [];
    const firstTaskId = (fixtureIds.length ? Math.max(...fixtureIds) : 0) + 1;

    function validateArgs(args) {
        if (!args || typeof args !== 'object' || Array.isArray(args)
            || Object.keys(args).some(key => ![
                'parent_type', 'parent_id', 'description', 'due_at',
            ].includes(key))
            || !Object.prototype.hasOwnProperty.call(CREATE_TASK_PARENT_COLLECTIONS, args.parent_type)
            || !Number.isSafeInteger(args.parent_id)
            || args.parent_id < 1
            || typeof args.description !== 'string'
            || !args.description.trim()
            || args.description.trim().length > 500
            || (args.due_at !== undefined
                && !validIsoDate(args.due_at)
                && !validIsoDateTime(args.due_at))) {
            throw new SandboxFixtureError(
                'INVALID_ARGUMENTS',
                'Tool arguments are invalid.',
                422
            );
        }
    }

    function create(args) {
        writeCalls += 1;
        if (writeCalls > DRY_RUN_WRITE_CALL_LIMIT) {
            throw new SandboxFixtureError(
                'WRITE_CALL_LIMIT',
                'Write call limit of 3 reached.',
                429
            );
        }
        validateArgs(args);
        const collection = fixtures?.[CREATE_TASK_PARENT_COLLECTIONS[args.parent_type]];
        if (!Array.isArray(collection)
            || !collection.some(parent => Number(parent.id) === args.parent_id)) {
            throw new SandboxFixtureError('NOT_FOUND', 'Resource not found.', 404);
        }
        const description = args.description.trim();
        const existing = created.find(task => (
            task.parent_type === args.parent_type
            && task.parent_id === args.parent_id
            && task.description === description
        ));
        if (existing) {
            return { task_id: existing.task_id, status: 'open', deduplicated: true };
        }
        const dueAt = args.due_at === undefined
            ? null
            : validIsoDate(args.due_at)
                ? companyDateFilterBounds(
                    args.due_at,
                    null,
                    fixtures.company?.timezone
                ).fromInclusive
                : new Date(args.due_at).toISOString();
        const task = {
            task_id: firstTaskId + created.length,
            status: 'open',
            parent_type: args.parent_type,
            parent_id: args.parent_id,
            description,
            due_at: dueAt,
        };
        created.push(task);
        return { task_id: task.task_id, status: 'open' };
    }

    function fixturesWithCreatedTasks() {
        if (!isFixtureGraph(fixtures) || created.length === 0) return fixtures;
        return {
            ...fixtures,
            tasks: [
                ...fixtures.tasks,
                ...created.map(task => ({
                    id: task.task_id,
                    company_id: fixtures.company?.id,
                    description: task.description,
                    status: task.status,
                    due_at: task.due_at,
                    completed_at: null,
                    created_at: new Date().toISOString(),
                    owner_user_id: null,
                    author_user_id: null,
                    thread_id: null,
                    kind: 'agent',
                    agent_type: 'app',
                    agent_output: null,
                    actions: [],
                    assignee_name: null,
                    assignee_email: null,
                    author_name: 'App',
                    parent_type: task.parent_type,
                    parent_id: task.parent_id,
                    parent_label: `Sandbox ${task.parent_type} #${task.parent_id}`,
                })),
            ],
        };
    }

    return {
        create,
        fixturesWithCreatedTasks,
        report: () => created.map(task => ({ ...task })),
    };
}

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

function fixtureResponse(toolName, args, fixtures, taskStore) {
    try {
        const data = toolName === 'svc.create_task'
            ? taskStore.create(args)
            : isFixtureGraph(fixtures)
                ? projectSandboxTool(taskStore.fixturesWithCreatedTasks(), toolName, args)
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
    const taskStore = createDryRunTaskStore(activeFixtures);
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
                    activeFixtures,
                    taskStore
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
        createdTasks: taskStore.report(),
    };
}

module.exports = {
    DRY_RUN_EVENT_TYPES,
    MAX_EVENT_PAYLOAD_BYTES,
    dryRunInput,
    TOOL_FIXTURES,
    validDryRunInput,
    createDryRunTaskStore,
    validateAndDryRun,
};
