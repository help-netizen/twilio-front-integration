const express = require('express');
const request = require('supertest');

jest.mock('../../backend/src/services/marketplaceService', () => {
    class MarketplaceServiceError extends Error {
        constructor(message, code, httpStatus = 400) {
            super(message);
            this.code = code;
            this.httpStatus = httpStatus;
        }
    }
    return {
        MarketplaceServiceError,
        listApps: jest.fn(),
        listInstallations: jest.fn(),
        installApp: jest.fn(),
        disconnectInstallation: jest.fn(),
        retryProvisioning: jest.fn(),
    };
});

const marketplaceService = require('../../backend/src/services/marketplaceService');
const router = require('../../backend/src/routes/marketplace');

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.requestId = 'req_test';
        req.companyFilter = { company_id: 'company-1' };
        req.user = { crmUser: { id: 'user-1' } };
        next();
    });
    app.use('/api/marketplace', router);
    return app;
}

describe('marketplace routes', () => {
    let app;
    beforeEach(() => {
        jest.clearAllMocks();
        app = makeApp();
    });

    test('GET /apps returns catalog', async () => {
        marketplaceService.listApps.mockResolvedValue([{ app_key: 'call-qa-agent' }]);
        const res = await request(app).get('/api/marketplace/apps');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.apps).toEqual([{ app_key: 'call-qa-agent' }]);
        expect(marketplaceService.listApps).toHaveBeenCalledWith('company-1');
    });

    test('POST /apps/:appKey/install does not expose secret', async () => {
        marketplaceService.installApp.mockResolvedValue({
            id: 42,
            app_key: 'call-qa-agent',
            status: 'connected',
            key_id: 'blanc_test',
        });
        const res = await request(app).post('/api/marketplace/apps/call-qa-agent/install');
        expect(res.status).toBe(201);
        expect(res.body.installation.key_id).toBe('blanc_test');
        expect(JSON.stringify(res.body)).not.toContain('secret');
        expect(marketplaceService.installApp).toHaveBeenCalledWith(
            'company-1',
            'user-1',
            'call-qa-agent',
            expect.objectContaining({ requestId: 'req_test' })
        );
    });

    test('service errors map to documented code/status', async () => {
        marketplaceService.installApp.mockRejectedValue(
            new marketplaceService.MarketplaceServiceError('Already installed', 'APP_ALREADY_INSTALLED', 409)
        );
        const res = await request(app).post('/api/marketplace/apps/call-qa-agent/install');
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('APP_ALREADY_INSTALLED');
    });

    test('disconnect passes company and actor context', async () => {
        marketplaceService.disconnectInstallation.mockResolvedValue({
            id: 42,
            status: 'disconnected',
        });
        const res = await request(app).post('/api/marketplace/installations/42/disconnect');
        expect(res.status).toBe(200);
        expect(marketplaceService.disconnectInstallation).toHaveBeenCalledWith(
            'company-1',
            'user-1',
            '42',
            { requestId: 'req_test' }
        );
    });
});
