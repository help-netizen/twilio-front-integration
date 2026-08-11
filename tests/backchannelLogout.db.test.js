'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const ISSUER = 'https://auth.albusto.test/realms/crm-prod';
const CLIENT_ID = 'crm-web';
const KNOWN_KID = 'backchannel-honest-rs256';
const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

const ORIGINAL_ENV = {
    FEATURE_AUTH_ENABLED: process.env.FEATURE_AUTH_ENABLED,
    FEATURE_SMS_2FA: process.env.FEATURE_SMS_2FA,
    KEYCLOAK_REALM_URL: process.env.KEYCLOAK_REALM_URL,
    AUTH_BACKCHANNEL_REVOCATION_TTL_SECONDS: process.env.AUTH_BACKCHANNEL_REVOCATION_TTL_SECONDS,
    AUTH_BACKCHANNEL_MAX_TOKEN_AGE_SECONDS: process.env.AUTH_BACKCHANNEL_MAX_TOKEN_AGE_SECONDS,
    AUTH_BACKCHANNEL_CLOCK_SKEW_SECONDS: process.env.AUTH_BACKCHANNEL_CLOCK_SKEW_SECONDS,
};

process.env.FEATURE_AUTH_ENABLED = 'true';
process.env.FEATURE_SMS_2FA = 'false';
process.env.KEYCLOAK_REALM_URL = ISSUER;
process.env.AUTH_BACKCHANNEL_REVOCATION_TTL_SECONDS = '360';
process.env.AUTH_BACKCHANNEL_MAX_TOKEN_AGE_SECONDS = '120';
process.env.AUTH_BACKCHANNEL_CLOCK_SKEW_SECONDS = '60';

let mockPublicKeyPem;
const mockGetSigningKey = jest.fn((kid, callback) => {
    if (kid !== KNOWN_KID) return callback(new Error('Unknown signing key'));
    return callback(null, { getPublicKey: () => mockPublicKeyPem });
});

// Only the JWKS transport is mocked. jsonwebtoken.verify, RS256 signature
// verification, and every claim check exercise production code.
jest.mock('jwks-rsa', () => jest.fn(() => ({
    getSigningKey: mockGetSigningKey,
})));

jest.mock('../backend/src/services/userService', () => ({
    findOrCreateUser: jest.fn(async ({ sub, email, name }) => ({
        id: 'crm-user-backchannel-test',
        keycloak_sub: sub,
        email,
        full_name: name,
        company_id: 'company-backchannel-test',
    })),
}));

jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn(async () => undefined),
}));

jest.mock('../backend/src/services/authorizationService', () => ({
    buildDevAuthzContext: jest.fn(),
    resolveAuthzContext: jest.fn(async () => ({
        scope: 'tenant',
        platform_role: 'none',
        company: { id: 'company-backchannel-test' },
        membership: { role_key: 'tenant_admin' },
        permissions: [],
        scopes: {},
    })),
}));

const db = require('../backend/src/db/connection');
const userService = require('../backend/src/services/userService');
const authorizationService = require('../backend/src/services/authorizationService');
const backchannelLogoutRouter = require('../backend/src/routes/backchannelLogout');
const authRouter = require('../backend/src/routes/auth');
const { authenticate } = require('../backend/src/middleware/keycloakAuth');

jest.setTimeout(30000);

let privateKey;
let foreignPrivateKey;

function nowSeconds() {
    return Math.floor(Date.now() / 1000);
}

function logoutClaims(overrides = {}) {
    const now = nowSeconds();
    return {
        iss: ISSUER,
        aud: CLIENT_ID,
        iat: now,
        exp: now + 300,
        jti: `logout-${crypto.randomUUID()}`,
        events: { [LOGOUT_EVENT]: {} },
        sid: 'session-a',
        sub: 'subject-a',
        ...overrides,
    };
}

function signLogout(overrides = {}, options = {}) {
    const payload = logoutClaims(overrides);
    for (const [name, value] of Object.entries(payload)) {
        if (value === undefined) delete payload[name];
    }

    return jwt.sign(payload, options.key || privateKey, {
        algorithm: options.algorithm || 'RS256',
        keyid: options.kid || KNOWN_KID,
        header: { typ: options.typ || 'logout+jwt' },
        noTimestamp: options.noTimestamp || false,
    });
}

function signAccess(overrides = {}) {
    const now = nowSeconds();
    return jwt.sign({
        iss: ISSUER,
        aud: CLIENT_ID,
        sub: 'subject-a',
        sid: 'session-a',
        iat: now,
        exp: now + 300,
        email: 'backchannel@example.test',
        name: 'Backchannel Test',
        realm_access: { roles: ['company_admin'] },
        ...overrides,
    }, privateKey, {
        algorithm: 'RS256',
        keyid: KNOWN_KID,
    });
}

function buildApp() {
    const app = express();
    // Production ordering: the signed callback is bare and precedes the broader
    // authenticated /api/auth mount.
    app.use('/api/auth/backchannel-logout', backchannelLogoutRouter);
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use('/api/auth', authenticate, authRouter);
    app.get('/api/probe', authenticate, (req, res) => res.json({ ok: true }));
    return app;
}

async function postLogout(token) {
    const call = request(buildApp())
        .post('/api/auth/backchannel-logout')
        .type('form');
    return token === undefined ? call.send({}) : call.send({ logout_token: token });
}

async function probe(accessToken) {
    return request(buildApp())
        .get('/api/probe')
        .set('Authorization', `Bearer ${accessToken}`);
}

beforeAll(async () => {
    const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = keyPair.privateKey;
    mockPublicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' });
    ({ privateKey: foreignPrivateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }));

    const migration = fs.readFileSync(
        path.join(__dirname, '../backend/db/migrations/246_revoked_sessions.sql'),
        'utf8'
    );
    await db.query(migration);
    await db.query('DELETE FROM revoked_sessions WHERE issuer = $1', [ISSUER]);
});

beforeEach(() => {
    jest.clearAllMocks();
});

afterEach(async () => {
    jest.restoreAllMocks();
    await db.query('DELETE FROM revoked_sessions WHERE issuer = $1', [ISSUER]);
});

afterAll(async () => {
    for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    try { await db.pool.end(); } catch (_) { /* already closed */ }
});

describe('OIDC backchannel logout endpoint with honest RS256 verification', () => {
    test('valid sid token returns 200 and stores only the session revocation', async () => {
        const issuedAt = nowSeconds();
        const response = await postLogout(signLogout({
            iat: issuedAt,
            sid: 'session-valid-sid',
            sub: 'subject-also-present',
            jti: 'jti-valid-sid',
        }));

        expect(response.status).toBe(200);
        const { rows } = await db.query(
            `SELECT key_type, key_value, logout_token_jti,
                    EXTRACT(EPOCH FROM revoked_at)::bigint AS revoked_epoch,
                    EXTRACT(EPOCH FROM (expires_at - received_at))::int AS ttl_seconds
               FROM revoked_sessions
              WHERE issuer = $1`,
            [ISSUER]
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            key_type: 'sid',
            key_value: 'session-valid-sid',
            logout_token_jti: 'jti-valid-sid',
            revoked_epoch: String(issuedAt),
            ttl_seconds: 360,
        });
    });

    test('valid sub-only token writes a subject-wide revocation', async () => {
        const response = await postLogout(signLogout({
            sid: undefined,
            sub: 'subject-only',
            jti: 'jti-sub-only',
        }));

        expect(response.status).toBe(200);
        const { rows } = await db.query(
            'SELECT key_type, key_value FROM revoked_sessions WHERE issuer = $1',
            [ISSUER]
        );
        expect(rows).toEqual([{ key_type: 'sub', key_value: 'subject-only' }]);
    });

    test('duplicate jti delivery is idempotent', async () => {
        const token = signLogout({ sid: 'session-replay', jti: 'jti-replay' });

        expect((await postLogout(token)).status).toBe(200);
        const first = await db.query(
            `SELECT received_at, expires_at
               FROM revoked_sessions
              WHERE issuer = $1 AND logout_token_jti = $2`,
            [ISSUER, 'jti-replay']
        );
        expect((await postLogout(token)).status).toBe(200);

        const { rows } = await db.query(
            `SELECT COUNT(*)::int AS count,
                    MIN(received_at) AS received_at,
                    MIN(expires_at) AS expires_at
               FROM revoked_sessions
              WHERE issuer = $1`,
            [ISSUER]
        );
        expect(rows[0].count).toBe(1);
        expect(rows[0].received_at).toEqual(first.rows[0].received_at);
        expect(rows[0].expires_at).toEqual(first.rows[0].expires_at);
    });

    test.each([
        ['missing token', undefined],
        ['malformed token', 'not-a-jwt'],
        ['JWE shape', 'one.two.three.four.five'],
    ])('rejects %s with a generic 400', async (_label, token) => {
        const response = await postLogout(token);
        expect(response.status).toBe(400);
        expect(response.body).toEqual({ error: 'invalid_request' });
    });

    test('rejects a wrong RS256 signature', async () => {
        expect((await postLogout(signLogout({}, { key: foreignPrivateKey }))).status).toBe(400);
    });

    test('rejects an unknown kid', async () => {
        expect((await postLogout(signLogout({}, { kid: 'unknown-kid' }))).status).toBe(400);
    });

    test.each([
        ['none', null],
        ['HS256', 'hmac-secret'],
    ])('rejects %s algorithm tokens', async (algorithm, key) => {
        const payload = logoutClaims();
        const token = jwt.sign(payload, key, {
            algorithm,
            keyid: KNOWN_KID,
            header: { typ: 'logout+jwt' },
        });
        expect((await postLogout(token)).status).toBe(400);
    });

    test.each([
        ['wrong issuer', { iss: 'https://foreign.test/realms/other' }],
        ['wrong audience', { aud: 'another-client' }],
        ['missing audience', { aud: undefined }],
        ['multi-audience with wrong azp', { aud: [CLIENT_ID, 'another-client'], azp: 'another-client' }],
        ['stale iat', { iat: nowSeconds() - 1000, exp: nowSeconds() + 300 }],
        ['future iat', { iat: nowSeconds() + 120, exp: nowSeconds() + 420 }],
        ['non-integer iat', { iat: nowSeconds() + 0.5 }],
        ['missing jti', { jti: undefined }],
        ['blank jti', { jti: '   ' }],
        ['missing events', { events: undefined }],
        ['wrong events', { events: { [LOGOUT_EVENT]: 'not-an-object' } }],
        ['missing sid and sub', { sid: undefined, sub: undefined }],
        ['blank sid and sub', { sid: '   ', sub: '' }],
        ['nonce present', { nonce: null }],
        ['expired exp', { iat: nowSeconds() - 100, exp: nowSeconds() - 90 }],
        ['future nbf', { nbf: nowSeconds() + 120 }],
    ])('rejects %s', async (_label, overrides) => {
        expect((await postLogout(signLogout(overrides))).status).toBe(400);
    });

    test('rejects a missing iat', async () => {
        expect((await postLogout(signLogout({ iat: undefined }, { noTimestamp: true }))).status).toBe(400);
    });

    test('rejects a present typ other than logout+jwt', async () => {
        expect((await postLogout(signLogout({}, { typ: 'JWT' }))).status).toBe(400);
    });

    test('accepts a valid multi-audience token only when azp identifies crm-web', async () => {
        const response = await postLogout(signLogout({
            aud: [CLIENT_ID, 'account'],
            azp: CLIENT_ID,
        }));
        expect(response.status).toBe(200);
    });
});

describe('access-token revocation enforcement and route ordering', () => {
    test('revoked sid returns 401 before user or authorization DB work', async () => {
        const issuedAt = nowSeconds();
        expect((await postLogout(signLogout({
            iat: issuedAt,
            sid: 'session-revoked',
            sub: 'subject-revoked',
        }))).status).toBe(200);
        jest.clearAllMocks();

        const response = await probe(signAccess({
            iat: issuedAt,
            sid: 'session-revoked',
            sub: 'subject-revoked',
        }));

        expect(response.status).toBe(401);
        expect(response.body.code).toBe('SESSION_REVOKED');
        expect(userService.findOrCreateUser).not.toHaveBeenCalled();
        expect(authorizationService.resolveAuthzContext).not.toHaveBeenCalled();
    });

    test('a new sid and newer iat for the same subject is allowed', async () => {
        const issuedAt = nowSeconds();
        await postLogout(signLogout({
            iat: issuedAt,
            sid: 'session-old',
            sub: 'subject-same',
        }));
        jest.clearAllMocks();

        const response = await probe(signAccess({
            iat: issuedAt + 1,
            sid: 'session-new',
            sub: 'subject-same',
        }));

        expect(response.status).toBe(200);
        expect(userService.findOrCreateUser).toHaveBeenCalledTimes(1);
    });

    test('a sub-only revocation rejects an older access token even when it has a sid', async () => {
        const issuedAt = nowSeconds();
        await postLogout(signLogout({
            iat: issuedAt,
            sid: undefined,
            sub: 'subject-wide',
        }));

        const response = await probe(signAccess({
            iat: issuedAt,
            sid: 'any-session',
            sub: 'subject-wide',
        }));

        expect(response.status).toBe(401);
        expect(response.body.code).toBe('SESSION_REVOKED');
    });

    test('an expired revocation row is ignored', async () => {
        const issuedAt = nowSeconds();
        await postLogout(signLogout({ iat: issuedAt, sid: 'session-expired-row' }));
        await db.query(
            `UPDATE revoked_sessions
                SET expires_at = NOW() - INTERVAL '1 second'
              WHERE issuer = $1 AND key_type = 'sid' AND key_value = $2`,
            [ISSUER, 'session-expired-row']
        );

        const response = await probe(signAccess({
            iat: issuedAt,
            sid: 'session-expired-row',
        }));

        expect(response.status).toBe(200);
    });

    test('revocation-store lookup failure fails closed with 503', async () => {
        const querySpy = jest.spyOn(db, 'query').mockRejectedValueOnce(new Error('store unavailable'));

        const response = await probe(signAccess());

        expect(response.status).toBe(503);
        expect(response.body.code).toBe('AUTH_REVOCATION_UNAVAILABLE');
        expect(userService.findOrCreateUser).not.toHaveBeenCalled();
        querySpy.mockRestore();
    });

    test('backchannel POST is public while /api/auth/me remains authenticated', async () => {
        const callbackResponse = await postLogout(undefined);
        const meResponse = await request(buildApp()).get('/api/auth/me');
        const serverSource = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
        const bareMount = serverSource.indexOf("app.use('/api/auth/backchannel-logout'");
        const globalFormParser = serverSource.indexOf('app.use(express.urlencoded');
        const authenticatedAuthMount = serverSource.indexOf("app.use('/api/auth', authenticate, authRouter)");

        expect(callbackResponse.status).toBe(400);
        expect(callbackResponse.body).toEqual({ error: 'invalid_request' });
        expect(meResponse.status).toBe(401);
        expect(meResponse.body.code).toBe('AUTH_REQUIRED');
        expect(bareMount).toBeGreaterThan(-1);
        expect(bareMount).toBeLessThan(globalFormParser);
        expect(bareMount).toBeLessThan(authenticatedAuthMount);
    });
});
