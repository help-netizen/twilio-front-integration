'use strict';

const express = require('express');
const request = require('supertest');

const COMPANY_A = '10000000-0000-4000-8000-000000000001';
const COMPANY_B = '10000000-0000-4000-8000-000000000002';
const ACTOR_ID = '20000000-0000-4000-8000-000000000001';
const CHAT_ID = '30000000-0000-4000-8000-000000000001';
const VERSION_ID = '40000000-0000-4000-8000-000000000001';
const ORIGINAL_ENABLED = process.env.APP_STUDIO_ENABLED;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_RUNNER_BASE_URL = process.env.APP_RUNNER_BASE_URL;
const ORIGINAL_RUNNER_TOKEN = process.env.APP_RUNNER_SERVICE_TOKEN;

const mockService = {
    createChat: jest.fn(),
    listChats: jest.fn(),
    getMessages: jest.fn(),
    generateMessage: jest.fn(),
    listVersions: jest.fn(),
};
const mockAuditLog = jest.fn().mockResolvedValue(undefined);
const mockTransitionService = {
    submitVersion: jest.fn(),
    publishVersion: jest.fn(),
    forkRejectedVersion: jest.fn(),
};

jest.mock('../backend/src/services/appBuilderService', () => mockService);
jest.mock('../backend/src/services/appVersionTransitionService', () => mockTransitionService);
jest.mock('../backend/src/services/auditService', () => ({ log: mockAuditLog }));

const appStudioRouter = require('../backend/src/routes/appStudio');
const { requireCompanyAccess } = require('../backend/src/middleware/keycloakAuth');

function buildApp({
    companyId = COMPANY_A,
    roleKey = 'tenant_admin',
    permissions = ['tenant.integrations.manage'],
} = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { email: 'admin@example.test', crmUser: { id: ACTOR_ID } };
        req.authz = {
            scope: 'tenant',
            platform_role: 'none',
            company: { id: companyId, status: 'active' },
            membership: { role_key: roleKey, status: 'active' },
            permissions,
        };
        req.requestId = 'req-app-studio';
        req.traceId = 'trace-app-studio';
        next();
    });
    app.use('/api/app-studio', requireCompanyAccess, appStudioRouter);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    process.env.APP_STUDIO_ENABLED = 'true';
    process.env.NODE_ENV = 'test';
    process.env.APP_RUNNER_BASE_URL = 'https://runner.albusto.test';
    process.env.APP_RUNNER_SERVICE_TOKEN = 'runner-service-test-token';
    mockService.createChat.mockResolvedValue({
        id: CHAT_ID,
        company_id: COMPANY_A,
        app_id: null,
        title: 'New app',
    });
    mockService.listChats.mockResolvedValue([]);
    mockService.getMessages.mockResolvedValue({
        chat: { id: CHAT_ID, app_id: null },
        messages: [],
    });
    mockService.generateMessage.mockResolvedValue({
        generation_status: 'created',
        app_id: '91',
        version: { id: VERSION_ID, status: 'draft' },
        message: { role: 'assistant', text: 'Created.' },
    });
    mockService.listVersions.mockResolvedValue({ app: { app_id: '91' }, versions: [] });
    mockTransitionService.submitVersion.mockResolvedValue({ id: VERSION_ID, status: 'submitted' });
    mockTransitionService.publishVersion.mockResolvedValue({ id: VERSION_ID, status: 'published' });
    mockTransitionService.forkRejectedVersion.mockResolvedValue({ id: VERSION_ID, status: 'draft' });
});

afterAll(() => {
    if (ORIGINAL_ENABLED === undefined) delete process.env.APP_STUDIO_ENABLED;
    else process.env.APP_STUDIO_ENABLED = ORIGINAL_ENABLED;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_RUNNER_BASE_URL === undefined) delete process.env.APP_RUNNER_BASE_URL;
    else process.env.APP_RUNNER_BASE_URL = ORIGINAL_RUNNER_BASE_URL;
    if (ORIGINAL_RUNNER_TOKEN === undefined) delete process.env.APP_RUNNER_SERVICE_TOKEN;
    else process.env.APP_RUNNER_SERVICE_TOKEN = ORIGINAL_RUNNER_TOKEN;
});

describe('APP-BUILD-001 tenant admin API', () => {
    test('feature flag disabled remains a 404', async () => {
        process.env.APP_STUDIO_ENABLED = 'false';
        const response = await request(buildApp()).get('/api/app-studio/chats');
        expect(response.status).toBe(404);
        expect(response.body.code).toBe('APP_STUDIO_DISABLED');
        expect(mockService.listChats).not.toHaveBeenCalled();
    });

    test('missing APP_RUNNER_BASE_URL returns a clear 503', async () => {
        delete process.env.APP_RUNNER_BASE_URL;
        const response = await request(buildApp()).get('/api/app-studio/chats');
        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({
            code: 'APP_RUNNER_NOT_CONFIGURED',
            message: 'App runner service URL is not configured.',
        });
        expect(mockService.listChats).not.toHaveBeenCalled();
    });

    test('SAB non-admin authorization runs before feature and runner configuration disclosure', async () => {
        process.env.APP_STUDIO_ENABLED = 'false';
        delete process.env.APP_RUNNER_BASE_URL;
        const roleDenied = await request(buildApp({ roleKey: 'manager' }))
            .get('/api/app-studio/chats');
        expect(roleDenied.status).toBe(403);
        expect(roleDenied.body.code).toBe('TENANT_ADMIN_ONLY');
        expect(JSON.stringify(roleDenied.body)).not.toMatch(/disabled|runner/i);

        const permissionDenied = await request(buildApp({ permissions: [] }))
            .get('/api/app-studio/chats');
        expect(permissionDenied.status).toBe(403);
        expect(permissionDenied.body.code).toBe('ACCESS_DENIED');
        expect(JSON.stringify(permissionDenied.body)).not.toMatch(/disabled|runner/i);
    });

    test('enabled and configured App Studio works in production', async () => {
        process.env.NODE_ENV = 'production';
        const response = await request(buildApp()).get('/api/app-studio/chats');
        expect(response.status).toBe(200);
        expect(mockService.listChats).toHaveBeenCalledWith(COMPANY_A);
    });

    test('T-own: tenant admin creates an app-less chat from companyFilter and CRM actor', async () => {
        const response = await request(buildApp())
            .post('/api/app-studio/chats')
            .send({ title: 'Dispatch digest' });
        expect(response.status).toBe(201);
        expect(mockService.createChat).toHaveBeenCalledWith(
            COMPANY_A,
            ACTOR_ID,
            { title: 'Dispatch digest' }
        );
    });

    test.each(['manager', 'dispatcher', 'provider', 'custom'])(
        'R-matrix: %s is denied even when tenant.integrations.manage is present',
        async roleKey => {
            const response = await request(buildApp({ roleKey })).get('/api/app-studio/chats');
            expect(response.status).toBe(403);
            expect(response.body.code).toBe('TENANT_ADMIN_ONLY');
            expect(mockService.listChats).not.toHaveBeenCalled();
        }
    );

    test('R-matrix: tenant_admin without tenant.integrations.manage is denied', async () => {
        const response = await request(buildApp({ permissions: [] })).get('/api/app-studio/chats');
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('ACCESS_DENIED');
        expect(mockService.listChats).not.toHaveBeenCalled();
    });

    test('T-foreign: foreign chat stays a company-scoped 404', async () => {
        mockService.getMessages.mockRejectedValue(Object.assign(new Error('not found'), {
            code: 'NOT_FOUND',
            httpStatus: 404,
        }));
        const response = await request(buildApp({ companyId: COMPANY_B }))
            .get(`/api/app-studio/chats/${CHAT_ID}/messages`);
        expect(response.status).toBe(404);
        expect(response.body.code).toBe('NOT_FOUND');
        expect(mockService.getMessages).toHaveBeenCalledWith(COMPANY_B, CHAT_ID);
    });

    test('generation quota exhaustion returns 429 with the persisted bot message', async () => {
        mockService.generateMessage.mockRejectedValue(Object.assign(new Error('quota'), {
            code: 'GENERATION_QUOTA_EXCEEDED',
            httpStatus: 429,
            botMessage: { id: 'quota-message', role: 'assistant', text: 'Quota exhausted.' },
        }));
        const response = await request(buildApp())
            .post(`/api/app-studio/chats/${CHAT_ID}/messages`)
            .send({ text: 'Generate another version.' });
        expect(response.status).toBe(429);
        expect(response.body.message_record).toMatchObject({ id: 'quota-message' });
    });

    test('all five routes use the fixed API surface and reject unknown body keys', async () => {
        const app = buildApp();
        expect((await request(app).get('/api/app-studio/chats')).status).toBe(200);
        expect((await request(app).get(`/api/app-studio/chats/${CHAT_ID}/messages`)).status).toBe(200);
        expect((await request(app)
            .post(`/api/app-studio/chats/${CHAT_ID}/messages`)
            .send({ text: 'Build it.' })).status).toBe(200);
        expect((await request(app).get('/api/app-studio/apps/91/versions')).status).toBe(200);
        expect((await request(app).post('/api/app-studio/chats').send({ company_id: COMPANY_B })).status)
            .toBe(400);
    });

    test.each([
        ['submit', 'submitVersion', 200],
        ['publish', 'publishVersion', 200],
        ['fork', 'forkRejectedVersion', 201],
    ])('T-own: POST version %s is company-scoped and uses the CRM actor', async (
        routeAction,
        serviceAction,
        expectedStatus
    ) => {
        const response = await request(buildApp())
            .post(`/api/app-studio/apps/91/versions/${VERSION_ID}/${routeAction}`);
        expect(response.status).toBe(expectedStatus);
        expect(mockTransitionService[serviceAction]).toHaveBeenCalledWith({
            companyId: COMPANY_A,
            actorId: ACTOR_ID,
            appId: '91',
            versionId: VERSION_ID,
            traceId: 'req-app-studio',
        });
    });

    test.each(['manager', 'dispatcher', 'provider', 'custom'])(
        'version-action R-matrix: %s is denied from submit, publish, and fork',
        async roleKey => {
            for (const action of ['submit', 'publish', 'fork']) {
                const response = await request(buildApp({ roleKey }))
                    .post(`/api/app-studio/apps/91/versions/${VERSION_ID}/${action}`);
                expect(response.status).toBe(403);
                expect(response.body.code).toBe('TENANT_ADMIN_ONLY');
            }
            expect(mockTransitionService.submitVersion).not.toHaveBeenCalled();
            expect(mockTransitionService.publishVersion).not.toHaveBeenCalled();
            expect(mockTransitionService.forkRejectedVersion).not.toHaveBeenCalled();
        }
    );

    test('version-action R-matrix denies tenant_admin without integrations permission', async () => {
        for (const action of ['submit', 'publish', 'fork']) {
            const response = await request(buildApp({ permissions: [] }))
                .post(`/api/app-studio/apps/91/versions/${VERSION_ID}/${action}`);
            expect(response.status).toBe(403);
            expect(response.body.code).toBe('ACCESS_DENIED');
        }
    });

    test('T-foreign: foreign company version action is a 404 and keeps its scoped company id', async () => {
        mockTransitionService.submitVersion.mockRejectedValue(Object.assign(new Error('not found'), {
            code: 'NOT_FOUND',
            httpStatus: 404,
        }));
        const response = await request(buildApp({ companyId: COMPANY_B }))
            .post(`/api/app-studio/apps/91/versions/${VERSION_ID}/submit`);
        expect(response.status).toBe(404);
        expect(response.body.code).toBe('NOT_FOUND');
        expect(mockTransitionService.submitVersion).toHaveBeenCalledWith(expect.objectContaining({
            companyId: COMPANY_B,
            appId: '91',
            versionId: VERSION_ID,
        }));
    });
});
