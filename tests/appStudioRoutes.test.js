'use strict';

const express = require('express');
const request = require('supertest');

const COMPANY_A = '10000000-0000-4000-8000-000000000001';
const COMPANY_B = '10000000-0000-4000-8000-000000000002';
const ACTOR_ID = '20000000-0000-4000-8000-000000000001';
const CHAT_ID = '30000000-0000-4000-8000-000000000001';

const mockService = {
    createChat: jest.fn(),
    listChats: jest.fn(),
    getMessages: jest.fn(),
    generateMessage: jest.fn(),
    listVersions: jest.fn(),
};
const mockAuditLog = jest.fn().mockResolvedValue(undefined);

jest.mock('../backend/src/services/appBuilderService', () => mockService);
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
        version: { id: '40000000-0000-4000-8000-000000000001', status: 'draft' },
        message: { role: 'assistant', text: 'Created.' },
    });
    mockService.listVersions.mockResolvedValue({ app: { app_id: '91' }, versions: [] });
});

describe('APP-BUILD-001 tenant admin API', () => {
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
});
