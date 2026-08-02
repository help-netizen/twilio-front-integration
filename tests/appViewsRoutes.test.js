'use strict';

const express = require('express');
const request = require('supertest');

const COMPANY_A = '10000000-0000-4000-8000-000000000001';
const ACTOR_ID = '20000000-0000-4000-8000-000000000001';
const RUN_ID = '30000000-0000-4000-8000-000000000001';

const mockService = {
    run: jest.fn(),
    listRuns: jest.fn(),
    getRunResult: jest.fn(),
    getLatestResult: jest.fn(),
};

jest.mock('../backend/src/middleware/keycloakAuth', () => ({
    authenticate: (req, _res, next) => {
        req.user = { crmUser: { id: ACTOR_ID } };
        req.authz = {
            company: { id: req.headers['x-test-company'] || COMPANY_A },
            membership: { role_key: req.headers['x-test-role'] || 'dispatcher' },
            permissions: [],
        };
        next();
    },
    requireCompanyAccess: (req, _res, next) => {
        req.companyFilter = { company_id: req.authz.company.id };
        next();
    },
}));
jest.mock('../backend/src/services/appExecutionService', () => mockService);

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
});
