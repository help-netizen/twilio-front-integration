'use strict';

const express = require('express');
const request = require('supertest');

const COMPANY_A = '10000000-0000-4000-8000-000000000001';
const ACTOR_ID = '20000000-0000-4000-8000-000000000001';
const RUN_ID = '30000000-0000-4000-8000-000000000001';
const VERSION_ID = '40000000-0000-4000-8000-000000000001';

const mockService = {
    run: jest.fn(),
    listRuns: jest.fn(),
    getRunResult: jest.fn(),
    getLatestResult: jest.fn(),
};
const mockScheduleService = {
    getSchedule: jest.fn(),
    updateSchedule: jest.fn(),
    acceptVersion: jest.fn(),
};
const mockDataService = {
    listForViewer: jest.fn(),
};
const mockSecretService = {
    listSecrets: jest.fn(),
    setSecret: jest.fn(),
};
const mockSettingsService = {
    getSettings: jest.fn(),
    updateSettings: jest.fn(),
};

jest.mock('../backend/src/middleware/keycloakAuth', () => ({
    authenticate: (req, _res, next) => {
        req.user = { crmUser: { id: ACTOR_ID } };
        req.authz = {
            company: { id: req.headers['x-test-company'] || COMPANY_A },
            membership: { role_key: req.headers['x-test-role'] || 'dispatcher' },
            permissions: req.headers['x-test-integrations'] === 'true'
                ? ['tenant.integrations.manage']
                : [],
        };
        next();
    },
    requireCompanyAccess: (req, _res, next) => {
        req.companyFilter = { company_id: req.authz.company.id };
        next();
    },
}));
jest.mock('../backend/src/services/appExecutionService', () => mockService);
jest.mock('../backend/src/services/appScheduleService', () => mockScheduleService);
jest.mock('../backend/src/services/appDataService', () => mockDataService);
jest.mock('../backend/src/services/appInstallationSecretService', () => mockSecretService);
jest.mock('../backend/src/services/appInstallationSettingsService', () => mockSettingsService);
jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn().mockResolvedValue(undefined),
}));

const { AppRuntimeError } = require('../backend/src/services/appRuntimeErrors');
const appViewsRouter = require('../backend/src/routes/appViews');

function buildApp() {
    const app = express();
    app.use('/api/apps', appViewsRouter);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    const run = {
        run_id: RUN_ID,
        status: 'completed',
        duration_ms: 10,
        gateway_calls: 1,
        result_bytes: 54,
        view_document: { view_version: 1, title: 'Safe', blocks: [] },
    };
    mockService.run.mockResolvedValue(run);
    mockService.listRuns.mockResolvedValue([run]);
    mockService.getRunResult.mockResolvedValue(run);
    mockService.getLatestResult.mockResolvedValue(run);
    const settings = {
        schedule: {
            enabled: true,
            cadence: { kind: 'daily', at: '07:00' },
            cost_forecast: { runs_per_day: 1, runs_per_month: 30.417 },
        },
        version: { update_available: true },
    };
    mockScheduleService.getSchedule.mockResolvedValue(settings);
    mockScheduleService.updateSchedule.mockResolvedValue(settings);
    mockScheduleService.acceptVersion.mockResolvedValue({
        accepted_version: { version_id: VERSION_ID, consented_tools: ['svc.list_jobs'] },
    });
    mockDataService.listForViewer.mockResolvedValue({
        collection: 'purchases',
        rows: [{ data: { estimate_id: 41 }, created_at: '2026-08-02T12:00:00.000Z' }],
        pagination: { limit: 25, offset: 0, total: 1 },
    });
    mockSecretService.listSecrets.mockResolvedValue([
        { connection: 'supplier', status: 'set' },
        { connection: 'inventory', status: 'not_set' },
    ]);
    mockSecretService.setSecret.mockResolvedValue({
        connection: 'supplier',
        status: 'set',
        set_at: '2026-08-03T12:00:00.000Z',
    });
    mockSettingsService.getSettings.mockResolvedValue({
        declarations: [{ key: 'threshold', label: 'Threshold', type: 'number' }],
        settings: { threshold: 4 },
    });
    mockSettingsService.updateSettings.mockResolvedValue({
        declarations: [{ key: 'threshold', label: 'Threshold', type: 'number' }],
        settings: { threshold: 5 },
    });
});

describe('APP-VIEW-001 company-scoped API', () => {
    test('all four endpoints use companyFilter and CRM actor without exposing source or internal columns', async () => {
        const app = buildApp();
        const started = await request(app)
            .post('/api/apps/installations/91/runs')
            .send({});
        const history = await request(app).get('/api/apps/installations/91/runs');
        const result = await request(app).get(`/api/apps/installations/91/runs/${RUN_ID}`);
        const latest = await request(app).get('/api/apps/installations/91/latest');

        expect([started.status, history.status, result.status, latest.status])
            .toEqual([200, 200, 200, 200]);
        expect(mockService.run).toHaveBeenCalledWith({
            companyId: COMPANY_A,
            installationId: '91',
            trigger: 'manual',
            actorId: ACTOR_ID,
        });
        for (const method of ['listRuns', 'getLatestResult']) {
            expect(mockService[method]).toHaveBeenCalledWith({
                companyId: COMPANY_A,
                installationId: '91',
                actorId: ACTOR_ID,
            });
        }
        expect(mockService.getRunResult).toHaveBeenCalledWith({
            companyId: COMPANY_A,
            installationId: '91',
            runId: RUN_ID,
            actorId: ACTOR_ID,
        });
        expect(JSON.stringify([
            started.body, history.body, result.body, latest.body,
        ])).not.toMatch(/source_code|nonce|principal_id|artifact_sha256/i);
    });

    test('Phase E action runs pass the clicking actor and exact action input to the execution core', async () => {
        const action = { id: 'mark_ordered', row_key: 'estimate-41:part-P-41' };
        const response = await request(buildApp())
            .post('/api/apps/installations/91/runs')
            .send({ action });
        expect(response.status).toBe(200);
        expect(mockService.run).toHaveBeenCalledWith({
            companyId: COMPANY_A,
            installationId: '91',
            actorId: ACTOR_ID,
            trigger: 'action',
            action,
        });
    });

    test('T-foreign and every live permission denial stay 404/403 and never return stored data', async () => {
        mockService.getLatestResult
            .mockRejectedValueOnce(new AppRuntimeError(
                'NOT_FOUND',
                'App installation was not found.',
                404
            ))
            .mockRejectedValueOnce(new AppRuntimeError(
                'ACCESS_DENIED',
                'You do not have permission to view this application.',
                403
            ));
        const foreign = await request(buildApp())
            .get('/api/apps/installations/91/latest')
            .set('x-test-company', '10000000-0000-4000-8000-000000000002');
        const denied = await request(buildApp())
            .get('/api/apps/installations/91/latest')
            .set('x-test-role', 'provider');
        expect(foreign.status).toBe(404);
        expect(foreign.body).toMatchObject({ ok: false, code: 'NOT_FOUND' });
        expect(denied.status).toBe(403);
        expect(denied.body).toMatchObject({ ok: false, code: 'ACCESS_DENIED' });
        expect(foreign.body).not.toHaveProperty('run');
        expect(denied.body).not.toHaveProperty('run');
    });

    test('the three Phase B endpoints pass tenant/actor context and never expose source code', async () => {
        const app = buildApp();
        const current = await request(app).get('/api/apps/installations/91/schedule');
        const updated = await request(app)
            .put('/api/apps/installations/91/schedule')
            .send({ enabled: true, cadence: { kind: 'daily', at: '07:00' } });
        const accepted = await request(app)
            .post('/api/apps/installations/91/accept-version')
            .send({ version_id: VERSION_ID });

        expect([current.status, updated.status, accepted.status]).toEqual([200, 200, 200]);
        const context = {
            companyId: COMPANY_A,
            installationId: '91',
            actorId: ACTOR_ID,
        };
        expect(mockScheduleService.getSchedule).toHaveBeenCalledWith(context);
        expect(mockScheduleService.updateSchedule).toHaveBeenCalledWith({
            ...context,
            body: { enabled: true, cadence: { kind: 'daily', at: '07:00' } },
        });
        expect(mockScheduleService.acceptVersion).toHaveBeenCalledWith({
            ...context,
            body: { version_id: VERSION_ID },
            requestId: expect.stringMatching(/^app-view-/),
        });
        expect(JSON.stringify([current.body, updated.body, accepted.body]))
            .not.toMatch(/source_code|source_sha256|scanner_report/i);
    });

    test('Phase D human GET passes only companyFilter/actor context and bounded pagination', async () => {
        const response = await request(buildApp())
            .get('/api/apps/installations/91/data/purchases?limit=25&offset=0');
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            ok: true,
            collection: 'purchases',
            pagination: { limit: 25, offset: 0, total: 1 },
        });
        expect(mockDataService.listForViewer).toHaveBeenCalledWith({
            companyId: COMPANY_A,
            installationId: '91',
            actorId: ACTOR_ID,
            collection: 'purchases',
            limit: 25,
            offset: 0,
        });
        expect(JSON.stringify(response.body)).not.toMatch(/source_code|source_sha256|row_key/i);

        const invalid = await request(buildApp())
            .get('/api/apps/installations/91/data/purchases?company_id=foreign');
        expect(invalid.status).toBe(400);
        expect(mockDataService.listForViewer).toHaveBeenCalledTimes(1);
    });

    test('5 secrets API is write-only, tenant_admin-only, permission-gated, and passes only tenant-paired context', async () => {
        const app = buildApp();
        const allowedHeaders = {
            'x-test-role': 'tenant_admin',
            'x-test-integrations': 'true',
        };
        const listed = await request(app)
            .get('/api/apps/installations/91/secrets')
            .set(allowedHeaders);
        const written = await request(app)
            .put('/api/apps/installations/91/secrets/supplier')
            .set(allowedHeaders)
            .send({ value: 'write-only-value' });
        expect([listed.status, written.status]).toEqual([200, 200]);
        expect(listed.body.secrets).toEqual([
            { connection: 'supplier', status: 'set' },
            { connection: 'inventory', status: 'not_set' },
        ]);
        expect(JSON.stringify([listed.body, written.body])).not.toContain('write-only-value');
        expect(mockSecretService.listSecrets).toHaveBeenCalledWith({
            companyId: COMPANY_A,
            installationId: '91',
            actorId: ACTOR_ID,
        });
        expect(mockSecretService.setSecret).toHaveBeenCalledWith({
            companyId: COMPANY_A,
            installationId: '91',
            actorId: ACTOR_ID,
            connectionName: 'supplier',
            value: 'write-only-value',
        });

        for (const role of ['manager', 'dispatcher', 'provider', 'custom']) {
            const denied = await request(app)
                .get('/api/apps/installations/91/secrets')
                .set('x-test-role', role)
                .set('x-test-integrations', 'true');
            expect(denied.status).toBe(403);
            expect(denied.body.code).toBe('TENANT_ADMIN_ONLY');
        }
        const noPermission = await request(app)
            .get('/api/apps/installations/91/secrets')
            .set('x-test-role', 'tenant_admin');
        expect(noPermission.status).toBe(403);
        expect(noPermission.body.code).toBe('ACCESS_DENIED');
        expect(mockSecretService.listSecrets).toHaveBeenCalledTimes(1);
    });

    test('Phase J settings GET uses the viewer service and PUT denies every non-admin role', async () => {
        const app = buildApp();
        const listed = await request(app).get('/api/apps/installations/91/settings');
        expect(listed.status).toBe(200);
        expect(listed.body).toMatchObject({
            ok: true,
            declarations: [{ key: 'threshold', label: 'Threshold', type: 'number' }],
            settings: { threshold: 4 },
        });
        expect(mockSettingsService.getSettings).toHaveBeenCalledWith({
            companyId: COMPANY_A,
            installationId: '91',
            actorId: ACTOR_ID,
        });

        for (const role of ['manager', 'dispatcher', 'provider', 'custom']) {
            const denied = await request(app)
                .put('/api/apps/installations/91/settings')
                .set('x-test-role', role)
                .send({ settings: { threshold: 5 } });
            expect(denied.status).toBe(403);
            expect(denied.body.code).toBe('TENANT_ADMIN_ONLY');
        }
        expect(mockSettingsService.updateSettings).not.toHaveBeenCalled();

        const updated = await request(app)
            .put('/api/apps/installations/91/settings')
            .set('x-test-role', 'tenant_admin')
            .send({ settings: { threshold: 5 } });
        expect(updated.status).toBe(200);
        expect(mockSettingsService.updateSettings).toHaveBeenCalledWith({
            companyId: COMPANY_A,
            installationId: '91',
            actorId: ACTOR_ID,
            settings: { threshold: 5 },
        });
    });
});
