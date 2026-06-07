const express = require('express');
const request = require('supertest');

describe('CRM authenticated route auth gate', () => {
    let originalFeatureAuth;

    beforeEach(() => {
        jest.resetModules();
        originalFeatureAuth = process.env.FEATURE_AUTH_ENABLED;
        process.env.FEATURE_AUTH_ENABLED = 'true';
    });

    afterEach(() => {
        if (originalFeatureAuth === undefined) {
            delete process.env.FEATURE_AUTH_ENABLED;
        } else {
            process.env.FEATURE_AUTH_ENABLED = originalFeatureAuth;
        }
        jest.resetModules();
    });

    test('CRM REST and authenticated MCP route chains return 401 without bearer token', async () => {
        const { authenticate, requireCompanyAccess } = require('../../backend/src/middleware/keycloakAuth');
        const app = express();
        app.use(express.json());
        app.use('/api/crm', authenticate, requireCompanyAccess, (req, res) => res.json({ ok: true }));
        app.use('/api/crm/mcp', authenticate, requireCompanyAccess, (req, res) => res.json({ ok: true }));

        const crm = await request(app).get('/api/crm/accounts');
        expect(crm.status).toBe(401);
        expect(crm.body.code).toBe('AUTH_REQUIRED');

        const mcp = await request(app).post('/api/crm/mcp/jsonrpc').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        expect(mcp.status).toBe(401);
        expect(mcp.body.code).toBe('AUTH_REQUIRED');
    });
});
