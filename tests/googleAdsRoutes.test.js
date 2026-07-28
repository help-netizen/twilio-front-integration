'use strict';

const fs = require('fs');
const path = require('path');

class MockGoogleAdsConnectionError extends Error {
    constructor(code, message, httpStatus) {
        super(message);
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

const mockGetConnectionStatus = jest.fn();
const mockRequestCompanySync = jest.fn();
const mockDisconnectCompany = jest.fn();

jest.mock('../backend/src/services/googleAdsConnectionService', () => ({
    GoogleAdsConnectionError: MockGoogleAdsConnectionError,
    getConnectionStatus: (...args) => mockGetConnectionStatus(...args),
    requestCompanySync: (...args) => mockRequestCompanySync(...args),
    disconnectCompany: (...args) => mockDisconnectCompany(...args),
}));
jest.mock('../backend/src/services/marketplaceService', () => ({
    MarketplaceServiceError: class MarketplaceServiceError extends Error {},
    listApps: jest.fn(),
    listInstallations: jest.fn(),
    getAppSettings: jest.fn(),
    updateAppSettings: jest.fn(),
    installApp: jest.fn(),
    disconnectInstallation: jest.fn(),
    retryProvisioning: jest.fn(),
    setChatgptMcpWrites: jest.fn(),
    setChatgptMcpSends: jest.fn(),
}));
jest.mock('../backend/src/services/rateMeService', () => ({
    RateMeServiceError: class RateMeServiceError extends Error {},
    setCustomDomain: jest.fn(),
    verifyDomain: jest.fn(),
    removeDomain: jest.fn(),
    mintToken: jest.fn(),
}));
jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn().mockResolvedValue(null),
}));

const marketplaceRouter = require('../backend/src/routes/marketplace');
const { requirePermission } = require('../backend/src/middleware/authorization');

const COMPANY = '11111111-1111-1111-1111-111111111111';
const POISONED_COMPANY = '99999999-9999-9999-9999-999999999999';
const ACTOR = '22222222-2222-2222-2222-222222222222';
const FULL_CUSTOMER_ID = '1234567890';
const STATUS = {
    connected: true,
    status: 'connected',
    customer_id_masked: '7890',
    currency_code: 'USD',
    account_timezone: 'America/New_York',
    synced_from_date: '2024-07-27',
    synced_through_date: '2026-07-27',
    last_sync_status: 'ok',
    last_synced_at: '2026-07-27T12:00:00.000Z',
    last_error_code: null,
};

function responseDouble() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
}

function routeHandler(pathname, method) {
    const layer = marketplaceRouter.stack.find(item => (
        item.route?.path === pathname
        && item.route?.methods?.[method.toLowerCase()]
    ));
    if (!layer) throw new Error(`Missing ${method} route ${pathname}`);
    return layer.route.stack[0].handle;
}

async function invokeAs(role, method, pathname, body = {}) {
    const res = responseDouble();
    if (role === 'anonymous') {
        return res.status(401).json({
            code: 'AUTH_REQUIRED',
            message: 'Bearer token required',
        });
    }
    const req = {
        method,
        originalUrl: `/api/marketplace${pathname}`,
        body,
        user: { crmUser: { id: ACTOR } },
        authz: {
            company: { id: COMPANY, status: 'active' },
            permissions: role === 'tenant_admin'
                ? ['tenant.integrations.manage']
                : [],
        },
        companyFilter: { company_id: COMPANY },
        companyId: POISONED_COMPANY,
    };
    let allowed = false;
    requirePermission('tenant.integrations.manage')(
        req,
        res,
        () => { allowed = true; }
    );
    if (!allowed) return res;
    await routeHandler(pathname, method)(req, res);
    return res;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetConnectionStatus.mockResolvedValue(STATUS);
    mockRequestCompanySync.mockResolvedValue({ status: 'pending' });
    mockDisconnectCompany.mockResolvedValue({ status: 'disconnected' });
});

describe('Google Ads marketplace routes', () => {
    const endpoints = [
        ['GET', '/api/marketplace/apps/google-ads/connection'],
        ['POST', '/api/marketplace/apps/google-ads/sync'],
        ['POST', '/api/marketplace/apps/google-ads/disconnect'],
    ];

    test.each(endpoints)('%s %s returns 401 without authentication', async (
        method,
        endpoint
    ) => {
        const pathname = endpoint.replace('/api/marketplace', '');
        const response = await invokeAs('anonymous', method, pathname);
        expect(response.statusCode).toBe(401);
    });

    test.each(['manager', 'dispatcher', 'provider'].flatMap(role => (
        endpoints.map(([method, endpoint]) => [role, method, endpoint])
    )))('%s is denied for %s %s', async (role, method, endpoint) => {
        const pathname = endpoint.replace('/api/marketplace', '');
        const response = await invokeAs(role, method, pathname);
        expect(response.statusCode).toBe(403);
        expect(response.body.code).toBe('ACCESS_DENIED');
        expect(mockGetConnectionStatus).not.toHaveBeenCalled();
        expect(mockRequestCompanySync).not.toHaveBeenCalled();
        expect(mockDisconnectCompany).not.toHaveBeenCalled();
    });

    test('tenant_admin reads the exact non-secret connection shape from companyFilter', async () => {
        const response = await invokeAs(
            'tenant_admin',
            'GET',
            '/apps/google-ads/connection'
        );

        expect(response.statusCode).toBe(200);
        expect(response.body).toEqual(STATUS);
        expect(mockGetConnectionStatus).toHaveBeenCalledWith(COMPANY);
        expect(mockGetConnectionStatus).not.toHaveBeenCalledWith(POISONED_COMPANY);
        const serialized = JSON.stringify(response.body);
        expect(serialized).not.toContain(FULL_CUSTOMER_ID);
        expect(serialized).not.toMatch(/refresh|encrypted|ciphertext|token/i);
    });

    test('tenant_admin sync marks work without accepting company or credentials from the body', async () => {
        const response = await invokeAs(
            'tenant_admin',
            'POST',
            '/apps/google-ads/sync',
            {
                companyId: POISONED_COMPANY,
                customer_id: FULL_CUSTOMER_ID,
                refresh_token: 'client-supplied-secret',
            }
        );

        expect(response.statusCode).toBe(200);
        expect(response.body).toEqual({ status: 'pending' });
        expect(mockRequestCompanySync).toHaveBeenCalledWith(COMPANY);
    });

    test('tenant_admin disconnect uses CRM actor and ignores client credentials', async () => {
        const response = await invokeAs(
            'tenant_admin',
            'POST',
            '/apps/google-ads/disconnect',
            {
                companyId: POISONED_COMPANY,
                refresh_token: 'client-supplied-secret',
            }
        );

        expect(response.statusCode).toBe(200);
        expect(response.body).toEqual({ status: 'disconnected' });
        expect(mockDisconnectCompany).toHaveBeenCalledWith(COMPANY, ACTOR);
    });

    test('stable service errors keep secrets out of the response', async () => {
        mockRequestCompanySync.mockRejectedValueOnce(
            new MockGoogleAdsConnectionError(
                'GOOGLE_ADS_NOT_CONNECTED',
                'Google Ads is not connected for this company.',
                409
            )
        );
        const response = await invokeAs(
            'tenant_admin',
            'POST',
            '/apps/google-ads/sync'
        );

        expect(response.statusCode).toBe(409);
        expect(response.body).toEqual({
            error: {
                code: 'GOOGLE_ADS_NOT_CONNECTED',
                message: 'Google Ads is not connected for this company.',
            },
        });
    });

    test('production mount remains authenticate + integrations permission + company access', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '../src/server.js'),
            'utf8'
        );
        expect(source).toContain(
            "app.use('/api/marketplace', authenticate, requirePermission('tenant.integrations.manage'), requireCompanyAccess, marketplaceRouter);"
        );

        const routeSource = fs.readFileSync(
            path.join(__dirname, '../backend/src/routes/marketplace.js'),
            'utf8'
        );
        expect(routeSource.indexOf("router.get('/apps/google-ads/connection'"))
            .toBeLessThan(routeSource.indexOf("router.get('/apps/:appKey/settings'"));
    });
});
