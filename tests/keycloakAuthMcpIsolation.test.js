'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const ORIGINAL_ENV = {
    FEATURE_AUTH_ENABLED: process.env.FEATURE_AUTH_ENABLED,
    KEYCLOAK_REALM_URL: process.env.KEYCLOAK_REALM_URL,
    CHATGPT_MCP_CLIENT_ID: process.env.CHATGPT_MCP_CLIENT_ID,
};

process.env.FEATURE_AUTH_ENABLED = 'true';
process.env.KEYCLOAK_REALM_URL = 'https://auth.albusto.test/realms/crm-prod';
process.env.CHATGPT_MCP_CLIENT_ID = 'chatgpt-crm-mcp';

jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
jest.mock('jwks-rsa', () => jest.fn(() => ({ getSigningKey: jest.fn() })));
jest.mock('../backend/src/services/userService', () => ({
    findOrCreateUser: jest.fn(async ({ sub, email }) => ({
        id: 'human-a',
        keycloak_sub: sub,
        email,
        company_id: 'company-a',
    })),
}));
jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn(async () => {}),
}));
jest.mock('../backend/src/services/authorizationService', () => ({
    buildDevAuthzContext: jest.fn(),
    resolveAuthzContext: jest.fn(async () => ({
        scope: 'tenant',
        platform_role: 'none',
        company: { id: 'company-a', status: 'active' },
        membership: { role_key: 'tenant_admin', status: 'active' },
        permissions: ['jobs.view'],
        scopes: {},
    })),
}));

const jwt = require('jsonwebtoken');
const userService = require('../backend/src/services/userService');
const { authenticate, requireCompanyAccess } = require('../backend/src/middleware/keycloakAuth');

function claims(overrides = {}) {
    return {
        iss: process.env.KEYCLOAK_REALM_URL,
        sub: 'human-sub-a',
        email: 'admin-a@example.test',
        azp: 'crm-web',
        realm_access: { roles: ['company_admin'] },
        ...overrides,
    };
}

function app() {
    const server = express();
    server.get('/api/auth-boundary-probe', authenticate, requireCompanyAccess, (req, res) => {
        res.json({ company_id: req.companyFilter.company_id, actor_id: req.user.crmUser.id });
    });
    return server;
}

beforeEach(() => {
    jest.clearAllMocks();
});

afterAll(() => {
    for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

describe('ordinary Keycloak middleware isolates the ChatGPT connector client', () => {
    test.each([
        ['azp', claims({ azp: 'chatgpt-crm-mcp' })],
        ['client_id', claims({ azp: undefined, client_id: 'chatgpt-crm-mcp' })],
        ['conflicting client_id', claims({ azp: 'crm-web', client_id: 'chatgpt-crm-mcp' })],
    ])('connector token identified by %s is rejected on a normal /api route', async (_claim, decoded) => {
        jwt.verify.mockImplementation((_token, _key, _options, callback) => callback(null, decoded));

        const res = await request(app())
            .get('/api/auth-boundary-probe')
            .set('Authorization', 'Bearer connector-token');

        expect(res.status).toBe(401);
        expect(res.body.code).toBe('AUTH_INVALID');
        expect(userService.findOrCreateUser).not.toHaveBeenCalled();
    });

    test('the real web client azp remains distinct and its normal token is authorized', async () => {
        const authProviderSource = fs.readFileSync(
            path.join(__dirname, '../frontend/src/auth/AuthProvider.tsx'),
            'utf8'
        );
        expect(authProviderSource).toContain("VITE_KEYCLOAK_CLIENT_ID || 'crm-web'");
        expect('crm-web').not.toBe(process.env.CHATGPT_MCP_CLIENT_ID);
        jwt.verify.mockImplementation((_token, _key, _options, callback) => callback(null, claims()));

        const res = await request(app())
            .get('/api/auth-boundary-probe')
            .set('Authorization', 'Bearer web-token');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ company_id: 'company-a', actor_id: 'human-a' });
        expect(userService.findOrCreateUser).toHaveBeenCalledTimes(1);
    });

    test('crm-mobile azp remains distinct and its normal /api token is authorized', async () => {
        jwt.verify.mockImplementation((_token, _key, _options, callback) => callback(null, claims({
            azp: 'crm-mobile',
            realm_access: { roles: ['company_member'] },
        })));

        const res = await request(app())
            .get('/api/auth-boundary-probe')
            .set('Authorization', 'Bearer mobile-token');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ company_id: 'company-a', actor_id: 'human-a' });
        expect(userService.findOrCreateUser).toHaveBeenCalledTimes(1);
    });
});
