'use strict';

process.env.KEYCLOAK_REALM_URL = 'https://keycloak.example.test/realms/test-realm';
process.env.KEYCLOAK_REALM = 'test-realm';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

jest.mock('node-fetch', () => jest.fn());
jest.mock('../backend/src/services/platformUserService', () => ({
    listUsers: jest.fn(),
    getUserForPasswordReset: jest.fn(),
}));
jest.mock('../backend/src/services/platformStatsService', () => ({
    getStats: jest.fn(),
}));
jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn().mockResolvedValue(undefined),
}));

const fetch = require('node-fetch');
const platformUserService = require('../backend/src/services/platformUserService');
const platformStatsService = require('../backend/src/services/platformStatsService');
const auditService = require('../backend/src/services/auditService');
const { requirePlatformRole } = require('../backend/src/middleware/authorization');
const platformUsersRouter = require('../backend/src/routes/platformUsers');
const platformStatsRouter = require('../backend/src/routes/platformStats');

const ACTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TARGET_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const COMPANY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = {
            email: 'actor@example.test',
            crmUser: { id: ACTOR_ID },
        };
        req.authz = { platform_role: req.get('x-platform-role') || 'none' };
        req.traceId = 'trace-superadmin-dashboard';
        next();
    });
    app.use('/api/platform/users', requirePlatformRole('super_admin'), platformUsersRouter);
    app.use('/api/platform/stats', requirePlatformRole('super_admin'), platformStatsRouter);
    return app;
}

function mockKeycloakSuccess() {
    fetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'admin-token' }) })
        .mockResolvedValueOnce({ ok: true });
}

beforeEach(() => {
    jest.clearAllMocks();
    auditService.log.mockResolvedValue(undefined);
});

describe('SUPERADMIN-DASH-BE platform guard', () => {
    test('SAB-SA-GUARD · all three production mounts require super_admin', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
        expect(source).toContain(
            "app.use('/api/platform/users', authenticate, requirePlatformRole('super_admin'), platformUsersRouter);"
        );
        expect(source).toContain(
            "app.use('/api/platform/stats', authenticate, requirePlatformRole('super_admin'), platformStatsRouter);"
        );
        expect(source).toContain(
            "app.use('/api/platform/companies', authenticate, requirePlatformRole('super_admin'), platformCompaniesRouter);"
        );
    });

    test.each([
        ['GET', '/api/platform/users'],
        ['GET', '/api/platform/stats'],
        ['POST', `/api/platform/users/${TARGET_ID}/reset-password`],
    ])('normal company user receives 403 for %s %s', async (method, url) => {
        const call = request(makeApp())[method.toLowerCase()](url);
        if (method === 'POST') call.send({ mode: 'temp' });
        const response = await call;
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('ACCESS_DENIED');
    });
});

describe('GET /api/platform/users', () => {
    test('returns the service envelope and clamps pagination', async () => {
        const users = [{
            id: TARGET_ID,
            email: 'target@example.test',
            company_id: COMPANY_ID,
            company_name: 'Target Co',
            last_login_at: '2026-07-22T12:00:00.000Z',
        }];
        platformUserService.listUsers.mockResolvedValue({ users, total: 1, page: 2, limit: 100 });

        const response = await request(makeApp())
            .get('/api/platform/users?search=target%40example.test&page=2&limit=500')
            .set('x-platform-role', 'super_admin');

        expect(response.status).toBe(200);
        expect(platformUserService.listUsers).toHaveBeenCalledWith({
            search: 'target@example.test',
            page: 2,
            limit: 100,
        });
        expect(response.body).toEqual({ ok: true, users, total: 1, page: 2, limit: 100 });
    });
});

describe('GET /api/platform/stats', () => {
    test('returns totals and the zero-fill-ready growth envelope', async () => {
        const stats = {
            companies: { total: 10, today: 1, last7: 3, last30: 8 },
            users: { total: 25, today: 2, last7: 7, last30: 20 },
            growth: [{ date: '2026-07-22', companies: 1, users: 2 }],
        };
        platformStatsService.getStats.mockResolvedValue(stats);

        const response = await request(makeApp())
            .get('/api/platform/stats')
            .set('x-platform-role', 'super_admin');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ ok: true, ...stats });
    });
});

describe('POST /api/platform/users/:userId/reset-password', () => {
    beforeEach(() => {
        platformUserService.getUserForPasswordReset.mockResolvedValue({
            id: TARGET_ID,
            keycloak_sub: 'kc-target-id',
            email: 'target@example.test',
            company_id: COMPANY_ID,
        });
    });

    test('mode=temp returns a temporary password and resets it as temporary in Keycloak', async () => {
        mockKeycloakSuccess();

        const response = await request(makeApp())
            .post(`/api/platform/users/${TARGET_ID}/reset-password`)
            .set('x-platform-role', 'super_admin')
            .send({ mode: 'temp' });

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ ok: true, mode: 'temp' });
        expect(response.body.temporary_password).toEqual(expect.any(String));
        expect(response.body.temporary_password).not.toHaveLength(0);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch.mock.calls[1][0]).toBe(
            'https://keycloak.example.test/admin/realms/test-realm/users/kc-target-id/reset-password'
        );
        expect(fetch.mock.calls[1][1]).toMatchObject({
            method: 'PUT',
            body: JSON.stringify({
                type: 'password',
                value: response.body.temporary_password,
                temporary: true,
            }),
        });
        expect(auditService.log).toHaveBeenCalledWith(expect.objectContaining({
            actor_id: ACTOR_ID,
            action: 'user.password_reset',
            target_id: TARGET_ID,
            company_id: COMPANY_ID,
            details: { mode: 'temp' },
        }));
    });

    test('SAB-SA-RESET-EMAIL · mode=email reaches execute-actions-email and never returns a password', async () => {
        mockKeycloakSuccess();

        const response = await request(makeApp())
            .post(`/api/platform/users/${TARGET_ID}/reset-password`)
            .set('x-platform-role', 'super_admin')
            .send({ mode: 'email' });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ ok: true, mode: 'email', sent: true });
        expect(response.body).not.toHaveProperty('temporary_password');
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch.mock.calls[1][0]).toBe(
            'https://keycloak.example.test/admin/realms/test-realm/users/kc-target-id/execute-actions-email'
        );
        expect(fetch.mock.calls[1][1]).toMatchObject({
            method: 'PUT',
            body: JSON.stringify(['UPDATE_PASSWORD']),
        });
        expect(fetch.mock.calls[1][0]).not.toContain('/reset-password');
        expect(auditService.log).toHaveBeenCalledWith(expect.objectContaining({
            actor_id: ACTOR_ID,
            details: { mode: 'email' },
        }));
    });

    test('returns 404 for an unknown platform user', async () => {
        platformUserService.getUserForPasswordReset.mockResolvedValue(null);

        const response = await request(makeApp())
            .post(`/api/platform/users/${TARGET_ID}/reset-password`)
            .set('x-platform-role', 'super_admin')
            .send({ mode: 'temp' });

        expect(response.status).toBe(404);
        expect(fetch).not.toHaveBeenCalled();
        expect(auditService.log).not.toHaveBeenCalled();
    });

    test('rejects an unsupported delivery mode', async () => {
        const response = await request(makeApp())
            .post(`/api/platform/users/${TARGET_ID}/reset-password`)
            .set('x-platform-role', 'super_admin')
            .send({ mode: 'sms' });

        expect(response.status).toBe(422);
        expect(platformUserService.getUserForPasswordReset).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });
});
