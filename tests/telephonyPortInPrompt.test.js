'use strict';

/**
 * TELEPHONY-WIZARD-UX-001 T6.1 — shared port-in prompt dismissal flag.
 * Route SQL runs against an isolated PostgreSQL schema; telephony state and
 * external collaborators are mocked so the suite stays focused on auth,
 * tenant isolation, and companies.settings JSONB behavior.
 */

const crypto = require('crypto');
const { Pool } = require('pg');

const ORIGINAL_ENV = {
    DATABASE_URL: process.env.DATABASE_URL,
    PGOPTIONS: process.env.PGOPTIONS,
    FEATURE_AUTH_ENABLED: process.env.FEATURE_AUTH_ENABLED,
    KEYCLOAK_REALM_URL: process.env.KEYCLOAK_REALM_URL,
};

process.env.FEATURE_AUTH_ENABLED = 'true';
process.env.KEYCLOAK_REALM_URL = 'http://localhost:8080/realms/crm-prod';

const mockGetTelephonyState = jest.fn();

jest.mock('../backend/src/services/telephonyTenantService', () => ({
    getTelephonyState: mockGetTelephonyState,
}));
jest.mock('../backend/src/services/territoryGeoService', () => ({
    geocodeZip: jest.fn(),
}));
jest.mock('../backend/src/services/a2pService', () => ({}));
jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../backend/src/services/userService', () => ({
    findOrCreateUser: jest.fn(),
}));
jest.mock('../backend/src/services/authorizationService', () => ({
    buildDevAuthzContext: jest.fn(() => ({
        scope: 'tenant', company: null, membership: null, permissions: [],
    })),
    resolveAuthzContext: jest.fn(),
}));
jest.mock('jwks-rsa', () => jest.fn().mockReturnValue({ getSigningKey: jest.fn() }));

const express = require('express');
const request = require('supertest');

const BASE_PATH = '/api/telephony/numbers';
const SCHEMA = `wiz_port_prompt_${process.pid}_${Date.now()}`.toLowerCase();

let adminPool;
let db;
let router;
let authenticate;
let requireCompanyAccess;
let requirePermission;
let dbReady = false;
let setupError = null;
const companyIds = [];

function restoreEnv(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

async function createTestSchema() {
    await adminPool.query(`CREATE SCHEMA ${SCHEMA}`);
    await adminPool.query(`
        CREATE TABLE ${SCHEMA}.companies (
            id UUID PRIMARY KEY,
            name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            settings JSONB
        )
    `);
}

async function seedCompany(settings = {}) {
    const id = crypto.randomUUID();
    companyIds.push(id);
    await db.query(
        `INSERT INTO companies (id, name, settings)
         VALUES ($1, $2, $3::jsonb)`,
        [id, `Prompt Test ${id.slice(0, 8)}`, settings === null ? null : JSON.stringify(settings)]
    );
    return id;
}

function appWith({ companyId, permissions = ['tenant.telephony.manage'], poisonedCompanyId } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = {
            sub: 'kc-user',
            email: 'admin@example.com',
            crmUser: { id: crypto.randomUUID() },
        };
        req.authz = {
            scope: 'tenant',
            platform_role: 'none',
            company: companyId ? {
                id: companyId,
                name: 'Scoped Company',
                status: 'active',
            } : null,
            membership: companyId ? { role_key: 'tenant_admin' } : null,
            permissions,
        };
        req.companyId = poisonedCompanyId;
        next();
    });
    app.use(BASE_PATH, requirePermission('tenant.telephony.manage'), requireCompanyAccess, router);
    return app;
}

function realAuthApp() {
    const app = express();
    app.use(express.json());
    app.use(
        BASE_PATH,
        authenticate,
        requirePermission('tenant.telephony.manage'),
        requireCompanyAccess,
        router
    );
    return app;
}

beforeAll(async () => {
    try {
        adminPool = new Pool({
            connectionString: ORIGINAL_ENV.DATABASE_URL || 'postgresql://localhost/twilio_calls',
            max: 1,
        });
        await adminPool.query('SELECT 1');
        await createTestSchema();

        process.env.PGOPTIONS = `-c search_path=${SCHEMA}`;
        db = require('../backend/src/db/connection');
        router = require('../backend/src/routes/telephonyNumbers');
        ({ authenticate, requireCompanyAccess } = require('../backend/src/middleware/keycloakAuth'));
        ({ requirePermission } = require('../backend/src/middleware/authorization'));
        dbReady = true;
    } catch (err) {
        setupError = err;
        console.warn('\n[telephonyPortInPrompt] SKIPPED-NEEDS-DB —', err.message, '\n');
    }
});

beforeEach(() => {
    jest.clearAllMocks();
    mockGetTelephonyState.mockResolvedValue({ connected: true, mode: 'tenant' });
});

afterEach(async () => {
    if (!dbReady || !companyIds.length) return;
    const ids = companyIds.splice(0);
    await db.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [ids]);
});

afterAll(async () => {
    if (db?.pool) {
        try { await db.pool.end(); } catch (_) { /* ignore */ }
    }
    if (adminPool) {
        try { await adminPool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); } catch (_) { /* ignore */ }
        try { await adminPool.end(); } catch (_) { /* ignore */ }
    }
    restoreEnv('DATABASE_URL', ORIGINAL_ENV.DATABASE_URL);
    restoreEnv('PGOPTIONS', ORIGINAL_ENV.PGOPTIONS);
    restoreEnv('FEATURE_AUTH_ENABLED', ORIGINAL_ENV.FEATURE_AUTH_ENABLED);
    restoreEnv('KEYCLOAK_REALM_URL', ORIGINAL_ENV.KEYCLOAK_REALM_URL);
});

function needDb() {
    if (dbReady) return true;
    console.warn('SKIPPED-NEEDS-DB:', setupError?.message || 'database unavailable');
    return false;
}

describe('port-in prompt auth', () => {
    test('401: dismiss rejects requests without a bearer token', async () => {
        if (!needDb()) return;
        const res = await request(realAuthApp()).post(`${BASE_PATH}/port-in-prompt/dismiss`);
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('AUTH_REQUIRED');
    });

    test('403: dismiss requires tenant.telephony.manage', async () => {
        if (!needDb()) return;
        const companyId = await seedCompany({});
        const res = await request(appWith({ companyId, permissions: [] }))
            .post(`${BASE_PATH}/port-in-prompt/dismiss`);

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ACCESS_DENIED');
        const stored = await db.query('SELECT settings FROM companies WHERE id = $1', [companyId]);
        expect(stored.rows[0].settings).toEqual({});
    });
});

describe('port-in prompt state', () => {
    test('GET /status changes from null to dismissed and dismiss is tenant-isolated', async () => {
        if (!needDb()) return;
        const companyA = await seedCompany({});
        const companyB = await seedCompany({ onboarding_checklist: { completed_at: 'keep-b' } });
        const appA = appWith({ companyId: companyA, poisonedCompanyId: companyB });

        const before = await request(appA).get(`${BASE_PATH}/status?company_id=${companyB}`);
        expect(before.status).toBe(200);
        expect(before.body).toEqual({
            ok: true,
            state: { connected: true, mode: 'tenant' },
            port_in_prompt: null,
        });
        expect(mockGetTelephonyState).toHaveBeenLastCalledWith(companyA);

        const dismissed = await request(appA)
            .post(`${BASE_PATH}/port-in-prompt/dismiss?company_id=${companyB}`)
            .send({ company_id: companyB });
        expect(dismissed.status).toBe(200);
        expect(dismissed.body).toEqual({ ok: true, port_in_prompt: 'dismissed' });

        const afterA = await request(appA).get(`${BASE_PATH}/status`);
        const afterB = await request(appWith({
            companyId: companyB,
            poisonedCompanyId: companyA,
        })).get(`${BASE_PATH}/status`);
        expect(afterA.body.port_in_prompt).toBe('dismissed');
        expect(afterB.body.port_in_prompt).toBeNull();

        const stored = await db.query(
            'SELECT id, settings FROM companies WHERE id = ANY($1::uuid[]) ORDER BY id',
            [[companyA, companyB]]
        );
        const byId = Object.fromEntries(stored.rows.map(row => [row.id, row.settings]));
        expect(byId[companyA]).toEqual({ port_in_prompt: 'dismissed' });
        expect(byId[companyB]).toEqual({ onboarding_checklist: { completed_at: 'keep-b' } });
    });

    test('double dismiss is idempotent and preserves sibling settings keys', async () => {
        if (!needDb()) return;
        const companyId = await seedCompany({
            onboarding_checklist: { completed_at: '2026-07-13T12:00:00.000Z' },
            future_key: { enabled: true },
        });
        const app = appWith({ companyId });

        const first = await request(app).post(`${BASE_PATH}/port-in-prompt/dismiss`);
        const second = await request(app).post(`${BASE_PATH}/port-in-prompt/dismiss`);

        expect(first.body).toEqual({ ok: true, port_in_prompt: 'dismissed' });
        expect(second.body).toEqual(first.body);
        const stored = await db.query('SELECT settings FROM companies WHERE id = $1', [companyId]);
        expect(stored.rows[0].settings).toEqual({
            onboarding_checklist: { completed_at: '2026-07-13T12:00:00.000Z' },
            future_key: { enabled: true },
            port_in_prompt: 'dismissed',
        });
    });

    test('NULL settings is materialized by COALESCE', async () => {
        if (!needDb()) return;
        const companyId = await seedCompany(null);
        const app = appWith({ companyId });

        const before = await request(app).get(`${BASE_PATH}/status`);
        const dismissed = await request(app).post(`${BASE_PATH}/port-in-prompt/dismiss`);
        const after = await request(app).get(`${BASE_PATH}/status`);

        expect(before.body.port_in_prompt).toBeNull();
        expect(dismissed.body).toEqual({ ok: true, port_in_prompt: 'dismissed' });
        expect(after.body.port_in_prompt).toBe('dismissed');
        const stored = await db.query('SELECT settings FROM companies WHERE id = $1', [companyId]);
        expect(stored.rows[0].settings).toEqual({ port_in_prompt: 'dismissed' });
    });
});
