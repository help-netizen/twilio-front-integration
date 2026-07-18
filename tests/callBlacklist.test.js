'use strict';

const ORIGINAL_AUTH_ENABLED = process.env.FEATURE_AUTH_ENABLED;
const ORIGINAL_REALM_URL = process.env.KEYCLOAK_REALM_URL;
process.env.FEATURE_AUTH_ENABLED = 'true';
process.env.KEYCLOAK_REALM_URL = 'http://keycloak.test/realms/albusto';

const COMPANY_A = '11111111-1111-1111-1111-111111111111';
const COMPANY_B = '22222222-2222-2222-2222-222222222222';
const POISONED_COMPANY = '99999999-9999-9999-9999-999999999999';
const ACTOR_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const mockDbQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({
    query: (...args) => mockDbQuery(...args),
}));

const mockJwtVerify = jest.fn();
jest.mock('jsonwebtoken', () => ({
    verify: (...args) => mockJwtVerify(...args),
}));
jest.mock('jwks-rsa', () => jest.fn(() => ({ getSigningKey: jest.fn() })));

const mockFindOrCreateUser = jest.fn();
jest.mock('../backend/src/services/userService', () => ({
    findOrCreateUser: (...args) => mockFindOrCreateUser(...args),
}));

const mockResolveAuthzContext = jest.fn();
jest.mock('../backend/src/services/authorizationService', () => ({
    buildDevAuthzContext: jest.fn(),
    resolveAuthzContext: (...args) => mockResolveAuthzContext(...args),
}));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

jest.mock('../backend/src/services/telephonyTenantService', () => ({}));
jest.mock('../backend/src/services/territoryGeoService', () => ({}));
jest.mock('../backend/src/services/a2pService', () => ({}));

const express = require('express');
const request = require('supertest');
const { authenticate, requireCompanyAccess } = require('../backend/src/middleware/keycloakAuth');
const { requirePermission } = require('../backend/src/middleware/authorization');
const router = require('../backend/src/routes/telephonyNumbers');
const callBlacklistService = require('../backend/src/services/callBlacklistService');

function authz(permissions = ['tenant.telephony.manage']) {
    return {
        scope: 'tenant',
        platform_role: 'none',
        company: { id: COMPANY_A, name: 'Company A', status: 'active' },
        membership: { role_key: 'tenant_admin' },
        permissions,
        scopes: {},
    };
}

function app() {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
        // Security tripwire: routes must ignore this legacy/poisoned field.
        req.companyId = POISONED_COMPANY;
        next();
    });
    instance.use(
        '/api/telephony/numbers',
        authenticate,
        requirePermission('tenant.telephony.manage'),
        requireCompanyAccess,
        router
    );
    return instance;
}

function authed(method, path) {
    return request(app())[method](path).set('Authorization', 'Bearer valid-token');
}

beforeEach(() => {
    jest.clearAllMocks();
    mockJwtVerify.mockImplementation((_token, _key, _options, callback) => callback(null, {
        sub: 'kc-user',
        email: 'admin@example.com',
        name: 'Admin User',
        realm_access: { roles: ['company_admin'] },
    }));
    mockFindOrCreateUser.mockResolvedValue({ id: ACTOR_ID, company_id: COMPANY_A });
    mockResolveAuthzContext.mockResolvedValue(authz());
    mockDbQuery.mockResolvedValue({ rows: [] });
});

afterAll(() => {
    if (ORIGINAL_AUTH_ENABLED === undefined) delete process.env.FEATURE_AUTH_ENABLED;
    else process.env.FEATURE_AUTH_ENABLED = ORIGINAL_AUTH_ENABLED;
    if (ORIGINAL_REALM_URL === undefined) delete process.env.KEYCLOAK_REALM_URL;
    else process.env.KEYCLOAK_REALM_URL = ORIGINAL_REALM_URL;
});

describe('CALL-BLACKLIST-001 settings routes', () => {
    test('requires authentication', async () => {
        const response = await request(app()).get('/api/telephony/numbers/blacklist');

        expect(response.status).toBe(401);
        expect(response.body.code).toBe('AUTH_REQUIRED');
        expect(mockDbQuery).not.toHaveBeenCalled();
    });

    test('requires tenant.telephony.manage', async () => {
        mockResolveAuthzContext.mockResolvedValue(authz([]));

        const response = await authed('get', '/api/telephony/numbers/blacklist');

        expect(response.status).toBe(403);
        expect(response.body.code).toBe('ACCESS_DENIED');
        expect(mockDbQuery).not.toHaveBeenCalled();
    });

    test('lists only req.companyFilter company rows and ignores req.companyId', async () => {
        mockDbQuery.mockResolvedValue({
            rows: [{ id: '1', phone_e164: '+16175550119', created_at: '2026-07-18T12:00:00.000Z' }],
        });

        const response = await authed('get', '/api/telephony/numbers/blacklist');

        expect(response.status).toBe(200);
        expect(response.body.numbers).toHaveLength(1);
        const [sql, params] = mockDbQuery.mock.calls[0];
        expect(sql).toMatch(/WHERE company_id = \$1/);
        expect(params).toEqual([COMPANY_A]);
        expect(params).not.toContain(POISONED_COMPANY);
    });

    test('rejects an incomplete phone before querying', async () => {
        const response = await authed('post', '/api/telephony/numbers/blacklist')
            .send({ phone_number: '617-555-01' });

        expect(response.status).toBe(400);
        expect(response.body.code).toBe('INVALID_PHONE_NUMBER');
        expect(mockDbQuery).not.toHaveBeenCalled();
    });

    test('normalizes and inserts with companyFilter plus crm_users actor id', async () => {
        mockDbQuery.mockResolvedValue({
            rows: [{ id: '8', phone_e164: '+16175550119', created_at: '2026-07-18T12:00:00.000Z' }],
        });

        const response = await authed('post', '/api/telephony/numbers/blacklist')
            .send({ phone_number: '(617) 555-0119' });

        expect(response.status).toBe(201);
        expect(response.body.number.phone_e164).toBe('+16175550119');
        const [sql, params] = mockDbQuery.mock.calls[0];
        expect(sql).toMatch(/INSERT INTO telephony_blacklist_numbers/);
        expect(params).toEqual([COMPANY_A, '+16175550119', ACTOR_ID]);
        expect(params).not.toContain(POISONED_COMPANY);
    });

    test('returns a stable duplicate response', async () => {
        const duplicate = new Error('duplicate');
        duplicate.code = '23505';
        mockDbQuery.mockRejectedValue(duplicate);

        const response = await authed('post', '/api/telephony/numbers/blacklist')
            .send({ phone_number: '+1 617 555 0119' });

        expect(response.status).toBe(409);
        expect(response.body).toMatchObject({
            ok: false,
            code: 'PHONE_ALREADY_BLACKLISTED',
            error: 'This number is already on the blacklist.',
        });
    });

    test('foreign-company delete is filtered to 404', async () => {
        mockDbQuery.mockResolvedValue({ rows: [] });

        const response = await authed('delete', '/api/telephony/numbers/blacklist/44');

        expect(response.status).toBe(404);
        const [sql, params] = mockDbQuery.mock.calls[0];
        expect(sql).toMatch(/WHERE id = \$1 AND company_id = \$2/);
        expect(params).toEqual(['44', COMPANY_A]);
        expect(params).not.toContain(POISONED_COMPANY);
    });
});

describe('CALL-BLACKLIST-001 pre-routing lookup service', () => {
    test('matches a canonical caller only inside the supplied company', async () => {
        mockDbQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] });

        await expect(callBlacklistService.isBlocked(COMPANY_B, '(857) 555-0142')).resolves.toBe(true);

        const [sql, params] = mockDbQuery.mock.calls[0];
        expect(sql).toMatch(/WHERE company_id = \$1 AND phone_e164 = \$2/);
        expect(params).toEqual([COMPANY_B, '+18575550142']);
    });

    test.each([
        ['6175550119', '+16175550119'],
        ['1 (617) 555-0119', '+16175550119'],
        ['+44 20 7946 0958', null],
        ['61755501', null],
    ])('normalizes %s to %s', (input, expected) => {
        expect(callBlacklistService.normalizePhoneNumber(input)).toBe(expected);
    });
});

