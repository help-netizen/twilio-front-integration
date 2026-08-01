'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/notificationPolicyService', () => ({
    getLegacyNotificationConfig: jest.fn(),
    updateLegacyNotificationConfig: jest.fn(),
}));

const notificationPolicyService = require('../backend/src/services/notificationPolicyService');
const db = require('../backend/src/db/connection');
const router = require('../backend/src/routes/notification-settings');
const actionRequiredRouter = require('../backend/src/routes/action-required-settings');

const COMPANY_A = '00000000-0000-4000-8000-00000000000a';
const USER_A = '10000000-0000-4000-8000-00000000000a';

function makeApp({ companyId = COMPANY_A, userId = USER_A, permissions = [] } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.companyFilter = companyId ? { company_id: companyId } : undefined;
        req.user = { crmUser: userId ? { id: userId } : null };
        req.authz = { permissions };
        next();
    });
    app.use('/', router);
    return app;
}

function makeActionRequiredApp(companyId = COMPANY_A) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.companyFilter = companyId ? { company_id: companyId } : undefined;
        next();
    });
    app.use('/', actionRequiredRouter);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [] });
    notificationPolicyService.getLegacyNotificationConfig.mockResolvedValue({
        browser_push_new_text_message_enabled: true,
        browser_push_new_lead_enabled: false,
        updated_by_user_id: USER_A,
        updated_at: '2026-07-31T12:00:00.000Z',
    });
    notificationPolicyService.updateLegacyNotificationConfig.mockResolvedValue({
        browser_push_new_text_message_enabled: false,
        browser_push_new_lead_enabled: true,
        updated_by_user_id: USER_A,
        updated_at: '2026-07-31T12:00:00.000Z',
    });
});

describe('Action Required settings tenant context', () => {
    test('GET fails closed without company context and never queries a fallback company', async () => {
        const response = await request(makeActionRequiredApp(null)).get('/');
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('TENANT_CONTEXT_REQUIRED');
        expect(db.query).not.toHaveBeenCalled();
    });

    test('GET reads only the request company', async () => {
        const response = await request(makeActionRequiredApp()).get('/');
        expect(response.status).toBe(200);
        expect(db.query.mock.calls[0][1]).toEqual([COMPANY_A, 'action_required_config']);
    });
});

describe('legacy notification settings compatibility route', () => {
    test('GET maps the selected company policy and never resolves another company', async () => {
        const response = await request(makeApp()).get('/');
        expect(response.status).toBe(200);
        expect(response.body.config.browser_push_new_text_message_enabled).toBe(true);
        expect(notificationPolicyService.getLegacyNotificationConfig).toHaveBeenCalledWith(COMPANY_A);
    });

    test('GET fails closed without company context', async () => {
        const response = await request(makeApp({ companyId: null })).get('/');
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('TENANT_CONTEXT_REQUIRED');
        expect(notificationPolicyService.getLegacyNotificationConfig).not.toHaveBeenCalled();
    });

    test.each(['manager', 'dispatcher', 'provider'])(
        'PUT R-matrix deny: %s without tenant.company.manage is forbidden',
        async () => {
            const response = await request(makeApp({ permissions: [] }))
                .put('/')
                .send({ config: { browser_push_new_lead_enabled: true } });
            expect(response.status).toBe(403);
            expect(notificationPolicyService.updateLegacyNotificationConfig).not.toHaveBeenCalled();
        }
    );

    test('PUT writes only the request company using crm_users.id actor', async () => {
        const config = {
            browser_push_new_text_message_enabled: false,
            browser_push_new_lead_enabled: true,
        };
        const response = await request(makeApp({ permissions: ['tenant.company.manage'] }))
            .put('/')
            .send({ config });
        expect(response.status).toBe(200);
        expect(notificationPolicyService.updateLegacyNotificationConfig)
            .toHaveBeenCalledWith(COMPANY_A, config, USER_A);
    });

    test('PUT fails with NO_CRM_USER and makes no write', async () => {
        const response = await request(makeApp({
            userId: null,
            permissions: ['tenant.company.manage'],
        })).put('/').send({ config: {} });
        expect(response.status).toBe(409);
        expect(response.body.code).toBe('NO_CRM_USER');
        expect(notificationPolicyService.updateLegacyNotificationConfig).not.toHaveBeenCalled();
    });
});
