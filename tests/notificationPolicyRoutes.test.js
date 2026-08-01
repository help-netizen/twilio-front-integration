'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../backend/src/services/notificationPolicyService', () => ({
    getPolicySnapshot: jest.fn(),
    updateCompanyPolicy: jest.fn(),
    updateCurrentUserPreference: jest.fn(),
}));

const notificationPolicyService = require('../backend/src/services/notificationPolicyService');
const router = require('../backend/src/routes/notification-policies');

const COMPANY_A = '00000000-0000-4000-8000-00000000000a';
const USER_A = '10000000-0000-4000-8000-00000000000a';

function makeApp({ roleKey = 'provider', permissions = [], companyId = COMPANY_A, userId = USER_A } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.companyFilter = companyId ? { company_id: companyId } : undefined;
        req.user = { crmUser: userId ? { id: userId } : null };
        req.authz = { membership: { role_key: roleKey }, permissions };
        next();
    });
    app.use('/', router);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    notificationPolicyService.getPolicySnapshot.mockResolvedValue({ catalog: [] });
    notificationPolicyService.updateCompanyPolicy.mockResolvedValue({ company_policy: {}, role_delivery: [] });
    notificationPolicyService.updateCurrentUserPreference.mockResolvedValue({ preference: {}, effective_policy: {} });
});

describe('notification policy routes', () => {
    test('GET non-admin asks for only the caller role', async () => {
        const response = await request(makeApp({
            roleKey: 'provider',
            permissions: ['jobs.view'],
        })).get('/notification-policies');
        expect(response.status).toBe(200);
        expect(notificationPolicyService.getPolicySnapshot).toHaveBeenCalledWith(COMPANY_A, {
            userId: USER_A,
            roleKey: 'provider',
            permissions: ['jobs.view'],
            includeAllRoles: false,
        });
    });

    test('GET admin asks for every role in only the selected company', async () => {
        const response = await request(makeApp({
            roleKey: 'tenant_admin',
            permissions: ['tenant.company.manage'],
        })).get('/notification-policies');
        expect(response.status).toBe(200);
        expect(notificationPolicyService.getPolicySnapshot.mock.calls[0][1].includeAllRoles).toBe(true);
        expect(notificationPolicyService.getPolicySnapshot.mock.calls[0][0]).toBe(COMPANY_A);
    });

    test.each(['manager', 'dispatcher', 'provider'])(
        'PATCH company policy R-matrix deny: %s lacks tenant.company.manage',
        async roleKey => {
            const response = await request(makeApp({ roleKey, permissions: [] }))
                .patch('/notification-policies/lead.created')
                .send({ company_enabled: true });
            expect(response.status).toBe(403);
            expect(notificationPolicyService.updateCompanyPolicy).not.toHaveBeenCalled();
        }
    );

    test('tenant admin and custom permission holder may patch company policy', async () => {
        for (const roleKey of ['tenant_admin', 'custom_role']) {
            const response = await request(makeApp({
                roleKey,
                permissions: ['tenant.company.manage'],
            })).patch('/notification-policies/lead.created').send({ company_enabled: true });
            expect(response.status).toBe(200);
        }
        expect(notificationPolicyService.updateCompanyPolicy).toHaveBeenNthCalledWith(
            1,
            COMPANY_A,
            'lead.created',
            { company_enabled: true },
            USER_A
        );
    });

    test('all active roles write only their own preference identity', async () => {
        for (const roleKey of ['tenant_admin', 'manager', 'dispatcher', 'provider']) {
            const response = await request(makeApp({ roleKey, permissions: ['jobs.view'] }))
                .patch('/notification-preferences/job.created')
                .send({ channels: { browser_push: 'disabled' } });
            expect(response.status).toBe(200);
        }
        for (const call of notificationPolicyService.updateCurrentUserPreference.mock.calls) {
            expect(call[0]).toBe(COMPANY_A);
            expect(call[1]).toBe(USER_A);
        }
    });

    test('service errors retain allowlist/availability HTTP status and code', async () => {
        notificationPolicyService.updateCompanyPolicy.mockRejectedValue({
            status: 409,
            code: 'PRODUCER_UNAVAILABLE',
            message: 'Producer unavailable.',
        });
        const response = await request(makeApp({ permissions: ['tenant.company.manage'] }))
            .patch('/notification-policies/call.voicemail_received')
            .send({ company_enabled: true });
        expect(response.status).toBe(409);
        expect(response.body.code).toBe('PRODUCER_UNAVAILABLE');
    });
});
