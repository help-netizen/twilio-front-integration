'use strict';

/**
 * ONBTEL-001 Part B (ONBTEL-T11) — billingService.subscribe ≤$0 branch + POST /api/billing/checkout return_path.
 *
 * Covers TC-B-01…TC-B-14 (Docs/test-cases/ONBTEL-001.md §3):
 *   - payg with NO Stripe key → {activated:true} via a single UPDATE, the ≤0 branch runs
 *     BEFORE providerConfigured() — zero provider/wallet calls (E-B3);
 *   - paid plan with NO Stripe key → 422 PROVIDER_NOT_CONFIGURED, subscription untouched;
 *   - idempotent repeat subscribe (E-B2) + INSERT branch when no subscription row (E-B4);
 *   - paid card-on-file path regression (chargeOffSession → credit → UPDATE → billPlanFee, E-B7);
 *   - default checkout URLs when return_path is absent;
 *   - the FULL §2.4 return_path matrix (absent + 2 valid OK; every invalid → 422
 *     INVALID_RETURN_PATH with NO side effects — subscribe never called);
 *   - successUrl/cancelUrl passthrough ('https://app.albusto.com' + return_path, path-only);
 *   - 404 unknown/inactive plan; 422 plan_id required; trial-edge activates via ≤0 (E-B9);
 *   - mount auth matrix 401/403 (behavioral + structural — NOT covered by tests/billingUI.test.js,
 *     which fakes the mount middleware; extended here, not duplicated);
 *   - body company_id ignored (isolation §8); payg with Stripe configured AND card on file
 *     still takes the ≤0 branch (§2.4 п.2).
 *
 * Strategy (test-cases §3): precedent tests/billingUI.test.js — mock `db.query`; no-Stripe =
 * delete process.env.STRIPE_SECRET_KEY; paid paths mock billing/billingProvider + walletService;
 * routes exercised through mini-express + supertest.
 *
 * Run:
 *   npx jest --runTestsByPath tests/billingPaygSubscribe.test.js \
 *     --testPathIgnorePatterns "/node_modules/"
 */

// keycloakAuth reads FEATURE_AUTH_ENABLED at module load — set BEFORE any require
// (needed for the real-authenticate 401 mount test, TC-B-12а).
const ORIGINAL_ENV = {
    FEATURE_AUTH_ENABLED: process.env.FEATURE_AUTH_ENABLED,
    KEYCLOAK_REALM_URL: process.env.KEYCLOAK_REALM_URL,
};
process.env.FEATURE_AUTH_ENABLED = 'true';
process.env.KEYCLOAK_REALM_URL = 'http://localhost:8080/realms/crm-prod';

afterAll(() => {
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

const mockProvider = {
    chargeOffSession: jest.fn(),
    createTopupCheckout: jest.fn(),
    ensureCustomer: jest.fn(),
};

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/billing/billingProvider', () => ({
    getProvider: jest.fn(() => mockProvider),
}));
jest.mock('../backend/src/services/walletService', () => ({
    getWallet: jest.fn(),
    getLedger: jest.fn(),
    credit: jest.fn(),
    debit: jest.fn(),
    ensureBalance: jest.fn(),
    updateSettings: jest.fn(),
    setDefaultPaymentMethod: jest.fn(),
    GRACE_FLOOR_USD: -5,
    MIN_TOPUP_USD: 10,
}));

// keycloakAuth/authorization deps for the real mount-middleware tests (TC-B-12).
jest.mock('../backend/src/services/userService', () => ({ findOrCreateUser: jest.fn() }));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../backend/src/services/authorizationService', () => ({
    buildDevAuthzContext: jest.fn(() => ({ scope: 'tenant', company: null, membership: null, permissions: [] })),
    resolveAuthzContext: jest.fn(),
}));
jest.mock('jwks-rsa', () => jest.fn().mockReturnValue({ getSigningKey: jest.fn() }));

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const db = require('../backend/src/db/connection');
const { getProvider } = require('../backend/src/services/billing/billingProvider');
const walletService = require('../backend/src/services/walletService');
const billingService = require('../backend/src/services/billingService');
const billingRouter = require('../backend/src/routes/billing');
const { authenticate } = require('../backend/src/middleware/keycloakAuth');
const { requirePermission } = require('../backend/src/middleware/authorization');
const { requireCompanyAccess } = require('../backend/src/middleware/keycloakAuth');

const COMPANY_A = '11111111-1111-1111-1111-111111111111';
const COMPANY_B = '22222222-2222-2222-2222-222222222222';

// Plans mirror the seeds: payg (mig 146, $0), trial ($0), starter ($49).
const PAYG_PLAN = {
    id: 'payg', name: 'Pay as you go', monthly_base_usd: '0.00',
    included_seats: 3, per_seat_usd: '0.00',
    metered: { sms: 0.03, call_minutes: 0.04, agent_runs: 0 },
    included_units: { sms: 0, call_minutes: 0, agent_runs: 0 },
    max_phone_numbers: 1, provider_price_id: null, is_active: true,
};
const TRIAL_PLAN = { id: 'trial', name: 'Trial', monthly_base_usd: '0.00', is_active: true, provider_price_id: null };
const STARTER_PLAN = { id: 'starter', name: 'Starter', monthly_base_usd: '49.00', is_active: true, provider_price_id: 'price_starter' };

const ORIGINAL_STRIPE_KEY = process.env.STRIPE_SECRET_KEY;

beforeEach(() => {
    db.query.mockReset();
    walletService.getWallet.mockReset();
    walletService.credit.mockReset();
    walletService.debit.mockReset().mockResolvedValue({ applied: true });
    walletService.ensureBalance.mockReset().mockResolvedValue(undefined);
    mockProvider.chargeOffSession.mockReset();
    mockProvider.createTopupCheckout.mockReset();
    getProvider.mockClear();
    delete process.env.STRIPE_SECRET_KEY; // no-Stripe is the default; tests opt in
});

afterAll(() => {
    if (ORIGINAL_STRIPE_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = ORIGINAL_STRIPE_KEY;
});

// Authorized app: the mount middleware chain is faked (like tests/billingUI.test.js);
// TC-B-12 exercises the REAL chain separately.
function appWith({ company = COMPANY_A } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'kc-1', email: 'admin@a.com', crmUser: { id: 'u1' } };
        req.authz = { permissions: ['tenant.company.manage'], company: { id: company }, scope: 'tenant' };
        req.companyFilter = { company_id: company };
        next();
    });
    app.use('/api/billing', billingRouter);
    return app;
}

// ─── subscribe — the ≤ $0 activation branch (TC-B-01…04, 09, 14) ─────────────

describe('billingService.subscribe — payg/≤$0 branch', () => {
    test('TC-B-01 (E-B3): payg with NO Stripe key → {activated:true} via one UPDATE, zero provider/wallet calls', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [PAYG_PLAN] })       // SELECT plan WHERE id=$1 AND is_active
            .mockResolvedValueOnce({ rowCount: 1, rows: [] });  // UPDATE billing_subscriptions

        const out = await billingService.subscribe(COMPANY_A, 'payg');

        expect(out).toEqual({ activated: true });
        expect(db.query).toHaveBeenCalledTimes(2);
        const [planSql, planParams] = db.query.mock.calls[0];
        expect(planSql).toContain('FROM billing_plans WHERE id = $1 AND is_active');
        expect(planParams).toEqual(['payg']);
        const [updSql, updParams] = db.query.mock.calls[1];
        expect(updSql).toContain("UPDATE billing_subscriptions SET plan_id = $2, status = 'active', updated_at = now() WHERE company_id = $1");
        expect(updParams).toEqual([COMPANY_A, 'payg']);
        // The ≤0 branch fires BEFORE providerConfigured() — no PROVIDER_NOT_CONFIGURED
        // throw despite the missing key, and nothing billing-side is touched.
        expect(getProvider).not.toHaveBeenCalled();
        expect(mockProvider.chargeOffSession).not.toHaveBeenCalled();
        expect(mockProvider.createTopupCheckout).not.toHaveBeenCalled();
        expect(walletService.getWallet).not.toHaveBeenCalled();
        expect(walletService.credit).not.toHaveBeenCalled();
        expect(walletService.debit).not.toHaveBeenCalled(); // billPlanFee never ran
    });

    test('TC-B-02 (E-B3): paid plan with NO Stripe key → 422 PROVIDER_NOT_CONFIGURED, subscription untouched', async () => {
        db.query.mockResolvedValueOnce({ rows: [STARTER_PLAN] });

        await expect(billingService.subscribe(COMPANY_A, 'starter')).rejects.toMatchObject({
            httpStatus: 422,
            code: 'PROVIDER_NOT_CONFIGURED',
            message: 'Billing is not enabled yet',
        });
        // Only the plan SELECT ran — no UPDATE/INSERT on billing_subscriptions.
        expect(db.query).toHaveBeenCalledTimes(1);
        expect(db.query.mock.calls[0][0]).toContain('FROM billing_plans');
    });

    test('TC-B-03 (E-B2): repeat subscribe(payg) → again {activated:true}, byte-identical UPDATE (PK company_id, no dupes)', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [PAYG_PLAN] })
            .mockResolvedValueOnce({ rowCount: 1, rows: [] })
            .mockResolvedValueOnce({ rows: [PAYG_PLAN] })
            .mockResolvedValueOnce({ rowCount: 1, rows: [] });

        const first = await billingService.subscribe(COMPANY_A, 'payg');
        const second = await billingService.subscribe(COMPANY_A, 'payg');

        expect(first).toEqual({ activated: true });
        expect(second).toEqual({ activated: true });
        const [firstSql, firstParams] = db.query.mock.calls[1];
        const [secondSql, secondParams] = db.query.mock.calls[3];
        expect(secondSql).toBe(firstSql);
        expect(secondParams).toEqual(firstParams);
        expect(db.query).toHaveBeenCalledTimes(4); // no INSERT branch on repeat
    });

    test('TC-B-04 (E-B4): no billing_subscriptions row → INSERT … ON CONFLICT (company_id) DO UPDATE, idempotent on repeat', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [PAYG_PLAN] })
            .mockResolvedValueOnce({ rowCount: 0, rows: [] })   // UPDATE matched nothing
            .mockResolvedValueOnce({ rowCount: 1, rows: [] });  // INSERT branch

        const out = await billingService.subscribe(COMPANY_A, 'payg');
        expect(out).toEqual({ activated: true });
        const [insertSql, insertParams] = db.query.mock.calls[2];
        expect(insertSql).toContain('INSERT INTO billing_subscriptions');
        expect(insertSql).toContain('ON CONFLICT (company_id) DO UPDATE');
        expect(insertParams).toEqual([COMPANY_A, 'payg']);

        // Repeat once the row exists → the plain UPDATE path, no second INSERT.
        db.query
            .mockResolvedValueOnce({ rows: [PAYG_PLAN] })
            .mockResolvedValueOnce({ rowCount: 1, rows: [] });
        await expect(billingService.subscribe(COMPANY_A, 'payg')).resolves.toEqual({ activated: true });
        const inserts = db.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO billing_subscriptions'));
        expect(inserts).toHaveLength(1);
    });

    test('TC-B-09: unknown plan / is_active=false → 404 "Plan not available"', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // WHERE id=$1 AND is_active matches nothing

        await expect(billingService.subscribe(COMPANY_A, 'nonexistent')).rejects.toMatchObject({
            httpStatus: 404,
            message: 'Plan not available',
        });
        expect(db.query).toHaveBeenCalledTimes(1);
    });

    test('TC-B-14 (§2.4 п.2): payg with Stripe CONFIGURED and a card on file → still the ≤0 branch, no Stripe calls', async () => {
        process.env.STRIPE_SECRET_KEY = 'sk_test_configured';
        walletService.getWallet.mockResolvedValue({ default_payment_method_id: 'pm_card_on_file' });
        db.query
            .mockResolvedValueOnce({ rows: [PAYG_PLAN] })
            .mockResolvedValueOnce({ rowCount: 1, rows: [] });

        const out = await billingService.subscribe(COMPANY_A, 'payg');

        expect(out).toEqual({ activated: true });
        // The ≤0 branch is unconditional — it sits before the provider entirely.
        expect(getProvider).not.toHaveBeenCalled();
        expect(mockProvider.chargeOffSession).not.toHaveBeenCalled();
        expect(mockProvider.createTopupCheckout).not.toHaveBeenCalled();
        expect(walletService.getWallet).not.toHaveBeenCalled(); // the card is never even read
        expect(walletService.debit).not.toHaveBeenCalled();     // billPlanFee never ran
        expect(db.query).toHaveBeenCalledTimes(2);
    });
});

// ─── subscribe — paid-path regression (TC-B-05, TC-B-06) ─────────────────────

describe('billingService.subscribe — paid plans (existing logic untouched)', () => {
    beforeEach(() => {
        process.env.STRIPE_SECRET_KEY = 'sk_test_configured';
    });

    test('TC-B-05 (E-B7): starter with card on file → chargeOffSession → credit → UPDATE → billPlanFee → {activated:true}', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [STARTER_PLAN] })                                            // plan
            .mockResolvedValueOnce({ rows: [{ provider_customer_id: 'cus_1', plan_id: 'trial' }] })     // ensureCustomerId → getSubscription
            .mockResolvedValueOnce({ rowCount: 1, rows: [] })                                           // UPDATE → active
            .mockResolvedValueOnce({ rows: [{ provider_customer_id: 'cus_1', plan_id: 'starter' }] })   // billPlanFee → getSubscription
            .mockResolvedValueOnce({ rows: [STARTER_PLAN] });                                           // billPlanFee → plan row
        walletService.getWallet.mockResolvedValue({ default_payment_method_id: 'pm_1' });
        mockProvider.chargeOffSession.mockResolvedValue({ paymentIntentId: 'pi_1' });

        const out = await billingService.subscribe(COMPANY_A, 'starter');

        expect(out).toEqual({ activated: true });
        expect(mockProvider.chargeOffSession).toHaveBeenCalledWith('cus_1', 'pm_1', 49, 'Starter plan');
        expect(walletService.credit).toHaveBeenCalledWith(COMPANY_A, 49, expect.objectContaining({ type: 'topup', ref: 'pi_1' }));
        const [updSql, updParams] = db.query.mock.calls[2];
        expect(updSql).toContain('UPDATE billing_subscriptions');
        expect(updParams).toEqual([COMPANY_A, 'starter']);
        expect(walletService.debit).toHaveBeenCalledWith(COMPANY_A, 49, expect.objectContaining({ type: 'plan' }));
        // Order: charge → credit → UPDATE (3rd db call) → plan-fee debit.
        expect(mockProvider.chargeOffSession.mock.invocationCallOrder[0])
            .toBeLessThan(walletService.credit.mock.invocationCallOrder[0]);
        expect(walletService.credit.mock.invocationCallOrder[0])
            .toBeLessThan(db.query.mock.invocationCallOrder[2]);
        expect(db.query.mock.invocationCallOrder[2])
            .toBeLessThan(walletService.debit.mock.invocationCallOrder[0]);
        expect(mockProvider.createTopupCheckout).not.toHaveBeenCalled(); // no redirect on card-on-file
    });

    test('TC-B-06: starter without a card, return_path absent → createTopupCheckout with the DEFAULT URLs + metadata.plan_id', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [STARTER_PLAN] })
            .mockResolvedValueOnce({ rows: [{ provider_customer_id: 'cus_1' }] });
        walletService.getWallet.mockResolvedValue({ default_payment_method_id: null });
        mockProvider.createTopupCheckout.mockResolvedValue({ url: 'https://checkout.stripe.test/session' });

        const out = await billingService.subscribe(COMPANY_A, 'starter', {}); // exactly what the route passes with no return_path

        expect(out).toEqual({ url: 'https://checkout.stripe.test/session' });
        expect(mockProvider.createTopupCheckout).toHaveBeenCalledWith('cus_1', 49, {
            successUrl: 'https://app.albusto.com/settings/billing?status=success',
            cancelUrl: 'https://app.albusto.com/settings/billing?status=cancel',
            metadata: { albusto_company_id: COMPANY_A, plan_id: 'starter' },
        });
        expect(mockProvider.chargeOffSession).not.toHaveBeenCalled();
    });
});

// ─── POST /api/billing/checkout — return_path matrix + route behavior ────────

describe('POST /api/billing/checkout — return_path validation (§2.4 full matrix)', () => {
    let subscribeSpy;

    beforeEach(() => {
        subscribeSpy = jest.spyOn(billingService, 'subscribe').mockResolvedValue({ activated: true });
    });
    afterEach(() => {
        subscribeSpy.mockRestore();
    });

    test('TC-B-07: absent return_path → OK, subscribe called with NO successUrl/cancelUrl override', async () => {
        const res = await request(appWith()).post('/api/billing/checkout').send({ plan_id: 'payg' });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, activated: true });
        expect(subscribeSpy).toHaveBeenCalledWith(COMPANY_A, 'payg', {});
    });

    test.each([
        '/settings/integrations/telephony-twilio?step=3&billing=success',
        '/x',
    ])('TC-B-07: valid return_path %s → OK, both URLs = https://app.albusto.com + path', async (returnPath) => {
        const res = await request(appWith()).post('/api/billing/checkout').send({ plan_id: 'payg', return_path: returnPath });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, activated: true });
        expect(subscribeSpy).toHaveBeenCalledWith(COMPANY_A, 'payg', {
            successUrl: `https://app.albusto.com${returnPath}`,
            cancelUrl: `https://app.albusto.com${returnPath}`,
        });
    });

    test.each([
        ['protocol-relative //evil.com', '//evil.com'],
        ['absolute http://evil.com', 'http://evil.com'],
        ['absolute same-host https://app.albusto.com/x', 'https://app.albusto.com/x'],
        ['javascript:alert(1)', 'javascript:alert(1)'],
        ['empty string', ''],
        ['inner double slash /a//b', '/a//b'],
        ['colon in path /x:y', '/x:y'],
        ['number', 42],
        ['object', { path: '/x' }],
    ])('TC-B-07: invalid return_path (%s) → 422 INVALID_RETURN_PATH with ZERO side effects', async (_label, returnPath) => {
        const res = await request(appWith()).post('/api/billing/checkout').send({ plan_id: 'starter', return_path: returnPath });

        expect(res.status).toBe(422);
        expect(res.body).toEqual({
            ok: false,
            code: 'INVALID_RETURN_PATH',
            error: 'return_path must be a relative path',
        });
        // Validated BEFORE subscribe() — nothing was subscribed, nothing was written.
        expect(subscribeSpy).not.toHaveBeenCalled();
        expect(db.query).not.toHaveBeenCalled();
    });

    test('TC-B-10: missing plan_id → 422 "plan_id required" (existing behavior, regression)', async () => {
        const res = await request(appWith()).post('/api/billing/checkout').send({});

        expect(res.status).toBe(422);
        expect(res.body).toEqual({ ok: false, error: 'plan_id required' });
        expect(subscribeSpy).not.toHaveBeenCalled();
        expect(db.query).not.toHaveBeenCalled();
    });
});

describe('POST /api/billing/checkout — real subscribe through the route', () => {
    test('TC-B-08: valid return_path on a paid plan without a card → successUrl === cancelUrl passed through to checkout', async () => {
        process.env.STRIPE_SECRET_KEY = 'sk_test_configured';
        const RETURN_PATH = '/settings/integrations/telephony-twilio?step=3&billing=success';
        db.query
            .mockResolvedValueOnce({ rows: [STARTER_PLAN] })
            .mockResolvedValueOnce({ rows: [{ provider_customer_id: 'cus_1' }] });
        walletService.getWallet.mockResolvedValue({ default_payment_method_id: null });
        mockProvider.createTopupCheckout.mockResolvedValue({ url: 'https://checkout.stripe.test/session' });

        const res = await request(appWith())
            .post('/api/billing/checkout')
            .send({ plan_id: 'starter', return_path: RETURN_PATH });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, url: 'https://checkout.stripe.test/session' });
        const [, , urls] = mockProvider.createTopupCheckout.mock.calls[0];
        expect(urls.successUrl).toBe(`https://app.albusto.com${RETURN_PATH}`);
        expect(urls.cancelUrl).toBe(`https://app.albusto.com${RETURN_PATH}`);
        expect(urls.successUrl).toBe(urls.cancelUrl); // path-only, anti-open-redirect
    });

    test('TC-B-11 (E-B9): plan_id=trial straight through the API → ≤0 branch activates → {activated:true}', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [TRIAL_PLAN] })
            .mockResolvedValueOnce({ rowCount: 1, rows: [] });

        const res = await request(appWith()).post('/api/billing/checkout').send({ plan_id: 'trial' });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, activated: true });
        expect(getProvider).not.toHaveBeenCalled(); // documented acceptable edge (self-service downgrade)
    });

    test('TC-B-13 (§8): body company_id=COMPANY_B is ignored — every SQL is scoped to the caller company', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [PAYG_PLAN] })
            .mockResolvedValueOnce({ rowCount: 1, rows: [] });

        const res = await request(appWith({ company: COMPANY_A }))
            .post('/api/billing/checkout')
            .send({ plan_id: 'payg', company_id: COMPANY_B });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, activated: true });
        const [, updParams] = db.query.mock.calls[1];
        expect(updParams).toEqual([COMPANY_A, 'payg']); // B's subscription untouched
        const allParams = db.query.mock.calls.flatMap(([, params]) => params || []);
        expect(allParams).not.toContain(COMPANY_B);
    });
});

// ─── TC-B-12 — mount auth matrix (behavioral + structural) ────────────────────
// tests/billingUI.test.js fakes the mount middleware and does NOT cover the auth chain,
// so this extends (not duplicates) it with the real middleware.

describe('POST /api/billing/checkout — mount 401/403 (real middleware chain)', () => {
    test('TC-B-12а: no token → 401 AUTH_REQUIRED before the router runs', async () => {
        const app = express();
        app.use(express.json());
        // Exact production chain from src/server.js.
        app.use('/api/billing', authenticate, requirePermission('tenant.company.manage'), requireCompanyAccess, billingRouter);

        const res = await request(app).post('/api/billing/checkout').send({ plan_id: 'payg' });

        expect(res.status).toBe(401);
        expect(res.body).toEqual(expect.objectContaining({ code: 'AUTH_REQUIRED' }));
        expect(db.query).not.toHaveBeenCalled();
    });

    test('TC-B-12б: token without tenant.company.manage → 403 from requirePermission', async () => {
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            // Authenticated, tenant-scoped, but lacking the billing permission.
            req.user = { sub: 'kc-2', email: 'member@a.com', crmUser: { id: 'u2' } };
            req.authz = { permissions: ['jobs.read'], company: { id: COMPANY_A }, scope: 'tenant' };
            next();
        });
        app.use('/api/billing', requirePermission('tenant.company.manage'), requireCompanyAccess, billingRouter);

        const res = await request(app).post('/api/billing/checkout').send({ plan_id: 'payg' });

        expect(res.status).toBe(403);
        expect(res.body).toEqual(expect.objectContaining({ code: 'ACCESS_DENIED' }));
        expect(db.query).not.toHaveBeenCalled();
    });

    test('TC-B-12 (structural): src/server.js mounts /api/billing with the full auth chain (not weakened)', () => {
        const source = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
        expect(source).toContain(
            "app.use('/api/billing', authenticate, requirePermission('tenant.company.manage'), requireCompanyAccess, billingRouter);"
        );
    });
});
