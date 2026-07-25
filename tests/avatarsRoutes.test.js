'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn(() => Promise.resolve()),
}));

jest.mock('../backend/src/services/avatarsService', () => {
    class AvatarsServiceError extends Error {
        constructor(code, message, httpStatus = 400) {
            super(message);
            this.code = code;
            this.httpStatus = httpStatus;
        }
    }
    return {
        AvatarsServiceError,
        getOverview: jest.fn(),
        connectSelf: jest.fn(),
        setWrites: jest.fn(),
        setSends: jest.fn(),
        disconnectSelf: jest.fn(),
    };
});

const avatarsService = require('../backend/src/services/avatarsService');
const avatarsRouter = require('../backend/src/routes/avatars');
const { requireCompanyAccess } = require('../backend/src/middleware/keycloakAuth');

const COMPANY_A = '11111111-1111-4111-8111-111111111111';
const MEMBER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function authenticateHarness(req, res, next) {
    const token = req.headers.authorization;
    if (!token) {
        return res.status(401).json({ code: 'AUTH_REQUIRED' });
    }
    req.user = {
        crmUser: { id: MEMBER_A },
        email: 'member-a@example.test',
        roles: [],
    };
    req.authz = token === 'Bearer foreign'
        ? {
            scope: 'tenant',
            company: null,
            membership: null,
            permissions: [],
        }
        : {
            scope: 'tenant',
            company: { id: COMPANY_A, status: 'active' },
            membership: { status: 'active', role_key: 'provider' },
            permissions: [],
        };
    next();
}

function appWithMemberGuard() {
    const app = express();
    app.use(express.json());
    app.use('/api/avatars', authenticateHarness, requireCompanyAccess, avatarsRouter);
    return app;
}

describe('AVATARS-001 Phase C member routes', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        avatarsService.getOverview.mockResolvedValue({
            installation_enabled: true,
            me: {
                connected: true,
                base: 'chatgpt',
                mode: 'mcp',
                writes_enabled: false,
                sends_enabled: false,
            },
            roster: [{
                owner_user_id: MEMBER_A,
                owner_name: 'Member A',
                base: 'chatgpt',
                connection_status: 'connected',
                presence: 'idle',
                is_me: true,
            }],
        });
        avatarsService.connectSelf.mockResolvedValue({
            connected: true,
            base: 'chatgpt',
            mode: 'mcp',
            writes_enabled: false,
            sends_enabled: false,
        });
        avatarsService.setWrites.mockResolvedValue({
            writes_enabled: true,
            sends_enabled: false,
        });
        avatarsService.setSends.mockResolvedValue({
            writes_enabled: true,
            sends_enabled: true,
        });
        avatarsService.disconnectSelf.mockResolvedValue({ connected: false });
    });

    test('mount guard rejects unauthenticated and missing-company callers', async () => {
        await request(appWithMemberGuard())
            .get('/api/avatars')
            .expect(401, { code: 'AUTH_REQUIRED' });
        await request(appWithMemberGuard())
            .get('/api/avatars')
            .set('Authorization', 'Bearer foreign')
            .expect(403)
            .expect((response) => {
                expect(response.body.code).toBe('TENANT_CONTEXT_REQUIRED');
            });
        expect(avatarsService.getOverview).not.toHaveBeenCalled();
    });

    test('ordinary member without tenant.integrations.manage reads the exact roster shape', async () => {
        const response = await request(appWithMemberGuard())
            .get('/api/avatars')
            .set('Authorization', 'Bearer member')
            .expect(200);

        expect(response.body).toEqual({
            installation_enabled: true,
            me: {
                connected: true,
                base: 'chatgpt',
                mode: 'mcp',
                writes_enabled: false,
                sends_enabled: false,
            },
            roster: [{
                owner_user_id: MEMBER_A,
                owner_name: 'Member A',
                base: 'chatgpt',
                connection_status: 'connected',
                presence: 'idle',
                is_me: true,
            }],
        });
        expect(avatarsService.getOverview).toHaveBeenCalledWith(COMPANY_A, MEMBER_A);
    });

    test('self connect defaults to ChatGPT, accepts Claude, and rejects unsupported/targetable input', async () => {
        await request(appWithMemberGuard())
            .post('/api/avatars/me/connect')
            .set('Authorization', 'Bearer member')
            .send({})
            .expect(200)
            .expect({
                connected: true,
                base: 'chatgpt',
                mode: 'mcp',
                writes_enabled: false,
                sends_enabled: false,
            });
        avatarsService.connectSelf.mockResolvedValueOnce({
            connected: true,
            base: 'claude',
            mode: 'mcp',
            writes_enabled: false,
            sends_enabled: false,
        });
        await request(appWithMemberGuard())
            .post('/api/avatars/me/connect')
            .set('Authorization', 'Bearer member')
            .send({ base: 'claude' })
            .expect(200)
            .expect({
                connected: true,
                base: 'claude',
                mode: 'mcp',
                writes_enabled: false,
                sends_enabled: false,
            });
        await request(appWithMemberGuard())
            .post('/api/avatars/me/disconnect')
            .set('Authorization', 'Bearer member')
            .send({})
            .expect(200, { connected: false });

        expect(avatarsService.connectSelf).toHaveBeenNthCalledWith(
            1,
            COMPANY_A,
            MEMBER_A,
            'chatgpt'
        );
        expect(avatarsService.connectSelf).toHaveBeenNthCalledWith(
            2,
            COMPANY_A,
            MEMBER_A,
            'claude'
        );
        expect(avatarsService.disconnectSelf).toHaveBeenCalledWith(COMPANY_A, MEMBER_A);

        await request(appWithMemberGuard())
            .post('/api/avatars/me/connect')
            .set('Authorization', 'Bearer member')
            .send({ base: 'gemini' })
            .expect(400, {
                code: 'AVATAR_BASE_UNSUPPORTED',
                message: 'Avatar base must be chatgpt or claude.',
            });
        await request(appWithMemberGuard())
            .post('/api/avatars/me/connect')
            .set('Authorization', 'Bearer member')
            .send({ base: 'claude', owner_user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })
            .expect(400);
        await request(appWithMemberGuard())
            .post('/api/avatars/me/disconnect')
            .set('Authorization', 'Bearer member')
            .send({ owner_user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })
            .expect(400, {
                code: 'INVALID_REQUEST',
                message: 'Request body must be empty.',
            });
        expect(avatarsService.connectSelf).toHaveBeenCalledTimes(2);
        expect(avatarsService.disconnectSelf).toHaveBeenCalledTimes(1);
    });

    test('Writes and Sends accept exactly one boolean and never a target owner', async () => {
        await request(appWithMemberGuard())
            .post('/api/avatars/me/writes')
            .set('Authorization', 'Bearer member')
            .send({ enabled: true })
            .expect(200, {
                writes_enabled: true,
                sends_enabled: false,
            });
        await request(appWithMemberGuard())
            .post('/api/avatars/me/sends')
            .set('Authorization', 'Bearer member')
            .send({ enabled: true })
            .expect(200, {
                writes_enabled: true,
                sends_enabled: true,
            });
        expect(avatarsService.setWrites).toHaveBeenCalledWith(
            COMPANY_A,
            MEMBER_A,
            true,
            { requestId: undefined }
        );
        expect(avatarsService.setSends).toHaveBeenCalledWith(
            COMPANY_A,
            MEMBER_A,
            true,
            { requestId: undefined }
        );

        await request(appWithMemberGuard())
            .post('/api/avatars/me/writes')
            .set('Authorization', 'Bearer member')
            .send({
                enabled: true,
                owner_user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            })
            .expect(400);
        await request(appWithMemberGuard())
            .post('/api/avatars/me/sends')
            .set('Authorization', 'Bearer member')
            .send({ enabled: 'true' })
            .expect(400);
        expect(avatarsService.setWrites).toHaveBeenCalledTimes(1);
        expect(avatarsService.setSends).toHaveBeenCalledTimes(1);
    });

    test('service errors preserve their fail-closed status and code', async () => {
        avatarsService.connectSelf.mockRejectedValueOnce(
            new avatarsService.AvatarsServiceError(
                'AVATARS_NOT_ENABLED',
                'Avatars is not enabled for this company.',
                409
            )
        );
        await request(appWithMemberGuard())
            .post('/api/avatars/me/connect')
            .set('Authorization', 'Bearer member')
            .send({})
            .expect(409, {
                code: 'AVATARS_NOT_ENABLED',
                message: 'Avatars is not enabled for this company.',
            });
    });

    test('src/server.js uses only the approved member-level mount chain', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'src', 'server.js'),
            'utf8'
        );
        const mount = "app.use('/api/avatars', authenticate, requireCompanyAccess, require('../backend/src/routes/avatars'));";
        expect(source).toContain(mount);
        expect(source).not.toContain(
            "app.use('/api/avatars', authenticate, requirePermission('tenant.integrations.manage')"
        );
    });
});
