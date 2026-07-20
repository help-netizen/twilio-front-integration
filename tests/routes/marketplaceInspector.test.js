'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

class MockMarketplaceError extends Error {
    constructor(message, code, httpStatus) {
        super(message);
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

const mockGetAppSettings = jest.fn();
const mockUpdateAppSettings = jest.fn();
jest.mock('../../backend/src/services/marketplaceService', () => ({
    MarketplaceServiceError: MockMarketplaceError,
    getAppSettings: mockGetAppSettings,
    updateAppSettings: mockUpdateAppSettings,
    listApps: jest.fn(),
    listInstallations: jest.fn(),
    installApp: jest.fn(),
    disconnectInstallation: jest.fn(),
    retryProvisioning: jest.fn(),
}));
jest.mock('../../backend/src/services/rateMeService', () => ({
    RateMeServiceError: class RateMeServiceError extends Error {},
    setCustomDomain: jest.fn(), verifyDomain: jest.fn(), removeDomain: jest.fn(), mintToken: jest.fn(),
}));
jest.mock('../../backend/src/services/auditService', () => ({ log: jest.fn().mockResolvedValue(null) }));

const marketplaceRouter = require('../../backend/src/routes/marketplace');
const { requirePermission } = require('../../backend/src/middleware/authorization');

const COMPANY = '11111111-1111-1111-1111-111111111111';
const ACTOR = '22222222-2222-2222-2222-222222222222';

function appForRole(role) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        if (role === 'anonymous') return res.status(401).json({ code: 'UNAUTHENTICATED' });
        req.user = { crmUser: { id: ACTOR } };
        const permissions = ['tenant_admin', 'custom_granted'].includes(role)
            ? ['tenant.integrations.manage']
            : [];
        req.authz = {
            company: { id: COMPANY, status: 'active' },
            permissions,
        };
        req.companyFilter = { company_id: COMPANY };
        req.requestId = 'req-inspector';
        next();
    });
    app.use('/api/marketplace', requirePermission('tenant.integrations.manage'), marketplaceRouter);
    return app;
}

describe('Inspector Marketplace settings route and RBAC', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetAppSettings.mockResolvedValue({ app_key: 'inspector', settings: { enabled: true } });
        mockUpdateAppSettings.mockResolvedValue({ app_key: 'inspector', settings: { enabled: false } });
    });

    test.each([
        ['anonymous', 401],
        ['manager', 403],
        ['dispatcher', 403],
        ['provider', 403],
        ['custom_denied', 403],
        ['tenant_admin', 200],
        ['custom_granted', 200],
    ])('SAB-INSP-R-MATRIX: %s receives %i', async (role, status) => {
        const response = await request(appForRole(role)).get('/api/marketplace/apps/inspector/settings');
        expect(response.status).toBe(status);
    });

    test.each([
        ['manager', 403],
        ['dispatcher', 403],
        ['provider', 403],
        ['custom_denied', 403],
        ['tenant_admin', 200],
        ['custom_granted', 200],
    ])('SAB-INSP-R-MATRIX PUT: %s receives %i', async (role, status) => {
        const response = await request(appForRole(role))
            .put('/api/marketplace/apps/inspector/settings')
            .send({
                enabled: false,
                ignored_job_statuses: ['Canceled'],
                ignored_lead_statuses: ['Lost'],
                instruction: 'Review carefully.',
            });
        expect(response.status).toBe(status);
        if (status === 403) expect(mockUpdateAppSettings).not.toHaveBeenCalled();
    });

    test('GET and PUT pass only selected company plus CRM actor to the service', async () => {
        await request(appForRole('tenant_admin'))
            .get('/api/marketplace/apps/inspector/settings')
            .expect(200);
        expect(mockGetAppSettings).toHaveBeenCalledWith(COMPANY, 'inspector');

        const body = {
            enabled: false,
            ignored_job_statuses: ['Canceled'],
            ignored_lead_statuses: ['Lost'],
            instruction: 'Review carefully.',
        };
        await request(appForRole('tenant_admin'))
            .put('/api/marketplace/apps/inspector/settings')
            .send(body)
            .expect(200);
        expect(mockUpdateAppSettings).toHaveBeenCalledWith(
            COMPANY,
            ACTOR,
            'inspector',
            body,
            { requestId: 'req-inspector' }
        );
    });

    test('production mount remains authenticate → tenant_admin permission → company access', () => {
        const source = fs.readFileSync(path.join(__dirname, '../../src/server.js'), 'utf8');
        expect(source).toContain(
            "app.use('/api/marketplace', authenticate, requirePermission('tenant.integrations.manage'), requireCompanyAccess, marketplaceRouter);"
        );
        const roles = fs.readFileSync(
            path.join(__dirname, '../../backend/db/migrations/050_seed_role_configs.sql'),
            'utf8'
        );
        const tenantAdminBlock = roles.slice(
            roles.indexOf('Seed default permissions for Tenant Admin'),
            roles.indexOf('Seed default permissions for Manager')
        );
        expect(tenantAdminBlock).toContain("('tenant.integrations.manage')");
        expect(roles.slice(roles.indexOf('Seed default permissions for Manager')))
            .not.toContain("('tenant.integrations.manage')");
    });
});
