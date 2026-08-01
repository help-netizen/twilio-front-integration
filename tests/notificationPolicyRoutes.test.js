'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../backend/src/services/notificationPolicyService', () => ({
    getNotificationSettings: jest.fn(),
    updateCurrentUserCategory: jest.fn(),
}));

const notificationPolicyService = require('../backend/src/services/notificationPolicyService');
const router = require('../backend/src/routes/notification-policies');

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
    app.use('/api/settings', router);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    notificationPolicyService.getNotificationSettings.mockResolvedValue({ categories: [], device: {} });
    notificationPolicyService.updateCurrentUserCategory.mockResolvedValue({
        key: 'tasks', enabled: false,
    });
});

describe('reduced notification policy routes', () => {
    test('GET resolves the selected tenant and current CRM user only', async () => {
        const response = await request(makeApp()).get('/api/settings/notifications');
        expect(response.status).toBe(200);
        expect(notificationPolicyService.getNotificationSettings)
            .toHaveBeenCalledWith(COMPANY_A, USER_A);
    });

    test('PATCH resolves the selected tenant and current CRM user only', async () => {
        const body = { enabled: false };
        const response = await request(makeApp())
            .patch('/api/settings/notifications/tasks')
            .send(body);
        expect(response.status).toBe(200);
        expect(notificationPolicyService.updateCurrentUserCategory)
            .toHaveBeenCalledWith(COMPANY_A, USER_A, 'tasks', body);
    });

    test.each([
        ['GET', '/api/settings/notification-policies'],
        ['PATCH', '/api/settings/notification-policies/lead.created'],
        ['PATCH', '/api/settings/notification-preferences/lead.created'],
    ])('%s %s is retired', async (method, path) => {
        const response = await request(makeApp())[method.toLowerCase()](path).send({});
        expect(response.status).toBe(404);
    });
});
