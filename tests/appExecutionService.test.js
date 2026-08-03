'use strict';

const { createAppExecutionService } = require('../backend/src/services/appExecutionService');

const COMPANY_ID = '10000000-0000-4000-8000-000000000001';
const ACTOR_ID = '20000000-0000-4000-8000-000000000001';
const VERSION_ID = '30000000-0000-4000-8000-000000000001';
const RUN_ID = '40000000-0000-4000-8000-000000000001';
const SOURCE = 'export async function run() { return { view_version: 1, title: "Safe", blocks: [] }; }';
const ORIGINAL_RUNNER_BASE_URL = process.env.APP_RUNNER_BASE_URL;
const ORIGINAL_RUNNER_SERVICE_TOKEN = process.env.APP_RUNNER_SERVICE_TOKEN;

beforeEach(() => {
    process.env.APP_RUNNER_BASE_URL = 'https://runner.albusto.test';
    process.env.APP_RUNNER_SERVICE_TOKEN = 'runner-service-test-token';
});

afterAll(() => {
    if (ORIGINAL_RUNNER_BASE_URL === undefined) delete process.env.APP_RUNNER_BASE_URL;
    else process.env.APP_RUNNER_BASE_URL = ORIGINAL_RUNNER_BASE_URL;
    if (ORIGINAL_RUNNER_SERVICE_TOKEN === undefined) delete process.env.APP_RUNNER_SERVICE_TOKEN;
    else process.env.APP_RUNNER_SERVICE_TOKEN = ORIGINAL_RUNNER_SERVICE_TOKEN;
});

function installation(overrides = {}) {
    return {
        installation_id: '91',
        company_id: COMPANY_ID,
        app_id: '81',
        latest_run_id: null,
        version_id: VERSION_ID,
        source_code: SOURCE,
        source_sha256: 'a'.repeat(64),
        allowed_tools: ['svc.list_jobs'],
        declared_actions: [{ id: 'mark_ordered', label: 'Mark ordered' }],
        ...overrides,
    };
}

function completedRun(overrides = {}) {
    return {
        run_id: RUN_ID,
        status: 'completed',
        started_at: '2026-08-01T12:00:00.000Z',
        completed_at: '2026-08-01T12:00:00.010Z',
        duration_ms: 10,
        gateway_calls: 1,
        data_calls: 0,
        result_bytes: 52,
        error_code: null,
        error_message: null,
        ...overrides,
    };
}

function clientFor({ currentRun = null } = {}) {
    const query = jest.fn(async (sql) => {
        if (/FROM marketplace_installations installation/.test(sql)
            && /JOIN app_versions version/.test(sql)) {
            return { rows: [installation()] };
        }
        if (/FROM app_runs\s+WHERE/.test(sql) && /completed_at IS NULL/.test(sql)) {
            return { rows: currentRun ? [currentRun] : [] };
        }
        if (/SELECT id AS run_id, status/.test(sql) && /FOR UPDATE/.test(sql)) {
            return { rows: [completedRun()] };
        }
        if (/UPDATE marketplace_installations installation/.test(sql)) {
            return { rows: [{ latest_run_id: RUN_ID }] };
        }
        return { rows: [] };
    });
    return { query, release: jest.fn() };
}

function databaseFor(client) {
    return {
        getClient: jest.fn().mockResolvedValue(client),
        query: jest.fn().mockResolvedValue({ rows: [{ id: RUN_ID }] }),
    };
}

function authorizationFor(value = {
    role_key: 'dispatcher',
    permissions: ['jobs.view'],
}) {
    return { resolveCompanyUserAuthz: jest.fn().mockResolvedValue(value) };
}

function runnerResponse(result) {
    const resultBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
            ok: true,
            result,
            usage: {
                wall_ms: 10,
                gateway_calls: 1,
                data_calls: 0,
                result_bytes: resultBytes,
                error_code: null,
            },
        }),
    };
}

describe('APP-VIEW-001 execution core', () => {
    test('successful manual run uses the existing token path, requires completed metering, stores the result and moves latest_run_id', async () => {
        const client = clientFor();
        const database = databaseFor(client);
        const tokens = {
            mintRunToken: jest.fn().mockResolvedValue({
                token: 'single-use-token',
                runId: RUN_ID,
                artifactSha256: 'a'.repeat(64),
            }),
        };
        const document = { view_version: 1, title: 'Safe result', blocks: [] };
        const fetchImpl = jest.fn().mockResolvedValue(runnerResponse(document));
        const service = createAppExecutionService({
            database,
            tokens,
            authorization: authorizationFor(),
            fetchImpl,
        });

        await expect(service.run({
            companyId: COMPANY_ID,
            installationId: '91',
            trigger: 'manual',
            actorId: ACTOR_ID,
        })).resolves.toMatchObject({
            run_id: RUN_ID,
            status: 'completed',
            has_result: true,
            view_document: document,
        });
        expect(tokens.mintRunToken).toHaveBeenCalledWith({
            installationId: '91',
            versionId: VERSION_ID,
        }, { client });
        const runnerBody = JSON.parse(fetchImpl.mock.calls[0][1].body);
        expect(runnerBody).toMatchObject({
            source: SOURCE,
            expectedSourceSha256: 'a'.repeat(64),
            runToken: 'single-use-token',
        });
        const sql = client.query.mock.calls.map(([statement]) => statement).join('\n');
        expect(sql).toContain('INSERT INTO app_run_results');
        expect(sql).toContain('SET latest_run_id = $3');
        expect(sql).toContain("INTERVAL '90 days'");
        expect(sql).toContain('OFFSET 50');
        expect(database.query).not.toHaveBeenCalled();
    });

    test('invalid runner output fails the audit run with a precise reason and stores no view document', async () => {
        const client = clientFor();
        const database = databaseFor(client);
        const tokens = {
            mintRunToken: jest.fn().mockResolvedValue({ token: 'token', runId: RUN_ID }),
        };
        const attack = {
            view_version: 1,
            title: 'Unsafe result',
            blocks: [{ type: 'text', text: 'Open https://evil.example/collect' }],
        };
        const service = createAppExecutionService({
            database,
            tokens,
            authorization: authorizationFor(),
            fetchImpl: jest.fn().mockResolvedValue(runnerResponse(attack)),
        });

        await expect(service.run({
            companyId: COMPANY_ID,
            installationId: '91',
            trigger: 'manual',
            actorId: ACTOR_ID,
        })).rejects.toMatchObject({
            code: 'VIEW_DOCUMENT_INVALID',
            message: expect.stringMatching(/must not contain a URL/i),
        });
        expect(client.query.mock.calls.some(([sql]) => /INSERT INTO app_run_results/.test(sql)))
            .toBe(false);
        expect(database.query).toHaveBeenCalledWith(
            expect.stringContaining("SET status = 'failed'"),
            expect.arrayContaining([
                COMPANY_ID,
                '91',
                RUN_ID,
                'VIEW_DOCUMENT_INVALID',
                expect.stringMatching(/must not contain a URL/i),
            ])
        );
    });

    test('a declared action reaches ctx.input.action and an undeclared id is refused before the runner', async () => {
        const client = clientFor();
        const tokens = {
            mintRunToken: jest.fn().mockResolvedValue({
                token: 'action-token',
                runId: RUN_ID,
            }),
        };
        const fetchImpl = jest.fn().mockResolvedValue(runnerResponse({
            view_version: 1,
            title: 'Updated',
            blocks: [],
        }));
        const service = createAppExecutionService({
            database: databaseFor(client),
            tokens,
            authorization: authorizationFor(),
            fetchImpl,
        });
        const action = { id: 'mark_ordered', row_key: 'estimate-41:part-P-41' };
        await expect(service.run({
            companyId: COMPANY_ID,
            installationId: '91',
            trigger: 'action',
            actorId: ACTOR_ID,
            action,
        })).resolves.toMatchObject({ status: 'completed' });
        expect(JSON.parse(fetchImpl.mock.calls[0][1].body).input.action).toEqual(action);

        const deniedFetch = jest.fn();
        const deniedTokens = { mintRunToken: jest.fn() };
        const deniedService = createAppExecutionService({
            database: databaseFor(clientFor()),
            tokens: deniedTokens,
            authorization: authorizationFor(),
            fetchImpl: deniedFetch,
        });
        await expect(deniedService.run({
            companyId: COMPANY_ID,
            installationId: '91',
            trigger: 'action',
            actorId: ACTOR_ID,
            action: { id: 'delete_everything', row_key: 'P-41' },
        })).rejects.toMatchObject({ code: 'ACTION_NOT_DECLARED', httpStatus: 422 });
        expect(deniedTokens.mintRunToken).not.toHaveBeenCalled();
        expect(deniedFetch).not.toHaveBeenCalled();
    });

    test('a second request during the first run returns that in-flight run and never mints a rival', async () => {
        let activeRun = null;
        let releaseRunner;
        let runnerStarted;
        const runnerStartedPromise = new Promise(resolve => { runnerStarted = resolve; });
        const runnerPending = new Promise(resolve => { releaseRunner = resolve; });
        const client = clientFor();
        client.query.mockImplementation(async (sql) => {
            if (/FROM marketplace_installations installation/.test(sql)
                && /JOIN app_versions version/.test(sql)) {
                return { rows: [installation()] };
            }
            if (/FROM app_runs\s+WHERE/.test(sql) && /completed_at IS NULL/.test(sql)) {
                return { rows: activeRun ? [activeRun] : [] };
            }
            if (/SELECT id AS run_id, status/.test(sql) && /FOR UPDATE/.test(sql)) {
                return { rows: [completedRun()] };
            }
            if (/UPDATE marketplace_installations installation/.test(sql)) {
                return { rows: [{ latest_run_id: RUN_ID }] };
            }
            return { rows: [] };
        });
        const tokens = {
            mintRunToken: jest.fn().mockImplementation(async () => {
                activeRun = {
                    run_id: RUN_ID,
                    status: 'issued',
                    started_at: '2026-08-01T12:00:00.000Z',
                    completed_at: null,
                    duration_ms: null,
                    gateway_calls: 0,
                    data_calls: 0,
                    result_bytes: null,
                    error_code: null,
                    error_message: null,
                    has_result: false,
                };
                return { token: 'one-token', runId: RUN_ID };
            }),
        };
        const document = { view_version: 1, title: 'Finished', blocks: [] };
        const fetchImpl = jest.fn().mockImplementation(async () => {
            runnerStarted();
            await runnerPending;
            activeRun = null;
            return runnerResponse(document);
        });
        const service = createAppExecutionService({
            database: databaseFor(client),
            tokens,
            authorization: authorizationFor(),
            fetchImpl,
        });
        const scheduleInput = {
            companyId: COMPANY_ID,
            installationId: '91',
            trigger: 'schedule',
            actorId: ACTOR_ID,
        };

        const first = service.run(scheduleInput);
        await runnerStartedPromise;
        await expect(service.run({
            ...scheduleInput,
            trigger: 'action',
            action: { id: 'mark_ordered', row_key: 'P-41' },
        })).resolves.toMatchObject({
            run_id: RUN_ID,
            status: 'running',
        });
        expect(tokens.mintRunToken).toHaveBeenCalledTimes(1);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        releaseRunner();
        await expect(first).resolves.toMatchObject({ run_id: RUN_ID, status: 'completed' });
    });

    test('live viewer permissions fail closed, including admin-only apps with no declared tools', async () => {
        const client = { query: jest.fn(), release: jest.fn() };
        for (const roleKey of ['tenant_admin', 'manager', 'dispatcher', 'provider', 'custom']) {
            const deniedService = createAppExecutionService({
                database: databaseFor(client),
                authorization: authorizationFor({ role_key: roleKey, permissions: [] }),
            });
            await expect(deniedService.requireViewerAccess(
                installation({ allowed_tools: ['svc.list_jobs'] }),
                ACTOR_ID,
                client
            )).rejects.toMatchObject({ code: 'ACCESS_DENIED', httpStatus: 403 });
        }
        const nonAdminService = createAppExecutionService({
            database: databaseFor(client),
            authorization: authorizationFor({ role_key: 'dispatcher', permissions: [] }),
        });
        await expect(nonAdminService.requireViewerAccess(
            installation({ allowed_tools: [] }),
            ACTOR_ID,
            client
        )).rejects.toMatchObject({ code: 'ACCESS_DENIED', httpStatus: 403 });

        const adminService = createAppExecutionService({
            database: databaseFor(client),
            authorization: authorizationFor({ role_key: 'tenant_admin', permissions: [] }),
        });
        await expect(adminService.requireViewerAccess(
            installation({ allowed_tools: [] }),
            ACTOR_ID,
            client
        )).resolves.toMatchObject({ role_key: 'tenant_admin' });
    });

    test('an action run fails the live viewer gate before minting or runner access', async () => {
        const tokens = { mintRunToken: jest.fn() };
        const fetchImpl = jest.fn();
        const service = createAppExecutionService({
            database: databaseFor(clientFor()),
            tokens,
            authorization: authorizationFor({ role_key: 'provider', permissions: [] }),
            fetchImpl,
        });
        await expect(service.run({
            companyId: COMPANY_ID,
            installationId: '91',
            trigger: 'action',
            actorId: ACTOR_ID,
            action: { id: 'mark_ordered', row_key: 'P-41' },
        })).rejects.toMatchObject({ code: 'ACCESS_DENIED', httpStatus: 403 });
        expect(tokens.mintRunToken).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
