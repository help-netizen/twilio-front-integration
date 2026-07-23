'use strict';

/**
 * ONBOARD-LOOP-FIX — real-component auth regression harness.
 *
 * Keycloak signature verification and the user upsert boundary are mocked; the
 * authorization resolver, membership/role queries, 2FA gate, auth router, and
 * PostgreSQL rows are real.
 */

const { randomUUID } = require('crypto');

const ORIGINAL_ENV = {
    FEATURE_AUTH_ENABLED: process.env.FEATURE_AUTH_ENABLED,
    FEATURE_SMS_2FA: process.env.FEATURE_SMS_2FA,
    KEYCLOAK_REALM_URL: process.env.KEYCLOAK_REALM_URL,
};

process.env.FEATURE_AUTH_ENABLED = 'true';
process.env.FEATURE_SMS_2FA = 'true';
process.env.KEYCLOAK_REALM_URL = 'https://auth.albusto.test/realms/crm-prod';

let mockCrmUser;
let mockClaims;

jest.mock('jsonwebtoken', () => ({
    verify: jest.fn((_token, _getKey, _options, callback) => callback(null, mockClaims)),
}));
jest.mock('jwks-rsa', () => jest.fn(() => ({ getSigningKey: jest.fn() })));
jest.mock('../backend/src/services/userService', () => ({
    findOrCreateUser: jest.fn(async () => mockCrmUser),
}));
jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn(async () => {}),
}));

const express = require('express');
const request = require('supertest');
const db = require('../backend/src/db/connection');
const membershipQueries = require('../backend/src/db/membershipQueries');
const authorizationService = require('../backend/src/services/authorizationService');
const otpService = require('../backend/src/services/otpService');
const { authenticate, requireCompanyAccess } = require('../backend/src/middleware/keycloakAuth');
const authRouter = require('../backend/src/routes/auth');

jest.setTimeout(30000);

function buildApp() {
    const app = express();
    app.use('/api/auth', authenticate, authRouter);
    app.get('/api/company-probe', authenticate, requireCompanyAccess, (req, res) => {
        res.json({ ok: true, company_id: req.companyFilter.company_id });
    });
    return app;
}

async function withTransaction(work) {
    const client = await db.pool.connect();
    const originalQuery = db.query;
    try {
        await client.query('BEGIN');
        db.query = (text, params) => client.query(text, params);
        return await work(client);
    } finally {
        db.query = originalQuery;
        try {
            await client.query('ROLLBACK');
        } finally {
            client.release();
        }
    }
}

beforeAll(async () => {
    await db.query('SELECT 1 FROM companies, crm_users, company_memberships, trusted_devices LIMIT 1');
});

beforeEach(() => {
    mockCrmUser = null;
    mockClaims = {
        sub: 'onboard-loop-user',
        email: 'onboard-loop@example.test',
        realm_access: { roles: ['company_admin'] },
    };
});

afterAll(async () => {
    for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    await db.pool.end();
});

describe('ONBOARD-LOOP-FIX Root A — platform-only super admin', () => {
    test('SAB-A-RESOLVER: resolveAuthzContext returns platform scope with null company without querying membership', async () => {
        const membershipSpy = jest.spyOn(membershipQueries, 'getActiveMembership');
        try {
            const context = await authorizationService.resolveAuthzContext({
                id: randomUUID(),
                email: 'admin@albusto.test',
                platform_role: 'super_admin',
            });

            expect(context.scope).toBe('platform');
            expect(context.platform_role).toBe('super_admin');
            expect(context.company).toBeNull();
            expect(context.membership).toBeNull();
            expect(membershipSpy).not.toHaveBeenCalled();
        } finally {
            membershipSpy.mockRestore();
        }
    });

    test('SAB-A-ME: GET /api/auth/me returns 200 rather than redirecting or dereferencing null company', async () => {
        mockCrmUser = {
            id: randomUUID(),
            keycloak_sub: 'super-admin-sub',
            email: 'admin@albusto.test',
            full_name: 'Platform Admin',
            platform_role: 'super_admin',
        };
        mockClaims = {
            sub: mockCrmUser.keycloak_sub,
            email: mockCrmUser.email,
            name: mockCrmUser.full_name,
            realm_access: { roles: ['super_admin'] },
        };

        const response = await request(buildApp())
            .get('/api/auth/me')
            .set('Authorization', 'Bearer super-admin-token');

        expect(response.status).toBe(200);
        expect(response.headers.location).toBeUndefined();
        expect(response.body).toEqual(expect.objectContaining({
            ok: true,
            user: expect.objectContaining({ platform_role: 'super_admin' }),
            company: null,
            membership: null,
        }));
    });
});

describe('ONBOARD-LOOP-FIX Root B — verified phone on an untrusted device', () => {
    test('SAB-B-MEMBERSHIP + SAB-B-EXEMPT + SAB-B-GATE: auth/me returns the active company while a non-exempt route requires phone verification', async () => {
        await withTransaction(async client => {
            const companyId = randomUUID();
            const userId = randomUUID();
            const keycloakSub = `onboard-loop-${randomUUID()}`;
            const slug = `onboard-loop-${randomUUID()}`;

            await client.query(
                `INSERT INTO companies (id, name, slug, status)
                 VALUES ($1, 'Onboard Loop Repair', $2, 'active')`,
                [companyId, slug]
            );
            await client.query(
                `INSERT INTO crm_users
                    (id, keycloak_sub, email, full_name, role, status, platform_role,
                     phone_e164, phone_verified_at)
                 VALUES
                    ($1, $2, $3, 'Onboard Loop Owner', 'company_admin', 'active', 'none',
                     '+12015550199', now())
                 RETURNING *`,
                [userId, keycloakSub, `${keycloakSub}@example.test`]
            );
            await client.query(
                `INSERT INTO company_memberships
                    (user_id, company_id, role, role_key, status, is_primary)
                 VALUES ($1, $2, 'company_admin', 'tenant_admin', 'active', true)`,
                [userId, companyId]
            );

            const userResult = await client.query('SELECT * FROM crm_users WHERE id = $1', [userId]);
            mockCrmUser = userResult.rows[0];
            mockClaims = {
                sub: keycloakSub,
                email: mockCrmUser.email,
                name: mockCrmUser.full_name,
                realm_access: { roles: ['company_admin'] },
            };

            const deviceResult = await client.query(
                'SELECT id FROM trusted_devices WHERE user_id = $1',
                [userId]
            );
            expect(deviceResult.rows).toHaveLength(0);

            const trustedSpy = jest.spyOn(otpService, 'isDeviceTrusted');
            try {
                const meResponse = await request(buildApp())
                    .get('/api/auth/me')
                    .set('Authorization', 'Bearer tenant-admin-token');

                expect(meResponse.status).toBe(200);
                expect(meResponse.body).toEqual(expect.objectContaining({
                    ok: true,
                    user: expect.objectContaining({ platform_role: 'none' }),
                    company: expect.objectContaining({
                        id: companyId,
                        name: 'Onboard Loop Repair',
                        status: 'active',
                    }),
                    membership: expect.objectContaining({
                        role_key: 'tenant_admin',
                        status: 'active',
                    }),
                }));
                expect(trustedSpy).not.toHaveBeenCalled();

                const protectedResponse = await request(buildApp())
                    .get('/api/company-probe')
                    .set('Authorization', 'Bearer tenant-admin-token');

                expect(protectedResponse.status).toBe(401);
                expect(protectedResponse.body).toEqual(expect.objectContaining({
                    code: 'PHONE_VERIFICATION_REQUIRED',
                }));
                expect(trustedSpy).toHaveBeenCalledTimes(1);
                expect(trustedSpy).toHaveBeenCalledWith(userId, null);
            } finally {
                trustedSpy.mockRestore();
            }
        });
    });
});
