'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/notificationPolicyService', () => ({
    getNotificationSettings: jest.fn(),
    updateCurrentUserCategory: jest.fn(),
}));

const notificationPolicyService = require('../backend/src/services/notificationPolicyService');
const db = require('../backend/src/db/connection');
const legacyRouter = require('../backend/src/routes/notification-settings');
const policyRouter = require('../backend/src/routes/notification-policies');
const actionRequiredRouter = require('../backend/src/routes/action-required-settings');

const COMPANY_A = '00000000-0000-4000-8000-00000000000a';
const USER_A = '10000000-0000-4000-8000-00000000000a';

function makeApp({ companyId = COMPANY_A, userId = USER_A } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.companyFilter = companyId ? { company_id: companyId } : undefined;
        req.user = { crmUser: userId ? { id: userId } : null };
        next();
    });
    app.use('/api/settings/notifications', legacyRouter);
    app.use('/api/settings', policyRouter);
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
    notificationPolicyService.getNotificationSettings.mockResolvedValue({
        categories: [],
        device: { browser_push: { supported: true, permission: 'unknown', subscribed: false } },
    });
    notificationPolicyService.updateCurrentUserCategory.mockResolvedValue({
        key: 'leads', enabled: false,
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

describe('per-user notification category settings route', () => {
    test('GET reads only the request-derived company and CRM user', async () => {
        const response = await request(makeApp()).get('/api/settings/notifications');
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('data.categories');
        expect(notificationPolicyService.getNotificationSettings)
            .toHaveBeenCalledWith(COMPANY_A, USER_A);
    });

    test('GET fails closed without company context', async () => {
        notificationPolicyService.getNotificationSettings.mockRejectedValue({
            status: 403,
            code: 'TENANT_CONTEXT_REQUIRED',
            message: 'Company context is required.',
        });
        const response = await request(makeApp({ companyId: null })).get('/api/settings/notifications');
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('TENANT_CONTEXT_REQUIRED');
        expect(notificationPolicyService.getNotificationSettings).toHaveBeenCalledWith(null, USER_A);
    });

    test.each(['tenant_admin', 'manager', 'dispatcher', 'provider'])(
        'PATCH lets %s update only the request-derived user category',
        async () => {
            const response = await request(makeApp())
                .patch('/api/settings/notifications/leads')
                .send({ enabled: false, user_id: 'ignored-by-route' });
            expect(response.status).toBe(200);
            expect(notificationPolicyService.updateCurrentUserCategory)
                .toHaveBeenLastCalledWith(COMPANY_A, USER_A, 'leads', {
                    enabled: false,
                    user_id: 'ignored-by-route',
                });
        }
    );

    test('unknown category retains service 404 and code', async () => {
        notificationPolicyService.updateCurrentUserCategory.mockRejectedValue({
            status: 404,
            code: 'NOTIFICATION_CATEGORY_NOT_FOUND',
            message: 'Notification category not found.',
        });
        const response = await request(makeApp())
            .patch('/api/settings/notifications/unknown')
            .send({ enabled: true });
        expect(response.status).toBe(404);
        expect(response.body.code).toBe('NOTIFICATION_CATEGORY_NOT_FOUND');
    });

    test('legacy company-level PUT adapter is retired', async () => {
        const response = await request(makeApp())
            .put('/api/settings/notifications')
            .send({ config: { browser_push_new_lead_enabled: true } });
        expect(response.status).toBe(404);
    });
});
