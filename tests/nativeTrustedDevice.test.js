'use strict';

const express = require('express');
const request = require('supertest');

const ORIGINAL_ENV = {
    FEATURE_AUTH_ENABLED: process.env.FEATURE_AUTH_ENABLED,
    FEATURE_SMS_2FA: process.env.FEATURE_SMS_2FA,
    KEYCLOAK_REALM_URL: process.env.KEYCLOAK_REALM_URL,
    CHATGPT_MCP_CLIENT_ID: process.env.CHATGPT_MCP_CLIENT_ID,
};

process.env.FEATURE_AUTH_ENABLED = 'true';
process.env.FEATURE_SMS_2FA = 'true';
process.env.KEYCLOAK_REALM_URL = 'https://auth.albusto.test/realms/crm-prod';
process.env.CHATGPT_MCP_CLIENT_ID = 'chatgpt-crm-mcp';

jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
jest.mock('jwks-rsa', () => jest.fn(() => ({ getSigningKey: jest.fn() })));
jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/userService', () => ({
    findOrCreateUser: jest.fn(async ({ sub, email }) => ({
        id: 'mobile-user-a',
        keycloak_sub: sub,
        email,
        company_id: 'company-a',
        phone_verified_at: new Date('2026-07-01T00:00:00Z'),
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
        membership: { role_key: 'provider', status: 'active' },
        permissions: ['jobs.view', 'provider.enabled'],
        scopes: { job_visibility: 'assigned_only' },
    })),
}));
jest.mock('../backend/src/services/otpService', () => ({
    isDeviceTrusted: jest.fn(),
    validateOtpToken: jest.fn(),
    trustDevice: jest.fn(),
    sendCode: jest.fn(),
    verifyCode: jest.fn(),
}));

const jwt = require('jsonwebtoken');
const db = require('../backend/src/db/connection');
const otpService = require('../backend/src/services/otpService');
const { authenticate, requireCompanyAccess } = require('../backend/src/middleware/keycloakAuth');
const authDeviceRouter = require('../backend/src/routes/authDevice');

function claims(overrides = {}) {
    return {
        sub: 'mobile-sub-a',
        email: 'tech-a@example.test',
        azp: 'crm-mobile',
        realm_access: { roles: ['company_member'] },
        ...overrides,
    };
}

function syncProbeApp() {
    const app = express();
    app.get('/api/sync/jobs', authenticate, requireCompanyAccess, (req, res) => {
        res.json({ ok: true, company_id: req.companyFilter.company_id });
    });
    return app;
}

function authApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authenticate, authDeviceRouter);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    jwt.verify.mockImplementation((_token, _key, _options, callback) => callback(null, claims()));
    otpService.isDeviceTrusted.mockImplementation(async (_userId, credential) => (
        credential === 'native-good' || credential === 'cookie-good'
    ));
    otpService.validateOtpToken.mockReturnValue({ phone: '+16175550123', purpose: 'login' });
    otpService.trustDevice.mockResolvedValue({
        deviceId: '0123456789abcdef0123456789abcdef',
        maxAgeSec: 30 * 86400,
    });
    db.query.mockResolvedValue({ rows: [{ phone_e164: '+16175550123' }] });
});

afterAll(() => {
    for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

describe('native trusted-device 2FA transport', () => {
    test('phone-verified and untrusted receives PHONE_VERIFICATION_REQUIRED on /api/sync/jobs', async () => {
        const response = await request(syncProbeApp())
            .get('/api/sync/jobs')
            .set('Authorization', 'Bearer mobile-token');

        expect(response.status).toBe(401);
        expect(response.body.code).toBe('PHONE_VERIFICATION_REQUIRED');
        expect(otpService.isDeviceTrusted).toHaveBeenCalledWith('mobile-user-a', null);
    });

    test('X-Albusto-Device credential passes the same trusted_devices check', async () => {
        const response = await request(syncProbeApp())
            .get('/api/sync/jobs')
            .set('Authorization', 'Bearer mobile-token')
            .set('X-Albusto-Device', 'native-good');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ ok: true, company_id: 'company-a' });
        expect(otpService.isDeviceTrusted.mock.calls).toEqual([
            ['mobile-user-a', null],
            ['mobile-user-a', 'native-good'],
        ]);
    });

    test('existing albusto_td cookie path remains valid, even with an invalid native header', async () => {
        const response = await request(syncProbeApp())
            .get('/api/sync/jobs')
            .set('Authorization', 'Bearer web-token')
            .set('Cookie', 'albusto_td=cookie-good')
            .set('X-Albusto-Device', 'invalid-native');

        expect(response.status).toBe(200);
        expect(otpService.isDeviceTrusted).toHaveBeenCalledTimes(1);
        expect(otpService.isDeviceTrusted).toHaveBeenCalledWith('mobile-user-a', 'cookie-good');
    });
});

describe('POST /api/auth/trust-native-device', () => {
    test('returns a no-store credential once and never sets the web cookie', async () => {
        const response = await request(authApp())
            .post('/api/auth/trust-native-device')
            .set('Authorization', 'Bearer mobile-token')
            .send({
                otp_token: 'verified-login-otp',
                device_id: 'A4B25B71-7B0C-4550-AD7D-8C12CAAD0011',
                device_name: 'iPhone 17 Pro',
            });

        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers.pragma).toBe('no-cache');
        expect(response.headers['set-cookie']).toBeUndefined();
        expect(response.body).toEqual({
            ok: true,
            device_credential: '0123456789abcdef0123456789abcdef',
            trusted_days: 30,
            expires_in_seconds: 2592000,
        });
        expect(otpService.validateOtpToken).toHaveBeenCalledWith('verified-login-otp', 'login');
        expect(db.query).toHaveBeenCalledWith(
            'SELECT phone_e164 FROM crm_users WHERE id = $1',
            ['mobile-user-a'],
        );
        expect(otpService.trustDevice).toHaveBeenCalledWith(
            'mobile-user-a',
            expect.objectContaining({
                label: expect.stringMatching(/^native:[a-f0-9]{24}:iPhone 17 Pro$/),
            }),
        );
        expect(otpService.trustDevice.mock.calls[0][1].label)
            .not.toContain('A4B25B71-7B0C-4550-AD7D-8C12CAAD0011');
    });

    test('rejects a malformed device_id before minting a credential', async () => {
        const response = await request(authApp())
            .post('/api/auth/trust-native-device')
            .set('Authorization', 'Bearer mobile-token')
            .send({ otp_token: 'verified-login-otp', device_id: 'bad device' });

        expect(response.status).toBe(400);
        expect(response.body.code).toBe('VALIDATION_ERROR');
        expect(db.query).not.toHaveBeenCalled();
        expect(otpService.trustDevice).not.toHaveBeenCalled();
    });

    test('rejects an OTP proof issued for a different user phone', async () => {
        otpService.validateOtpToken.mockReturnValue({ phone: '+16175550999', purpose: 'login' });

        const response = await request(authApp())
            .post('/api/auth/trust-native-device')
            .set('Authorization', 'Bearer mobile-token')
            .send({ otp_token: 'foreign-login-otp', device_id: 'install-device-0001' });

        expect(response.status).toBe(401);
        expect(response.body.code).toBe('OTP_REQUIRED');
        expect(otpService.trustDevice).not.toHaveBeenCalled();
    });
});
