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
jest.mock('../backend/src/db/connection', () => ({ query: (...args) => mockDbQuery(...args) }));

const mockJwtVerify = jest.fn();
jest.mock('jsonwebtoken', () => ({ verify: (...args) => mockJwtVerify(...args) }));
jest.mock('jwks-rsa', () => jest.fn(() => ({ getSigningKey: jest.fn() })));

const mockFindOrCreateUser = jest.fn();
jest.mock('../backend/src/services/userService', () => ({ findOrCreateUser: (...args) => mockFindOrCreateUser(...args) }));

const mockResolveAuthzContext = jest.fn();
jest.mock('../backend/src/services/authorizationService', () => ({
    buildDevAuthzContext: jest.fn(),
    resolveAuthzContext: (...args) => mockResolveAuthzContext(...args),
}));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../backend/src/services/sessionRevocationService', () => ({ isAccessTokenRevoked: jest.fn(async () => false) }));
jest.mock('../backend/src/services/telephonyTenantService', () => ({}));
jest.mock('../backend/src/services/territoryGeoService', () => ({}));
jest.mock('../backend/src/services/a2pService', () => ({}));

const express = require('express');
const request = require('supertest');
const { authenticate, requireCompanyAccess } = require('../backend/src/middleware/keycloakAuth');
const { requirePermission } = require('../backend/src/middleware/authorization');
const router = require('../backend/src/routes/telephonyNumbers');
const svc = require('../backend/src/services/callAgentExclusionService');

function authz(permissions = ['tenant.telephony.manage']) {
    return {
        scope: 'tenant', platform_role: 'none',
        company: { id: COMPANY_A, name: 'Company A', status: 'active' },
        membership: { role_key: 'tenant_admin' }, permissions, scopes: {},
    };
}
function app() {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => { req.companyId = POISONED_COMPANY; next(); });
    instance.use('/api/telephony/numbers', authenticate, requirePermission('tenant.telephony.manage'), requireCompanyAccess, router);
    return instance;
}
function authed(method, path) { return request(app())[method](path).set('Authorization', 'Bearer valid-token'); }

beforeEach(() => {
    jest.clearAllMocks();
    mockJwtVerify.mockImplementation((_t, _k, _o, cb) => cb(null, {
        sub: 'kc-user', iat: 1_700_000_000, email: 'admin@example.com', name: 'Admin User',
        realm_access: { roles: ['company_admin'] },
    }));
    mockFindOrCreateUser.mockResolvedValue({ id: ACTOR_ID, company_id: COMPANY_A });
    mockResolveAuthzContext.mockResolvedValue(authz());
    mockDbQuery.mockResolvedValue({ rows: [] });
});
afterAll(() => {
    if (ORIGINAL_AUTH_ENABLED === undefined) delete process.env.FEATURE_AUTH_ENABLED; else process.env.FEATURE_AUTH_ENABLED = ORIGINAL_AUTH_ENABLED;
    if (ORIGINAL_REALM_URL === undefined) delete process.env.KEYCLOAK_REALM_URL; else process.env.KEYCLOAK_REALM_URL = ORIGINAL_REALM_URL;
});

describe('AGENT-EXCLUSION-001 settings routes', () => {
    test('requires authentication', async () => {
        const res = await request(app()).get('/api/telephony/numbers/agent-exclusions');
        expect(res.status).toBe(401);
        expect(mockDbQuery).not.toHaveBeenCalled();
    });

    test('requires tenant.telephony.manage', async () => {
        mockResolveAuthzContext.mockResolvedValue(authz([]));
        const res = await authed('get', '/api/telephony/numbers/agent-exclusions');
        expect(res.status).toBe(403);
        expect(mockDbQuery).not.toHaveBeenCalled();
    });

    test('GET returns manual + blacklist, both scoped to companyFilter (ignores req.companyId)', async () => {
        mockDbQuery
            .mockResolvedValueOnce({ rows: [{ id: '1', phone_e164: '+16175550119', created_at: 't' }] })  // agent list
            .mockResolvedValueOnce({ rows: [{ id: '9', phone_e164: '+18575550142', created_at: 't' }] }); // blacklist list
        const res = await authed('get', '/api/telephony/numbers/agent-exclusions');
        expect(res.status).toBe(200);
        expect(res.body.manual).toHaveLength(1);
        expect(res.body.from_blacklist).toHaveLength(1);
        const tables = mockDbQuery.mock.calls.map(c => c[0]);
        expect(tables.some(s => /telephony_agent_excluded_numbers/.test(s))).toBe(true);
        expect(tables.some(s => /telephony_blacklist_numbers/.test(s))).toBe(true);
        for (const [, params] of mockDbQuery.mock.calls) {
            expect(params).toEqual([COMPANY_A]);
            expect(params).not.toContain(POISONED_COMPANY);
        }
    });

    test('rejects an incomplete phone before querying', async () => {
        const res = await authed('post', '/api/telephony/numbers/agent-exclusions').send({ phone_number: '617-555-01' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_PHONE_NUMBER');
        expect(mockDbQuery).not.toHaveBeenCalled();
    });

    test('normalizes and inserts with companyFilter + crm_users actor id', async () => {
        mockDbQuery.mockResolvedValue({ rows: [{ id: '8', phone_e164: '+16175550119', created_at: 't' }] });
        const res = await authed('post', '/api/telephony/numbers/agent-exclusions').send({ phone_number: '(617) 555-0119' });
        expect(res.status).toBe(201);
        expect(res.body.number.phone_e164).toBe('+16175550119');
        const [sql, params] = mockDbQuery.mock.calls[0];
        expect(sql).toMatch(/INSERT INTO telephony_agent_excluded_numbers/);
        expect(params).toEqual([COMPANY_A, '+16175550119', ACTOR_ID]);
        expect(params).not.toContain(POISONED_COMPANY);
    });

    test('duplicate returns a stable 409', async () => {
        const dup = new Error('duplicate'); dup.code = '23505';
        mockDbQuery.mockRejectedValue(dup);
        const res = await authed('post', '/api/telephony/numbers/agent-exclusions').send({ phone_number: '+1 617 555 0119' });
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ ok: false, code: 'PHONE_ALREADY_EXCLUDED' });
    });

    test('foreign-company delete is filtered to 404', async () => {
        mockDbQuery.mockResolvedValue({ rows: [] });
        const res = await authed('delete', '/api/telephony/numbers/agent-exclusions/44');
        expect(res.status).toBe(404);
        const [sql, params] = mockDbQuery.mock.calls[0];
        expect(sql).toMatch(/WHERE id = \$1 AND company_id = \$2/);
        expect(params).toEqual(['44', COMPANY_A]);
        expect(params).not.toContain(POISONED_COMPANY);
    });
});

describe('AGENT-EXCLUSION-001 agent gate lookup (union with blacklist)', () => {
    test('isExcludedForAgent unions agent list AND blacklist, scoped to the supplied company', async () => {
        mockDbQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] });
        await expect(svc.isExcludedForAgent(COMPANY_B, '(857) 555-0142')).resolves.toBe(true);
        const [sql, params] = mockDbQuery.mock.calls[0];
        expect(sql).toMatch(/telephony_agent_excluded_numbers/);
        expect(sql).toMatch(/telephony_blacklist_numbers/);
        expect(sql).toMatch(/UNION/);
        expect(params).toEqual([COMPANY_B, '+18575550142']);
    });

    test('no match → false', async () => {
        mockDbQuery.mockResolvedValue({ rows: [] });
        await expect(svc.isExcludedForAgent(COMPANY_A, '6175550119')).resolves.toBe(false);
    });

    test('unparseable number never touches the db', async () => {
        await expect(svc.isExcludedForAgent(COMPANY_A, '+44 20 7946 0958')).resolves.toBe(false);
        expect(mockDbQuery).not.toHaveBeenCalled();
    });

    test('uses the injected query fn (call-flow runtime path)', async () => {
        const injected = jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });
        await expect(svc.isExcludedForAgent(COMPANY_A, '6175550119', injected)).resolves.toBe(true);
        expect(injected).toHaveBeenCalledTimes(1);
        expect(mockDbQuery).not.toHaveBeenCalled();
    });
});
