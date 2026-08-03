'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const COMPANY_ID = '10000000-0000-4000-8000-000000000001';
const VERSION_ID = '20000000-0000-4000-8000-000000000001';
const RUN_ID = '30000000-0000-4000-8000-000000000001';
const AGENT_ID = '40000000-0000-4000-8000-000000000001';
const DELEGATOR_ID = '50000000-0000-4000-8000-000000000001';
const ALL_TOOLS = [
    'svc.list_jobs',
    'svc.get_job',
    'svc.list_tasks',
    'svc.create_task',
    'svc.list_estimates',
    'svc.get_estimate',
];

const mockTokenService = {
    verifyRunToken: jest.fn(),
    resolveRunContext: jest.fn(),
    authorizeRunExecution: jest.fn(),
    consumeRunCall: jest.fn(),
    consumeRunDataCall: jest.fn(),
    consumeRunWriteCall: jest.fn(),
    validateRunMetrics: jest.fn(),
    recordRunCompletion: jest.fn(),
};
const mockReadExecute = jest.fn();
const mockResolveCompanyUserAuthz = jest.fn();
const mockAuditRecord = jest.fn();
const mockAuthorizationAuditRecord = jest.fn();
const mockGetMaskViewer = jest.fn();
const mockConsumeInstallation = jest.fn();
const mockDataList = jest.fn();
const mockDataUpsert = jest.fn();
const mockDataRemove = jest.fn();
const mockCreateTask = jest.fn();

jest.mock('../backend/src/services/appRuntimeTokenService', () => ({
    verifyRunToken: mockTokenService.verifyRunToken,
    resolveRunContext: mockTokenService.resolveRunContext,
    authorizeRunExecution: mockTokenService.authorizeRunExecution,
    consumeRunCall: mockTokenService.consumeRunCall,
    consumeRunDataCall: mockTokenService.consumeRunDataCall,
    consumeRunWriteCall: mockTokenService.consumeRunWriteCall,
    validateRunMetrics: mockTokenService.validateRunMetrics,
    recordRunCompletion: mockTokenService.recordRunCompletion,
    parseConsent: (metadata) => {
        const runtime = metadata?.app_runtime;
        return runtime && Array.isArray(runtime.consented_tools)
            ? { versionId: runtime.version_id, tools: new Set(runtime.consented_tools) }
            : null;
    },
}));
jest.mock('../backend/src/services/appDataService', () => ({
    list: mockDataList,
    upsert: mockDataUpsert,
    remove: mockDataRemove,
}));
jest.mock('../backend/src/services/chatgptMcpReadService', () => ({
    execute: mockReadExecute,
}));
jest.mock('../backend/src/services/appRuntimeTaskService', () => ({
    createTask: mockCreateTask,
}));
jest.mock('../backend/src/services/authorizationService', () => ({
    resolveCompanyUserAuthz: mockResolveCompanyUserAuthz,
}));
jest.mock('../backend/src/services/appRuntimeAuditService', () => ({
    recordToolCall: mockAuditRecord,
    recordRunAuthorization: mockAuthorizationAuditRecord,
}));
jest.mock('../backend/src/services/appRuntimeRateLimit', () => ({
    consumeInstallation: mockConsumeInstallation,
    consumeUnauthenticated: jest.fn(() => ({ allowed: true, retryAfterSeconds: 1 })),
}));
jest.mock('../backend/src/services/pulseMaskingService', () => {
    const actual = jest.requireActual('../backend/src/services/pulseMaskingService');
    return {
        ...actual,
        getMaskViewer: mockGetMaskViewer,
    };
});

const catalog = require('../backend/src/services/appRuntimeToolCatalog');
const registry = require('../backend/src/services/agentSkillsMcpRegistry');
const { AppRuntimeError } = require('../backend/src/services/appRuntimeErrors');
const gatewayRouter = require('../backend/src/routes/appRuntimeGateway');
const actualTokenService = jest.requireActual('../backend/src/services/appRuntimeTokenService');

function context(overrides = {}) {
    return {
        run_id: RUN_ID,
        company_id: COMPANY_ID,
        app_id: '91',
        installation_id: '101',
        version_id: VERSION_ID,
        artifact_sha256: 'a'.repeat(64),
        principal_id: '60000000-0000-4000-8000-000000000001',
        agent_user_id: AGENT_ID,
        delegated_by_user_id: DELEGATOR_ID,
        agent_email: 'app-runtime+101@albusto.invalid',
        agent_full_name: 'App Runtime: Test',
        company_name: 'Company A',
        company_timezone: 'America/New_York',
        gateway_calls_used: 0,
        data_calls_made: 0,
        write_calls_made: 0,
        allowed_tools: [...ALL_TOOLS],
        installation_metadata: {
            app_runtime: {
                version_id: VERSION_ID,
                consented_tools: [...ALL_TOOLS],
            },
        },
        ...overrides,
    };
}

function buildApp() {
    const app = express();
    app.use('/internal/app-runtime', gatewayRouter);
    return app;
}

function call(app, toolName, body = {}, token = 'valid-token') {
    return request(app)
        .post(`/internal/app-runtime/v1/tools/${toolName}`)
        .set('Authorization', `Bearer ${token}`)
        .send(body);
}

beforeEach(() => {
    jest.clearAllMocks();
    mockTokenService.verifyRunToken.mockReturnValue({
        installation_id: '101', version_id: VERSION_ID, run_id: RUN_ID,
        exp: Math.floor(Date.now() / 1000) + 300, nonce: 'a'.repeat(43),
    });
    mockTokenService.resolveRunContext.mockResolvedValue(context());
    mockTokenService.consumeRunCall.mockResolvedValue(1);
    mockTokenService.consumeRunDataCall.mockResolvedValue(1);
    mockTokenService.consumeRunWriteCall.mockResolvedValue(1);
    mockTokenService.authorizeRunExecution.mockResolvedValue({
        execution_authorized_at: new Date().toISOString(), runs_started: 1, wall_ms_used: 0,
    });
    mockTokenService.validateRunMetrics.mockImplementation(value => value);
    mockTokenService.recordRunCompletion.mockResolvedValue({ id: RUN_ID });
    mockResolveCompanyUserAuthz.mockResolvedValue({
        role_key: 'manager',
        membership: { id: 'member-a', role_key: 'manager', status: 'active' },
        permissions: ['jobs.view', 'tasks.view', 'tasks.create', 'estimates.view'],
        scopes: { job_visibility: 'all' },
    });
    mockConsumeInstallation.mockReturnValue({ allowed: true, retryAfterSeconds: 1 });
    mockGetMaskViewer.mockResolvedValue(false);
    mockAuditRecord.mockResolvedValue({ id: 1 });
    mockAuthorizationAuditRecord.mockResolvedValue({ id: 2 });
    mockReadExecute.mockImplementation(async (handler) => ({
        listJobs: {
            results: [{ id: 11, customer_phone: '+16175550101', nested: { phone: '+16175550102' } }],
            total: 1,
        },
        getJob: { id: 11, customer_phone: '+16175550101' },
        listTasks: { tasks: [{ id: 21, description: 'Owned task' }] },
        listEstimates: { results: [{ id: 31, status: 'approved' }], pagination: {} },
        getEstimate: { id: 31, status: 'approved', items: [], order_list: [] },
    })[handler]);
    mockDataList.mockResolvedValue({ rows: [], pagination: { limit: 100, offset: 0, total: 0 } });
    mockDataUpsert.mockResolvedValue({ upserted: 1 });
    mockDataRemove.mockResolvedValue({ deleted: 1 });
    mockCreateTask.mockResolvedValue({ task_id: 41, status: 'open' });
});

describe('APP-GW-001 catalog, validation, authorization, masking, and audit', () => {
    test('SAB exact catalog: the sole write is explicitly allowlisted and every descriptor is strict', () => {
        const tools = catalog.listTools();
        expect(tools.map((tool) => tool.name)).toEqual(ALL_TOOLS);
        expect(tools.map((tool) => tool.handler)).toEqual([
            'listJobs',
            'getJob',
            'listTasks',
            'createTask',
            'listEstimates',
            'getEstimate',
        ]);
        expect(catalog.BUSINESS_PERMISSIONS).toMatchObject({
            'svc.create_task': 'tasks.create',
            'svc.list_estimates': 'estimates.view',
            'svc.get_estimate': 'estimates.view',
        });
        for (const tool of tools) {
            expect(tool.kind).toBe(catalog.WRITE_TOOLS.includes(tool.name) ? 'write' : 'read');
            expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
            expect(JSON.stringify(tool.inputSchema)).not.toMatch(/url|uri|href/i);
        }
    });

    test('a write descriptor outside WRITE_TOOLS fails closed as APP_RUNTIME_CATALOG_DRIFT', () => {
        const originalGetTool = registry.getTool;
        const original = originalGetTool('svc.list_jobs');
        registry.getTool = name => name === 'svc.list_jobs'
            ? { ...original, kind: 'write' }
            : originalGetTool(name);
        try {
            expect(() => catalog.projectDescriptor('svc.list_jobs'))
                .toThrow('APP_RUNTIME_CATALOG_DRIFT: svc.list_jobs');
        } finally {
            registry.getTool = originalGetTool;
        }
    });

    test('svc.create_task uses the shared call path, separate write meter, consent, and tasks.create RBAC', async () => {
        const body = {
            parent_type: 'job',
            parent_id: 11,
            description: 'Review the app finding.',
            due_at: '2026-08-03',
        };
        const response = await call(buildApp(), 'svc.create_task', body);
        expect(response.status).toBe(200);
        expect(response.body.data).toEqual({ task_id: 41, status: 'open' });
        expect(mockTokenService.consumeRunCall).toHaveBeenCalledTimes(1);
        expect(mockTokenService.consumeRunWriteCall).toHaveBeenCalledTimes(1);
        expect(mockCreateTask).toHaveBeenCalledWith(context(), body);

        mockTokenService.resolveRunContext.mockResolvedValue(context({
            installation_metadata: {
                app_runtime: { version_id: VERSION_ID, consented_tools: ['svc.list_jobs'] },
            },
        }));
        expect((await call(buildApp(), 'svc.create_task', body)).body.code)
            .toBe('TOOL_NOT_CONSENTED');

        mockTokenService.resolveRunContext.mockResolvedValue(context());
        mockResolveCompanyUserAuthz.mockResolvedValue({
            role_key: 'custom',
            membership: { id: 'member-a' },
            permissions: ['tasks.view'],
            scopes: {},
        });
        expect((await call(buildApp(), 'svc.create_task', body)).body.code)
            .toBe('ACCESS_DENIED');
    });

    test('the fourth write call is refused with its precise English reason and does not dispatch', async () => {
        mockTokenService.consumeRunWriteCall.mockRejectedValueOnce(
            new AppRuntimeError('WRITE_CALL_LIMIT', 'Write call limit of 3 reached.', 429)
        );
        const response = await call(buildApp(), 'svc.create_task', {
            parent_type: 'job', parent_id: 11, description: 'Review this.',
        });
        expect(response.status).toBe(429);
        expect(response.body).toMatchObject({
            code: 'WRITE_CALL_LIMIT',
            message: 'Write call limit of 3 reached.',
        });
        expect(mockCreateTask).not.toHaveBeenCalled();
    });

    test.each([
        ['svc.list_jobs', {}, 'listJobs'],
        ['svc.get_job', { job_id: 11 }, 'getJob'],
        ['svc.list_tasks', {}, 'listTasks'],
        ['svc.list_estimates', { status: 'approved' }, 'listEstimates'],
        ['svc.get_estimate', { estimate_id: 31 }, 'getEstimate'],
    ])('dispatches the approved tool %s through its shared read handler', async (tool, body, handler) => {
        const response = await call(buildApp(), tool, body);
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ ok: true, request_id: expect.stringMatching(/^app-gw-/) });
        expect(mockReadExecute).toHaveBeenCalledWith(
            handler,
            expect.objectContaining({
                companyId: COMPANY_ID,
                companyTimezone: 'America/New_York',
                ownerUserId: DELEGATOR_ID,
            }),
            body
        );
        expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    });

    test('SAB tenant selectors reject, never strip: top-level and nested aliases do not dispatch', async () => {
        const app = buildApp();
        for (const body of [
            { company_id: COMPANY_ID },
            { filters: { tenantId: COMPANY_ID } },
            { values: [{ organization_id: COMPANY_ID }] },
            { workspaceID: COMPANY_ID },
            { OrganisationId: COMPANY_ID },
        ]) {
            const response = await call(app, 'svc.list_jobs', body);
            expect(response.status).toBe(400);
            expect(response.body.code).toBe('TENANT_SELECTOR_FORBIDDEN');
        }
        expect(mockReadExecute).not.toHaveBeenCalled();
        expect(mockAuditRecord).toHaveBeenCalledTimes(5);
    });

    test('Phase D data routes use only run-token context, reject tenant selectors, and consume a separate budget', async () => {
        const app = buildApp();
        const list = await request(app)
            .post('/internal/app-runtime/v1/data/purchases/list')
            .set('Authorization', 'Bearer valid-token')
            .send({ limit: 25, offset: 0 });
        const upsert = await request(app)
            .post('/internal/app-runtime/v1/data/purchases/upsert')
            .set('Authorization', 'Bearer valid-token')
            .send({ rows: [{ estimate_id: 1, part_number: 'P-1' }] });
        const removed = await request(app)
            .post('/internal/app-runtime/v1/data/purchases/delete')
            .set('Authorization', 'Bearer valid-token')
            .send({ keys: [{ estimate_id: 1, part_number: 'P-1' }] });
        expect([list.status, upsert.status, removed.status]).toEqual([200, 200, 200]);
        expect(mockDataList).toHaveBeenCalledWith(
            context(),
            'purchases',
            { limit: 25, offset: 0 }
        );
        expect(mockDataUpsert).toHaveBeenCalledWith(
            context(),
            'purchases',
            { rows: [{ estimate_id: 1, part_number: 'P-1' }] }
        );
        expect(mockDataRemove).toHaveBeenCalledWith(
            context(),
            'purchases',
            { keys: [{ estimate_id: 1, part_number: 'P-1' }] }
        );
        expect(mockTokenService.consumeRunDataCall).toHaveBeenCalledTimes(3);
        expect(mockTokenService.consumeRunCall).not.toHaveBeenCalled();

        mockDataUpsert.mockImplementationOnce((_context, _collection, body) => {
            const requestValidator = jest.requireActual(
                '../backend/src/services/appRuntimeRequestValidator'
            );
            requestValidator.rejectTenantSelectors(body);
        });
        const selector = await request(app)
            .post('/internal/app-runtime/v1/data/purchases/upsert')
            .set('Authorization', 'Bearer valid-token')
            .send({ rows: [{ company_id: COMPANY_ID, estimate_id: 1 }] });
        expect(selector.status).toBe(400);
        expect(selector.body.code).toBe('TENANT_SELECTOR_FORBIDDEN');
    });

    test('the eleventh Phase D call gets the precise independent data budget refusal', async () => {
        mockTokenService.consumeRunDataCall.mockRejectedValueOnce(
            new AppRuntimeError('DATA_CALL_LIMIT', 'Data call limit of 10 reached.', 429)
        );
        const response = await request(buildApp())
            .post('/internal/app-runtime/v1/data/purchases/list')
            .set('Authorization', 'Bearer valid-token')
            .send({});
        expect(response.status).toBe(429);
        expect(response.body).toMatchObject({
            code: 'DATA_CALL_LIMIT',
            message: 'Data call limit of 10 reached.',
        });
        expect(mockDataList).not.toHaveBeenCalled();
        expect(mockTokenService.consumeRunCall).not.toHaveBeenCalled();
    });

    test('registered non-runtime writes and URL-like names never dispatch', async () => {
        const app = buildApp();
        for (const name of ['svc.list_calls', 'svc.create_job', 'svc.fetch_url']) {
            const response = await call(app, name, {});
            expect(response.status).toBe(404);
            expect(response.body.code).toBe('TOOL_NOT_FOUND');
        }
        expect(mockReadExecute).not.toHaveBeenCalled();
        expect(mockAuditRecord).toHaveBeenCalledTimes(3);
    });

    test('SAB strict schema before dispatch: unknown keys, types, dates, and bounds are 422', async () => {
        const cases = [
            ['svc.list_jobs', { surprise: true }],
            ['svc.get_job', { job_id: '11' }],
            ['svc.list_jobs', { start_date: '2026-02-30' }],
            ['svc.list_jobs', { limit: 0 }],
            ['svc.list_tasks', { limit: 101 }],
            ['svc.list_estimates', { status: 'accepted' }],
            ['svc.list_estimates', { accepted_from: '2026-02-30' }],
            ['svc.get_estimate', { estimate_id: '31' }],
            ['svc.create_task', { parent_type: 'job', parent_id: 11, description: '' }],
            ['svc.create_task', { parent_type: 'job', parent_id: 11, description: 'x', due_at: '2026-02-30' }],
            ['svc.list_jobs', { callback_url: 'https://evil.test' }],
        ];
        for (const [name, body] of cases) {
            const response = await call(buildApp(), name, body);
            expect(response.status).toBe(422);
            expect(response.body.code).toBe('INVALID_ARGUMENTS');
        }
        expect(mockReadExecute).not.toHaveBeenCalled();
    });

    test('transport rejects non-object bodies and query parameters before token resolution', async () => {
        const app = buildApp();
        const arrayBody = await request(app)
            .post('/internal/app-runtime/v1/tools/svc.list_jobs')
            .set('Authorization', 'Bearer valid-token')
            .send([]);
        const query = await request(app)
            .post('/internal/app-runtime/v1/tools/svc.list_jobs?company_id=x')
            .set('Authorization', 'Bearer valid-token')
            .send({});
        expect(arrayBody.status).toBe(400);
        expect(arrayBody.body.code).toBe('INVALID_REQUEST');
        expect(query.status).toBe(400);
        expect(query.body.code).toBe('INVALID_REQUEST');
        expect(mockTokenService.verifyRunToken).not.toHaveBeenCalled();
    });

    test('the route rejects bodies above 32 KiB before token resolution', async () => {
        const response = await call(buildApp(), 'svc.list_jobs', { search: 'x'.repeat(33 * 1024) });
        expect(response.status).toBe(400);
        expect(response.body.code).toBe('INVALID_REQUEST');
        expect(mockTokenService.verifyRunToken).not.toHaveBeenCalled();
    });

    test('SAB version allowlist required: consent metadata alone cannot grant a tool', async () => {
        mockTokenService.resolveRunContext.mockResolvedValue(context({ allowed_tools: ['svc.list_jobs'] }));
        const response = await call(buildApp(), 'svc.get_job', { job_id: 11 });
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('TOOL_NOT_CONSENTED');
        expect(mockReadExecute).not.toHaveBeenCalled();
    });

    test('SAB installation consent independently narrows: version grants alone cannot grant a tool', async () => {
        mockTokenService.resolveRunContext.mockResolvedValue(context({
            installation_metadata: {
                app_runtime: { version_id: VERSION_ID, consented_tools: ['svc.list_jobs'] },
            },
        }));
        const response = await call(buildApp(), 'svc.get_job', { job_id: 11 });
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('TOOL_NOT_CONSENTED');
        expect(mockReadExecute).not.toHaveBeenCalled();
    });

    test('malformed or wrong-version consent fails closed', async () => {
        for (const metadata of [
            {},
            { app_runtime: [] },
            { app_runtime: { version_id: RUN_ID, consented_tools: ALL_TOOLS } },
        ]) {
            mockTokenService.resolveRunContext.mockResolvedValueOnce(context({ installation_metadata: metadata }));
            const response = await call(buildApp(), 'svc.list_jobs', {});
            expect(response.status).toBe(403);
            expect(response.body.code).toBe('TOOL_NOT_CONSENTED');
        }
    });

    test('SAB live delegator permission on every call: a live deny blocks dispatch', async () => {
        mockResolveCompanyUserAuthz.mockResolvedValue({
            role_key: 'custom', membership: { id: 'member-a' }, permissions: [], scopes: {},
        });
        const response = await call(buildApp(), 'svc.list_jobs', {});
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('ACCESS_DENIED');
        expect(mockResolveCompanyUserAuthz).toHaveBeenCalledWith(COMPANY_ID, DELEGATOR_ID);
        expect(mockReadExecute).not.toHaveBeenCalled();
    });

    test('APP-DATA-001 estimates.view is required independently for both Estimate tools', async () => {
        mockResolveCompanyUserAuthz.mockResolvedValue({
            role_key: 'custom',
            membership: { id: 'member-a' },
            permissions: ['estimates.view'],
            scopes: {},
        });
        await expect(call(buildApp(), 'svc.list_estimates', { status: 'approved' }))
            .resolves.toMatchObject({ status: 200 });
        await expect(call(buildApp(), 'svc.get_estimate', { estimate_id: 31 }))
            .resolves.toMatchObject({ status: 200 });

        mockResolveCompanyUserAuthz.mockResolvedValue({
            role_key: 'custom', membership: { id: 'member-a' }, permissions: [], scopes: {},
        });
        expect((await call(buildApp(), 'svc.list_estimates', {})).body.code).toBe('ACCESS_DENIED');
        expect((await call(buildApp(), 'svc.get_estimate', { estimate_id: 31 })).body.code)
            .toBe('ACCESS_DENIED');
    });

    test('SAB APP-FINAL-P0 run authorization requires the exact hash, live consent, and live RBAC', async () => {
        const sourceSha256 = 'a'.repeat(64);
        const authorized = await request(buildApp())
            .post('/internal/app-runtime/v1/runs/authorize')
            .set('Authorization', 'Bearer valid-token')
            .send({ source_sha256: sourceSha256 });
        expect(authorized.status).toBe(200);
        expect(mockResolveCompanyUserAuthz).toHaveBeenCalledWith(COMPANY_ID, DELEGATOR_ID);
        expect(mockTokenService.authorizeRunExecution).toHaveBeenCalledWith(
            context(),
            sourceSha256
        );
        expect(mockAuthorizationAuditRecord).toHaveBeenCalledWith(context(), expect.objectContaining({
            outcome: 'succeeded', errorCode: null,
        }));

        mockTokenService.authorizeRunExecution.mockClear();
        mockResolveCompanyUserAuthz.mockResolvedValue({
            role_key: 'custom', membership: { id: 'member-a' }, permissions: [], scopes: {},
        });
        const denied = await request(buildApp())
            .post('/internal/app-runtime/v1/runs/authorize')
            .set('Authorization', 'Bearer valid-token')
            .send({ source_sha256: sourceSha256 });
        expect(denied.status).toBe(403);
        expect(denied.body.code).toBe('ACCESS_DENIED');
        expect(mockTokenService.authorizeRunExecution).not.toHaveBeenCalled();

        mockTokenService.resolveRunContext.mockResolvedValue(context({
            installation_metadata: {
                app_runtime: { version_id: VERSION_ID, consented_tools: [] },
            },
        }));
        const noConsent = await request(buildApp())
            .post('/internal/app-runtime/v1/runs/authorize')
            .set('Authorization', 'Bearer valid-token')
            .send({ source_sha256: sourceSha256 });
        expect(noConsent.status).toBe(403);
        expect(noConsent.body.code).toBe('TOOL_NOT_CONSENTED');
        expect(mockTokenService.authorizeRunExecution).not.toHaveBeenCalled();
    });

    test('run authorization transport rejects caller-controlled fields before token resolution', async () => {
        const response = await request(buildApp())
            .post('/internal/app-runtime/v1/runs/authorize')
            .set('Authorization', 'Bearer valid-token')
            .send({ source_sha256: 'a'.repeat(64), company_id: COMPANY_ID });
        expect(response.status).toBe(400);
        expect(response.body.code).toBe('INVALID_REQUEST');
        expect(mockTokenService.verifyRunToken).not.toHaveBeenCalled();
    });

    test('SAB all output crosses masking seam: recursive customer phones are absent', async () => {
        mockGetMaskViewer.mockResolvedValue(true);
        const response = await call(buildApp(), 'svc.list_jobs', {});
        expect(response.status).toBe(200);
        expect(JSON.stringify(response.body.data)).not.toContain('+16175550101');
        expect(JSON.stringify(response.body.data)).not.toContain('+16175550102');
        expect(response.body.data.results[0]).not.toHaveProperty('customer_phone');
        expect(mockGetMaskViewer).toHaveBeenCalledTimes(1);
    });

    test('unmasked output remains byte-for-byte unchanged', async () => {
        const expected = await mockReadExecute('listJobs');
        mockReadExecute.mockClear();
        const response = await call(buildApp(), 'svc.list_jobs', {});
        expect(response.status).toBe(200);
        expect(response.body.data).toEqual(expected);
    });

    test('SAB audit awaited and correctly attributed: insert failure returns 503 with no tool data', async () => {
        mockAuditRecord.mockRejectedValue(new Error('database unavailable'));
        const response = await call(buildApp(), 'svc.get_job', { job_id: 11 });
        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({ ok: false, code: 'AUDIT_UNAVAILABLE' });
        expect(response.body).not.toHaveProperty('data');
        expect(mockAuditRecord).toHaveBeenCalledWith(context(), expect.objectContaining({
            toolName: 'svc.get_job', outcome: 'succeeded', errorCode: null, callOrdinal: 1,
        }));
    });

    test('run-limit and installation-rate denials are audited and expose Retry-After only for rate', async () => {
        mockTokenService.consumeRunCall.mockRejectedValueOnce(
            new AppRuntimeError('RUN_CALL_LIMIT', 'Run call limit reached.', 429, { callOrdinal: 6 })
        );
        const runLimit = await call(buildApp(), 'svc.list_jobs', {});
        expect(runLimit.status).toBe(429);
        expect(runLimit.body.code).toBe('RUN_CALL_LIMIT');
        expect(mockAuditRecord).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
            errorCode: 'RUN_CALL_LIMIT', callOrdinal: 6,
        }));

        mockConsumeInstallation.mockReturnValueOnce({ allowed: false, retryAfterSeconds: 9 });
        const rate = await call(buildApp(), 'svc.list_jobs', {});
        expect(rate.status).toBe(429);
        expect(rate.body.code).toBe('RATE_LIMITED');
        expect(rate.headers['retry-after']).toBe('9');
        expect(mockTokenService.consumeRunCall).toHaveBeenCalledTimes(1);
        expect(mockAuditRecord).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
            errorCode: 'RATE_LIMITED',
        }));
    });

    test('missing bearer and invalid tokens return stable authentication errors without tenant audit', async () => {
        const app = buildApp();
        const missing = await request(app)
            .post('/internal/app-runtime/v1/tools/svc.list_jobs')
            .send({});
        expect(missing.status).toBe(401);
        expect(missing.body.code).toBe('APP_RUNTIME_AUTH_REQUIRED');

        mockTokenService.verifyRunToken.mockImplementationOnce(() => {
            throw new AppRuntimeError('APP_RUNTIME_TOKEN_INVALID', 'Invalid app runtime token.', 401);
        });
        const invalid = await call(app, 'svc.list_jobs', {}, 'invalid');
        expect(invalid.status).toBe(401);
        expect(invalid.body.code).toBe('APP_RUNTIME_TOKEN_INVALID');
        expect(mockAuditRecord).not.toHaveBeenCalled();
    });

    test('F2 completion endpoint records bounded run metrics without resolving live authority', async () => {
        const metrics = {
            wall_ms: 37,
            gateway_calls: 2,
            data_calls: 3,
            result_bytes: 18,
            error_code: null,
        };
        const response = await request(buildApp())
            .post('/internal/app-runtime/v1/runs/complete')
            .set('Authorization', 'Bearer valid-token')
            .send(metrics);
        expect(response.status).toBe(200);
        expect(mockTokenService.validateRunMetrics).toHaveBeenCalledWith(metrics);
        expect(mockTokenService.recordRunCompletion).toHaveBeenCalledWith(
            expect.objectContaining({ run_id: RUN_ID }),
            metrics
        );
        expect(mockTokenService.resolveRunContext).not.toHaveBeenCalled();
        expect(mockReadExecute).not.toHaveBeenCalled();
    });
});

describe('APP-GW-001 exact HS256 run-token claims', () => {
    const secret = '0123456789abcdef0123456789abcdef';

    beforeEach(() => {
        process.env.APP_RUNTIME_RUN_TOKEN_SECRET = secret;
    });

    afterAll(() => {
        delete process.env.APP_RUNTIME_RUN_TOKEN_SECRET;
    });

    function sign(overrides = {}, options = {}) {
        return jwt.sign({
            installation_id: '101',
            version_id: VERSION_ID,
            run_id: RUN_ID,
            exp: Math.floor(Date.now() / 1000) + 200,
            nonce: Buffer.alloc(32, 7).toString('base64url'),
            ...overrides,
        }, secret, { algorithm: 'HS256', noTimestamp: true, ...options });
    }

    test('valid token has exactly the five allowed claims and no implicit iat', () => {
        const claims = actualTokenService.verifyRunToken(sign());
        expect(Object.keys(claims).sort()).toEqual(actualTokenService.CLAIM_KEYS);
        expect(claims).not.toHaveProperty('iat');
        expect(claims).not.toHaveProperty('company_id');
        expect(claims).not.toHaveProperty('app_id');
        expect(claims).not.toHaveProperty('user_id');
    });

    test.each([
        ['extra claim', { permission: 'jobs.view' }],
        ['missing claim', { nonce: undefined }],
        ['wrong installation type', { installation_id: 101 }],
        ['wrong version type', { version_id: 2 }],
        ['wrong run type', { run_id: 3 }],
        ['wrong nonce', { nonce: 'short' }],
        ['overlong lifetime', { exp: Math.floor(Date.now() / 1000) + 600 }],
    ])('rejects %s', (_name, overrides) => {
        expect(() => actualTokenService.verifyRunToken(sign(overrides)))
            .toThrow(expect.objectContaining({ code: 'APP_RUNTIME_TOKEN_INVALID' }));
    });

    test('rejects wrong algorithm, signature, expiration, and missing secret', () => {
        expect(() => actualTokenService.verifyRunToken(sign({}, { algorithm: 'HS384' })))
            .toThrow(expect.objectContaining({ code: 'APP_RUNTIME_TOKEN_INVALID' }));
        const otherSignature = jwt.sign({
            installation_id: '101', version_id: VERSION_ID, run_id: RUN_ID,
            exp: Math.floor(Date.now() / 1000) + 200,
            nonce: Buffer.alloc(32, 7).toString('base64url'),
        }, 'fedcba9876543210fedcba9876543210', { algorithm: 'HS256', noTimestamp: true });
        expect(() => actualTokenService.verifyRunToken(otherSignature))
            .toThrow(expect.objectContaining({ code: 'APP_RUNTIME_TOKEN_INVALID' }));
        expect(() => actualTokenService.verifyRunToken(sign({
            exp: Math.floor(Date.now() / 1000) - 1,
        }))).toThrow(expect.objectContaining({ code: 'APP_RUNTIME_TOKEN_EXPIRED' }));
        delete process.env.APP_RUNTIME_RUN_TOKEN_SECRET;
        expect(() => actualTokenService.configuredSecret())
            .toThrow(expect.objectContaining({ code: 'APP_RUNTIME_NOT_CONFIGURED' }));
        process.env.APP_RUNTIME_RUN_TOKEN_SECRET = secret;
    });
});
