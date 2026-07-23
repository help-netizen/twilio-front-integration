'use strict';

const express = require('express');
const request = require('supertest');

class MockMarketplaceServiceError extends Error {
    constructor(message, code, httpStatus) {
        super(message);
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

jest.mock('../backend/src/services/marketplaceService', () => ({
    MarketplaceServiceError: MockMarketplaceServiceError,
    setChatgptMcpWrites: jest.fn(),
}));

const marketplaceService = require('../backend/src/services/marketplaceService');
const router = require('../backend/src/routes/marketplace');

function app() {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
        req.companyFilter = { company_id: 'company-a' };
        req.user = { crmUser: { id: 'admin-a' } };
        req.requestId = 'request-a';
        next();
    });
    server.use('/api/marketplace', router);
    return server;
}

beforeEach(() => {
    jest.clearAllMocks();
    marketplaceService.setChatgptMcpWrites.mockResolvedValue({
        enabled: true,
        grant_version: 3,
    });
});

describe('ChatGPT MCP Marketplace write consent routes', () => {
    test.each([
        ['enable', true],
        ['disable', false],
    ])('POST writes/%s derives company and CRM actor from request context', async (action, enabled) => {
        marketplaceService.setChatgptMcpWrites.mockResolvedValueOnce({
            enabled,
            grant_version: enabled ? 3 : 2,
        });
        const response = await request(app())
            .post(`/api/marketplace/apps/chatgpt-crm-mcp/writes/${action}`)
            .send({});

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            success: true,
            enabled,
            grant_version: enabled ? 3 : 2,
        });
        expect(marketplaceService.setChatgptMcpWrites).toHaveBeenCalledWith(
            'company-a',
            'admin-a',
            enabled,
            { requestId: 'request-a' }
        );
    });

    test('tenant-admin denial preserves the fail-closed 403 code', async () => {
        marketplaceService.setChatgptMcpWrites.mockRejectedValueOnce(
            new MockMarketplaceServiceError(
                'Only an active tenant administrator can configure this connector.',
                'TENANT_ADMIN_REQUIRED',
                403
            )
        );
        const response = await request(app())
            .post('/api/marketplace/apps/chatgpt-crm-mcp/writes/enable')
            .send({});

        expect(response.status).toBe(403);
        expect(response.body).toMatchObject({
            success: false,
            code: 'TENANT_ADMIN_REQUIRED',
        });
    });
});
