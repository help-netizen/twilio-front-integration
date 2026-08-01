'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const mockMintRunToken = jest.fn();

jest.mock('../backend/src/middleware/keycloakAuth', () => ({
    authenticate: (req, _res, next) => {
        const role = req.headers['x-test-role'];
        req.user = { crmUser: { id: 'user-1' }, _devMode: role === 'dev' };
        req.authz = { platform_role: role === 'super_admin' ? 'super_admin' : 'none' };
        next();
    },
}));
jest.mock('../backend/src/middleware/authorization', () => ({
    requirePlatformRole: (...roles) => (req, res, next) => {
        if (!roles.includes(req.authz?.platform_role)) {
            return res.status(403).json({
                ok: false,
                code: 'ACCESS_DENIED',
                message: 'Platform role required.',
                request_id: req.requestId,
            });
        }
        next();
    },
}));
jest.mock('../backend/src/services/appRuntimeTokenService', () => ({
    mintRunToken: mockMintRunToken,
}));

const router = require('../backend/src/routes/appRuntimeDevTokens');

function buildApp() {
    const app = express();
    app.use('/api/platform/app-runtime', router);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    process.env.APP_RUNTIME_DEV_TOKEN_ROUTE_ENABLED = 'true';
    mockMintRunToken.mockImplementation(async ({ ttlSeconds }) => {
        if (ttlSeconds !== undefined && (!Number.isInteger(ttlSeconds) || ttlSeconds > 300)) {
            const { AppRuntimeError } = require('../backend/src/services/appRuntimeErrors');
            throw new AppRuntimeError('INVALID_REQUEST', 'ttl_seconds is invalid.', 400);
        }
        return {
            token: 'raw-run-token',
            runId: '30000000-0000-4000-8000-000000000001',
            expiresAt: '2026-08-01T00:00:00.000Z',
        };
    });
});

afterAll(() => {
    delete process.env.APP_RUNTIME_DEV_TOKEN_ROUTE_ENABLED;
});

describe('APP-GW-001 development token route', () => {
    test('SAB dev mint route is not public: env-off is 404 before authentication', async () => {
        process.env.APP_RUNTIME_DEV_TOKEN_ROUTE_ENABLED = 'false';
        const response = await request(buildApp())
            .post('/api/platform/app-runtime/dev-tokens')
            .send({ installation_id: '1', version_id: '20000000-0000-4000-8000-000000000001' });
        expect(response.status).toBe(404);
        expect(response.body.code).toBe('NOT_FOUND');
        expect(mockMintRunToken).not.toHaveBeenCalled();
    });

    test.each(['tenant', 'platform_non_admin', 'dev'])(
        'SAB dev mint route is not public: %s receives 403',
        async (role) => {
            const response = await request(buildApp())
                .post('/api/platform/app-runtime/dev-tokens')
                .set('x-test-role', role)
                .send({ installation_id: '1', version_id: '20000000-0000-4000-8000-000000000001' });
            expect(response.status).toBe(403);
            expect(mockMintRunToken).not.toHaveBeenCalled();
        }
    );

    test('super-admin response includes token/run/expiry and accepts no company selector', async () => {
        const response = await request(buildApp())
            .post('/api/platform/app-runtime/dev-tokens')
            .set('x-test-role', 'super_admin')
            .send({
                installation_id: '1',
                version_id: '20000000-0000-4000-8000-000000000001',
                ttl_seconds: 120,
            });
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            ok: true,
            token: 'raw-run-token',
            run_id: '30000000-0000-4000-8000-000000000001',
            expires_at: '2026-08-01T00:00:00.000Z',
        });
        expect(mockMintRunToken).toHaveBeenCalledWith({
            installationId: '1',
            versionId: '20000000-0000-4000-8000-000000000001',
            ttlSeconds: 120,
        });

        const forbidden = await request(buildApp())
            .post('/api/platform/app-runtime/dev-tokens')
            .set('x-test-role', 'super_admin')
            .send({
                company_id: '10000000-0000-4000-8000-000000000001',
                installation_id: '1',
                version_id: '20000000-0000-4000-8000-000000000001',
            });
        expect(forbidden.status).toBe(400);
        expect(forbidden.body.code).toBe('INVALID_REQUEST');
    });

    test('TTL values above 300 seconds are rejected and token material is not logged', async () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const response = await request(buildApp())
                .post('/api/platform/app-runtime/dev-tokens')
                .set('x-test-role', 'super_admin')
                .send({
                    installation_id: '1',
                    version_id: '20000000-0000-4000-8000-000000000001',
                    ttl_seconds: 301,
                });
            expect(response.status).toBe(400);
            expect(response.body.code).toBe('INVALID_REQUEST');
            expect(JSON.stringify([
                ...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls,
            ])).not.toContain('raw-run-token');
        } finally {
            logSpy.mockRestore();
            warnSpy.mockRestore();
            errorSpy.mockRestore();
        }
    });

    test('D1 protected server diff contains exactly the two requires and two mounts', () => {
        const source = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
        expect(source.match(/const appRuntimeGatewayRouter = require\('\.\.\/backend\/src\/routes\/appRuntimeGateway'\);/g)).toHaveLength(1);
        expect(source.match(/const appRuntimeDevTokensRouter = require\('\.\.\/backend\/src\/routes\/appRuntimeDevTokens'\);/g)).toHaveLength(1);
        expect(source.match(/app\.use\('\/internal\/app-runtime', appRuntimeGatewayRouter\);/g)).toHaveLength(1);
        expect(source.match(/app\.use\('\/api\/platform\/app-runtime', appRuntimeDevTokensRouter\);/g)).toHaveLength(1);
    });
});
