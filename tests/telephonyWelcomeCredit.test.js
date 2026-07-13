'use strict';

/**
 * TELEPHONY-WIZARD-UX-001 T1 — welcome credit, lazy connect, locale, and
 * Stripe checklist copy. The credit race cases use real PostgreSQL locking and
 * the production UNIQUE(company_id, ref) shape in an isolated temporary schema;
 * Twilio and auth collaborators are mocked.
 */

const crypto = require('crypto');
const { Pool } = require('pg');

const ORIGINAL_ENV = {
    DATABASE_URL: process.env.DATABASE_URL,
    PGOPTIONS: process.env.PGOPTIONS,
    FEATURE_AUTH_ENABLED: process.env.FEATURE_AUTH_ENABLED,
    KEYCLOAK_REALM_URL: process.env.KEYCLOAK_REALM_URL,
    TELEPHONY_TOKEN_KEY: process.env.TELEPHONY_TOKEN_KEY,
};

process.env.FEATURE_AUTH_ENABLED = 'true';
process.env.KEYCLOAK_REALM_URL = 'http://localhost:8080/realms/crm-prod';
process.env.TELEPHONY_TOKEN_KEY = 'test-telephony-welcome-credit-key';

const mockAccountsCreate = jest.fn();
const mockApplicationsCreate = jest.fn();
const mockNewKeysCreate = jest.fn();
const mockAvailableList = jest.fn();
const mockIncomingCreate = jest.fn();
const mockIncomingList = jest.fn();

const mockSubaccountClient = {
    applications: { create: mockApplicationsCreate },
    newKeys: { create: mockNewKeysCreate },
    availablePhoneNumbers: jest.fn(() => ({
        local: { list: mockAvailableList },
        tollFree: { list: mockAvailableList },
    })),
    incomingPhoneNumbers: {
        create: mockIncomingCreate,
        list: mockIncomingList,
    },
};

const mockMasterClient = {
    api: { v2010: { accounts: { create: mockAccountsCreate } } },
};

jest.mock('twilio', () => jest.fn(() => mockSubaccountClient));
jest.mock('../backend/src/services/twilioClient', () => ({
    getTwilioClient: jest.fn(() => mockMasterClient),
}));
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
const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const SCHEMA = `wiz_telephony_${process.pid}_${Date.now()}`.toLowerCase();

let adminPool;
let db;
let walletService;
let billingService;
let svc;
let router;
let territoryGeoService;
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
            slug TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL DEFAULT 'active',
            city TEXT,
            state TEXT,
            zip TEXT
        );
        CREATE TABLE ${SCHEMA}.company_telephony (
            company_id UUID PRIMARY KEY REFERENCES ${SCHEMA}.companies(id) ON DELETE CASCADE,
            provider TEXT NOT NULL DEFAULT 'twilio',
            twilio_subaccount_sid TEXT,
            twilio_auth_token_enc TEXT,
            status TEXT NOT NULL DEFAULT 'connected',
            connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            suspended_at TIMESTAMPTZ,
            connected_by UUID,
            autonomous_mode BOOLEAN NOT NULL DEFAULT false,
            twiml_app_sid TEXT,
            api_key_sid TEXT,
            api_key_secret_enc TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE ${SCHEMA}.billing_plans (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            monthly_base_usd NUMERIC(12,2) NOT NULL,
            included_seats INT NOT NULL DEFAULT 1,
            per_seat_usd NUMERIC(12,2) NOT NULL DEFAULT 0,
            metered JSONB NOT NULL DEFAULT '{}'::jsonb,
            max_phone_numbers INT,
            is_active BOOLEAN NOT NULL DEFAULT true
        );
        CREATE TABLE ${SCHEMA}.billing_subscriptions (
            company_id UUID PRIMARY KEY REFERENCES ${SCHEMA}.companies(id) ON DELETE CASCADE,
            plan_id TEXT REFERENCES ${SCHEMA}.billing_plans(id),
            status TEXT,
            provider_customer_id TEXT,
            trial_ends_at TIMESTAMPTZ,
            current_period_end TIMESTAMPTZ,
            seats INT NOT NULL DEFAULT 1,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE ${SCHEMA}.billing_wallets (
            company_id UUID PRIMARY KEY REFERENCES ${SCHEMA}.companies(id) ON DELETE CASCADE,
            balance_usd NUMERIC(12,2) NOT NULL DEFAULT 0,
            auto_recharge_enabled BOOLEAN NOT NULL DEFAULT true,
            auto_recharge_threshold_usd NUMERIC(10,2) NOT NULL DEFAULT 5,
            auto_recharge_amount_usd NUMERIC(10,2) NOT NULL DEFAULT 10,
            default_payment_method_id TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE ${SCHEMA}.billing_wallet_ledger (
            id BIGSERIAL PRIMARY KEY,
            company_id UUID NOT NULL REFERENCES ${SCHEMA}.companies(id) ON DELETE CASCADE,
            amount_usd NUMERIC(12,2) NOT NULL,
            type TEXT NOT NULL,
            description TEXT,
            balance_after NUMERIC(12,2) NOT NULL,
            ref TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE UNIQUE INDEX idx_wallet_ledger_ref
            ON ${SCHEMA}.billing_wallet_ledger (company_id, ref)
            WHERE ref IS NOT NULL;
        CREATE TABLE ${SCHEMA}.phone_number_settings (
            id BIGSERIAL PRIMARY KEY,
            phone_number TEXT NOT NULL UNIQUE,
            friendly_name TEXT,
            routing_mode TEXT,
            company_id UUID NOT NULL REFERENCES ${SCHEMA}.companies(id) ON DELETE CASCADE,
            twilio_number_sid TEXT,
            locality TEXT,
            capabilities JSONB,
            purchased_at TIMESTAMPTZ,
            group_id UUID,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE ${SCHEMA}.zip_geocache (
            zip TEXT PRIMARY KEY,
            lat NUMERIC(9,6),
            lon NUMERIC(9,6),
            city TEXT,
            state TEXT
        );
        CREATE TABLE ${SCHEMA}.territory_radii (
            id UUID PRIMARY KEY,
            company_id UUID NOT NULL REFERENCES ${SCHEMA}.companies(id) ON DELETE CASCADE,
            zip TEXT NOT NULL,
            lat NUMERIC(9,6) NOT NULL,
            lon NUMERIC(9,6) NOT NULL,
            radius_miles NUMERIC(5,1) NOT NULL,
            position INT NOT NULL DEFAULT 0
        );
    `);
    await adminPool.query(
        `INSERT INTO ${SCHEMA}.billing_plans
            (id, name, monthly_base_usd, max_phone_numbers)
         VALUES ('trial', 'Trial', 0, 1),
                ('payg', 'Pay as you go', 0, NULL),
                ('team', 'Team', 99, 10)`
    );
}

async function seedCompany({ planId = 'trial', city = null, state = null, zip = null } = {}) {
    const id = crypto.randomUUID();
    companyIds.push(id);
    await db.query(
        `INSERT INTO companies (id, name, slug, city, state, zip)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, `Test ${id.slice(0, 8)}`, `test-${id}`, city, state, zip]
    );
    if (planId) {
        await db.query(
            `INSERT INTO billing_subscriptions (company_id, plan_id, status)
             VALUES ($1, $2, $3)`,
            [id, planId, planId === 'trial' ? 'trialing' : 'active']
        );
    }
    return id;
}

function appWith({ companyId, permissions = ['tenant.telephony.manage'], poisonedCompanyId } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = {
            sub: 'kc-user', email: 'admin@example.com', crmUser: { id: crypto.randomUUID() },
        };
        req.authz = {
            scope: 'tenant',
            platform_role: 'none',
            company: companyId ? { id: companyId, name: 'Scoped Company', status: 'active' } : null,
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

async function flushDeferred() {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setTimeout(resolve, 50));
}

beforeAll(async () => {
    try {
        adminPool = new Pool({
            connectionString: ORIGINAL_ENV.DATABASE_URL || 'postgresql://localhost/twilio_calls',
            max: 2,
        });
        await adminPool.query('SELECT 1');
        await createTestSchema();

        process.env.PGOPTIONS = `-c search_path=${SCHEMA}`;
        db = require('../backend/src/db/connection');
        walletService = require('../backend/src/services/walletService');
        billingService = require('../backend/src/services/billingService');
        svc = require('../backend/src/services/telephonyTenantService');
        router = require('../backend/src/routes/telephonyNumbers');
        territoryGeoService = require('../backend/src/services/territoryGeoService');
        ({ authenticate, requireCompanyAccess } = require('../backend/src/middleware/keycloakAuth'));
        ({ requirePermission } = require('../backend/src/middleware/authorization'));

        dbReady = true;
    } catch (err) {
        setupError = err;
        console.warn('\n[telephonyWelcomeCredit] SKIPPED-NEEDS-DB —', err.message, '\n');
    }
});

beforeEach(() => {
    jest.clearAllMocks();
    mockAccountsCreate.mockImplementation(async () => ({
        sid: `ACsub${crypto.randomUUID().replace(/-/g, '')}`,
        authToken: 'sub-token',
    }));
    mockApplicationsCreate.mockResolvedValue({ sid: 'APsoftphone' });
    mockNewKeysCreate.mockResolvedValue({ sid: 'SKsoftphone', secret: 'key-secret' });
    mockAvailableList.mockResolvedValue([{
        phoneNumber: '+16175550123',
        friendlyName: '(617) 555-0123',
        locality: 'Boston',
        region: 'MA',
        capabilities: { voice: true, SMS: true },
    }]);
    mockIncomingCreate.mockResolvedValue({
        sid: 'PNpurchased',
        phoneNumber: '+16175550123',
        friendlyName: 'Main line',
    });
    mockIncomingList.mockResolvedValue([]);
});

afterEach(async () => {
    jest.restoreAllMocks();
    if (!dbReady) return;
    await flushDeferred();
    if (companyIds.length) {
        const ids = companyIds.splice(0);
        await db.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [ids]);
    }
    await db.query("UPDATE billing_plans SET max_phone_numbers = NULL WHERE id = 'payg'");
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
    restoreEnv('TELEPHONY_TOKEN_KEY', ORIGINAL_ENV.TELEPHONY_TOKEN_KEY);
});

function needDb() {
    if (dbReady) return true;
    console.warn('SKIPPED-NEEDS-DB:', setupError?.message || 'database unavailable');
    return false;
}

describe('welcome credit on first connect', () => {
    test('TC-WIZ-001: sequential double connect creates one $5 adjustment and activates payg', async () => {
        if (!needDb()) return;
        const companyId = await seedCompany();

        await svc.connectTelephony(companyId, { actorId: crypto.randomUUID(), companyName: 'Acme' });
        await svc.connectTelephony(companyId, { actorId: crypto.randomUUID(), companyName: 'Acme' });

        const ledger = await db.query(
            `SELECT amount_usd, type, description, ref, balance_after
             FROM billing_wallet_ledger
             WHERE company_id = $1 AND ref = 'welcome_credit:v1'`,
            [companyId]
        );
        const wallet = await db.query('SELECT balance_usd FROM billing_wallets WHERE company_id = $1', [companyId]);
        const subscription = await billingService.getSubscription(companyId);

        expect(ledger.rows).toEqual([expect.objectContaining({
            amount_usd: '5.00',
            type: 'adjustment',
            description: 'Welcome credit',
            ref: 'welcome_credit:v1',
            balance_after: '5.00',
        })]);
        expect(wallet.rows[0].balance_usd).toBe('5.00');
        expect(subscription).toMatchObject({ plan_id: 'payg', status: 'active' });
        expect(mockAccountsCreate).toHaveBeenCalledTimes(1);
    });

    test('TC-WIZ-002: parallel connect is serialized to one welcome ledger row', async () => {
        if (!needDb()) return;
        const companyId = await seedCompany();
        mockAccountsCreate.mockImplementation(async () => {
            await new Promise(resolve => setImmediate(resolve));
            return { sid: `ACsub${crypto.randomUUID().replace(/-/g, '')}`, authToken: 'sub-token' };
        });

        await Promise.all([
            svc.connectTelephony(companyId, { companyName: 'Parallel Acme' }),
            svc.connectTelephony(companyId, { companyName: 'Parallel Acme' }),
        ]);

        const ledger = await db.query(
            `SELECT count(*)::int AS count, min(amount_usd)::numeric AS amount
             FROM billing_wallet_ledger
             WHERE company_id = $1 AND ref = 'welcome_credit:v1'`,
            [companyId]
        );
        const wallet = await db.query('SELECT balance_usd FROM billing_wallets WHERE company_id = $1', [companyId]);
        expect(ledger.rows[0]).toMatchObject({ count: 1, amount: '5.00' });
        expect(wallet.rows[0].balance_usd).toBe('5.00');
    });

    test('TC-WIZ-003: default company returns master state without a bonus', async () => {
        if (!needDb()) return;
        const state = await svc.connectTelephony(DEFAULT_COMPANY_ID);
        const ledger = await db.query(
            `SELECT count(*)::int AS count
             FROM billing_wallet_ledger
             WHERE company_id = $1 AND ref = 'welcome_credit:v1'`,
            [DEFAULT_COMPANY_ID]
        );
        expect(state).toMatchObject({ connected: true, mode: 'master' });
        expect(ledger.rows[0].count).toBe(0);
        expect(mockAccountsCreate).not.toHaveBeenCalled();
    });

    test('TC-WIZ-004: an existing telephony tenant receives no retroactive bonus', async () => {
        if (!needDb()) return;
        const companyId = await seedCompany();
        await db.query(
            `INSERT INTO company_telephony
                (company_id, twilio_subaccount_sid, twilio_auth_token_enc, status)
             VALUES ($1, 'ACexisting', $2, 'connected')`,
            [companyId, svc._encryptToken('existing-token')]
        );

        const state = await svc.connectTelephony(companyId);
        const ledger = await db.query(
            `SELECT count(*)::int AS count
             FROM billing_wallet_ledger
             WHERE company_id = $1 AND ref = 'welcome_credit:v1'`,
            [companyId]
        );
        expect(state).toMatchObject({ connected: true, subaccount_sid: 'ACexisting' });
        expect(ledger.rows[0].count).toBe(0);
        expect(mockAccountsCreate).not.toHaveBeenCalled();
    });

    test('TC-WIZ-005: paid package receives the credit without being replaced by payg', async () => {
        if (!needDb()) return;
        const companyId = await seedCompany({ planId: 'team' });
        await svc.connectTelephony(companyId);

        const ledger = await db.query(
            `SELECT count(*)::int AS count
             FROM billing_wallet_ledger
             WHERE company_id = $1 AND ref = 'welcome_credit:v1'`,
            [companyId]
        );
        const subscription = await billingService.getSubscription(companyId);
        expect(ledger.rows[0].count).toBe(1);
        expect(subscription).toMatchObject({ plan_id: 'team', status: 'active' });
    });

    test('TC-WIZ-006: credit failure is logged but does not fail connect or payg activation', async () => {
        if (!needDb()) return;
        const companyId = await seedCompany();
        const creditError = new Error('ledger unavailable');
        jest.spyOn(walletService, 'credit').mockRejectedValueOnce(creditError);
        const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});

        await expect(svc.connectTelephony(companyId)).resolves.toMatchObject({ connected: true });
        const state = await svc.getTelephonyState(companyId);
        const subscription = await billingService.getSubscription(companyId);
        expect(state.connected).toBe(true);
        expect(subscription).toMatchObject({ plan_id: 'payg', status: 'active' });
        expect(errorLog).toHaveBeenCalledWith(
            expect.stringContaining('welcome credit failed'),
            'ledger unavailable'
        );
    });
});

describe('lazy connect routes', () => {
    test('TC-WIZ-007: search connects once, grants once, and then returns Twilio results', async () => {
        if (!needDb()) return;
        const companyId = await seedCompany();
        const app = appWith({ companyId });

        const first = await request(app).get(`${BASE_PATH}/search?area_code=617`);
        const second = await request(app).get(`${BASE_PATH}/search?area_code=617`);

        expect(first.status).toBe(200);
        expect(first.body.results).toHaveLength(1);
        expect(second.status).toBe(200);
        expect(mockAccountsCreate).toHaveBeenCalledTimes(1);
        expect(mockAvailableList).toHaveBeenCalledWith({ limit: 15, areaCode: '617' });
        const ledger = await db.query(
            `SELECT count(*)::int AS count
             FROM billing_wallet_ledger
             WHERE company_id = $1 AND ref = 'welcome_credit:v1'`,
            [companyId]
        );
        expect(ledger.rows[0].count).toBe(1);
    });

    test('TC-WIZ-008: buy connects before purchasing and preserves NUMBER_LIMIT', async () => {
        if (!needDb()) return;
        const companyId = await seedCompany();
        const app = appWith({ companyId });

        const bought = await request(app)
            .post(`${BASE_PATH}/buy`)
            .send({ phone_number: '+16175550123', friendly_name: 'Main line' });
        expect(bought.status).toBe(201);
        expect(mockAccountsCreate).toHaveBeenCalledTimes(1);
        expect(mockIncomingCreate).toHaveBeenCalledTimes(1);

        await db.query("UPDATE billing_plans SET max_phone_numbers = 1 WHERE id = 'payg'");
        const limited = await request(app)
            .post(`${BASE_PATH}/buy`)
            .send({ phone_number: '+16175550124' });
        expect(limited.status).toBe(422);
        expect(limited.body).toMatchObject({ ok: false, code: 'NUMBER_LIMIT' });
        expect(mockAccountsCreate).toHaveBeenCalledTimes(1);
        expect(mockIncomingCreate).toHaveBeenCalledTimes(1);
    });

    test('TC-WIZ-009: Twilio connect failure stops search without partial database state', async () => {
        if (!needDb()) return;
        const companyId = await seedCompany();
        mockAccountsCreate.mockRejectedValueOnce(new Error('Twilio unavailable'));
        const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});

        const res = await request(appWith({ companyId })).get(`${BASE_PATH}/search?area_code=617`);

        expect(res.status).toBe(500);
        expect(res.body).toEqual({
            ok: false,
            code: 'INTERNAL_ERROR',
            error: 'Number search failed',
        });
        expect(mockAvailableList).not.toHaveBeenCalled();
        const telephony = await db.query('SELECT count(*)::int AS count FROM company_telephony WHERE company_id = $1', [companyId]);
        const ledger = await db.query('SELECT count(*)::int AS count FROM billing_wallet_ledger WHERE company_id = $1', [companyId]);
        expect(telephony.rows[0].count).toBe(0);
        expect(ledger.rows[0].count).toBe(0);
        expect(errorLog).toHaveBeenCalled();
    });
});

describe('numbers locale auth and tenant isolation', () => {
    test('401: the real mount rejects requests without a bearer token', async () => {
        if (!needDb()) return;
        const res = await request(realAuthApp()).get(`${BASE_PATH}/locale`);
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('AUTH_REQUIRED');
    });

    test('403: tenant.telephony.manage is required before locale work', async () => {
        if (!needDb()) return;
        const companyId = await seedCompany({ city: 'Boston', state: 'MA', zip: '02108' });
        const res = await request(appWith({ companyId, permissions: [] })).get(`${BASE_PATH}/locale`);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ACCESS_DENIED');
    });

    test('TC-WIZ-013: locale uses only req.companyFilter company data', async () => {
        if (!needDb()) return;
        const companyA = await seedCompany({ city: 'Boston', state: 'MA', zip: '02108' });
        const companyB = await seedCompany({ city: 'Beverly Hills', state: 'CA', zip: '90210' });
        await db.query(
            `INSERT INTO zip_geocache (zip, lat, lon, city, state)
             VALUES ('02108', 42.3570, -71.0637, 'Boston', 'MA'),
                    ('90210', 34.0901, -118.4065, 'Beverly Hills', 'CA')`
        );

        const res = await request(appWith({
            companyId: companyA,
            poisonedCompanyId: companyB,
        })).get(`${BASE_PATH}/locale?company_id=${companyB}`);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            city: 'Boston', state: 'MA', zip: '02108', lat: 42.357, lon: -71.0637,
        });
    });

    test('locale falls back to the first tenant radius when the company has no ZIP', async () => {
        if (!needDb()) return;
        const companyId = await seedCompany({ planId: null });
        await db.query(
            `INSERT INTO zip_geocache (zip, lat, lon, city, state)
             VALUES ('02135', 42.3467, -71.1627, 'Brighton', 'MA')`
        );
        await db.query(
            `INSERT INTO territory_radii
                (id, company_id, zip, lat, lon, radius_miles, position)
             VALUES ($1, $2, '02135', 42.3467, -71.1627, 25, 0)`,
            [crypto.randomUUID(), companyId]
        );

        const res = await request(appWith({ companyId })).get(`${BASE_PATH}/locale`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            city: 'Brighton', state: 'MA', zip: '02135', lat: 42.3467, lon: -71.1627,
        });
    });

    test('locale geocoding failure is best-effort and returns nullable coordinates', async () => {
        if (!needDb()) return;
        const companyId = await seedCompany({ city: 'Boston', state: 'MA', zip: '02109' });
        jest.spyOn(territoryGeoService, 'geocodeZip').mockRejectedValueOnce(new Error('geocoder down'));
        const warnLog = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const res = await request(appWith({ companyId })).get(`${BASE_PATH}/locale`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ city: 'Boston', state: 'MA', zip: '02109', lat: null, lon: null });
        expect(warnLog).toHaveBeenCalled();
    });
});

describe('Stripe checklist labels', () => {
    test('uses the OB-7 keys, labels, order, and existing done/deferred logic', async () => {
        if (!needDb()) return;
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const stripeProvider = require('../backend/src/services/stripeConnectProvider');
        jest.spyOn(stripeProvider, 'isConfigured').mockReturnValue(false);
        const stripePaymentsService = require('../backend/src/services/stripePaymentsService');
        const status = await stripePaymentsService.getStatus(crypto.randomUUID());

        expect(status.checklist).toEqual([
            { key: 'connect', label: 'Link your Stripe account', done: false },
            { key: 'onboarding', label: 'Tell Stripe about your business', done: false },
            { key: 'payment_methods', label: 'Card payments switched on', done: false },
            { key: 'field_payments', label: 'Tap to Pay on your phone', done: false, deferred: true },
            { key: 'first_payment', label: 'Start getting paid — collect your first payment right from a job', done: false },
        ]);
    });
});
