/**
 * PROVIDER-FINANCE-001 + SOURCE-PERM-001 — route-gate coverage.
 *
 * The DB is mocked in this repo, so this is a focused gate test (mirrors
 * tests/jobsRbacGates.test.js): mock each router's service deps so it mounts
 * cleanly, mount the router on an express app, inject req.authz.permissions,
 * and assert the requirePermission gate lets the right perms through / blocks
 * the rest. A passing gate calls the (mocked) service → 2xx; a blocked gate
 * short-circuits → 403, so the service must NOT have been called.
 *
 * GOAL A: the provider role's NEW finance perm set PASSES estimates/invoices
 *         list+create, payments list, and an offline-collect route, but is
 *         BLOCKED from refund (refund needs payments.refund, provider lacks).
 * GOAL B: a static assertion that 050 + the catalog grant lead_source.view to
 *         tenant_admin/manager/dispatcher and NOT to provider.
 */

// ── Mock estimates service deps ──
const mockEstimates = {
    listEstimates: jest.fn(async () => ({ items: [], total: 0 })),
    createEstimate: jest.fn(async () => ({ id: 'est-1' })),
};
jest.mock('../backend/src/services/estimatesService', () => mockEstimates);

// ── Mock invoices service deps ──
const mockInvoices = {
    listInvoices: jest.fn(async () => ({ items: [], total: 0 })),
    createInvoice: jest.fn(async () => ({ id: 'inv-1' })),
    recordPayment: jest.fn(async () => ({ id: 'inv-1', paid: true })),
};
jest.mock('../backend/src/services/invoicesService', () => mockInvoices);

// ── Mock payments service deps ──
const mockPayments = {
    listTransactions: jest.fn(async () => ({ items: [], total: 0 })),
    recordManualPayment: jest.fn(async () => ({ id: 'pay-1' })),
    refundTransaction: jest.fn(async () => ({ id: 'pay-1', refunded: true })),
};
jest.mock('../backend/src/services/paymentsService', () => mockPayments);

// invoices.js loads stripePaymentsService at module scope and references
// StripePaymentsError in its error helper — provide a real class so requires resolve.
jest.mock('../backend/src/services/stripePaymentsService', () => {
    class StripePaymentsError extends Error {}
    return { StripePaymentsError };
});

const express = require('express');
const request = require('supertest');
const fs = require('fs');
const path = require('path');

const estimatesRouter = require('../backend/src/routes/estimates');
const invoicesRouter = require('../backend/src/routes/invoices');
const paymentsRouter = require('../backend/src/routes/payments');

// The provider's NEW finance perm set after PROVIDER-FINANCE-001 (no refund).
const PROVIDER_FINANCE = [
    'financial_data.view',
    'estimates.view', 'estimates.create', 'estimates.send',
    'invoices.view', 'invoices.create', 'invoices.send',
    'payments.view',
    'payments.collect_online', 'payments.collect_offline',
    'payments.collect_keyed', 'payments.collect_terminal',
];

function appAs(router, perms) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'u1', email: 't@t.com', name: 'Tester' };
        req.authz = { scope: 'tenant', permissions: perms, scopes: {} };
        req.companyFilter = { company_id: 'co' };
        next();
    });
    app.use('/', router);
    return app;
}

beforeEach(() => {
    [...Object.values(mockEstimates), ...Object.values(mockInvoices), ...Object.values(mockPayments)]
        .forEach(f => f.mockClear());
});

describe('PROVIDER-FINANCE-001 — provider finance perm set passes self-serve finance', () => {
    test('GET /api/estimates is allowed (estimates.view)', async () => {
        expect((await request(appAs(estimatesRouter, PROVIDER_FINANCE)).get('/')).status).toBe(200);
        expect(mockEstimates.listEstimates).toHaveBeenCalled();
    });

    test('POST /api/estimates is allowed (estimates.create)', async () => {
        const res = await request(appAs(estimatesRouter, PROVIDER_FINANCE)).post('/').send({ contact_id: 'c1' });
        expect(res.status).toBe(201);
        expect(mockEstimates.createEstimate).toHaveBeenCalled();
    });

    test('GET /api/invoices is allowed (invoices.view)', async () => {
        expect((await request(appAs(invoicesRouter, PROVIDER_FINANCE)).get('/')).status).toBe(200);
        expect(mockInvoices.listInvoices).toHaveBeenCalled();
    });

    test('POST /api/invoices is allowed (invoices.create)', async () => {
        const res = await request(appAs(invoicesRouter, PROVIDER_FINANCE)).post('/').send({ contact_id: 'c1' });
        expect(res.status).toBe(201);
        expect(mockInvoices.createInvoice).toHaveBeenCalled();
    });

    test('GET /api/payments is allowed (payments.view)', async () => {
        expect((await request(appAs(paymentsRouter, PROVIDER_FINANCE)).get('/')).status).toBe(200);
        expect(mockPayments.listTransactions).toHaveBeenCalled();
    });

    test('POST /api/payments/manual (offline collect) is allowed (payments.collect_offline)', async () => {
        const res = await request(appAs(paymentsRouter, PROVIDER_FINANCE)).post('/manual').send({ amount: 100 });
        expect(res.status).toBe(201);
        expect(mockPayments.recordManualPayment).toHaveBeenCalled();
    });

    test('POST /api/invoices/:id/record-payment (offline collect) is allowed', async () => {
        const res = await request(appAs(invoicesRouter, PROVIDER_FINANCE)).post('/inv-1/record-payment').send({ amount: 100 });
        expect(res.status).toBe(200);
        expect(mockInvoices.recordPayment).toHaveBeenCalled();
    });
});

describe('PROVIDER-FINANCE-001 — provider is BLOCKED from refund (no payments.refund)', () => {
    test('POST /api/payments/:id/refund is 403 and never reaches the service', async () => {
        const res = await request(appAs(paymentsRouter, PROVIDER_FINANCE)).post('/pay-1/refund').send({ amount: 50 });
        expect(res.status).toBe(403);
        expect(mockPayments.refundTransaction).not.toHaveBeenCalled();
    });

    test('a holder of payments.refund CAN refund (control)', async () => {
        const res = await request(appAs(paymentsRouter, ['payments.refund'])).post('/pay-1/refund').send({ amount: 50 });
        expect(res.status).toBe(201);
        expect(mockPayments.refundTransaction).toHaveBeenCalled();
    });
});

describe('SOURCE-PERM-001 — lead_source.view seeded for office roles, NOT provider', () => {
    const sql = fs.readFileSync(
        path.join(__dirname, '..', 'backend', 'db', 'migrations', '050_seed_role_configs.sql'),
        'utf8',
    );

    // Slice the file into per-role permission blocks so we can assert membership
    // of lead_source.view inside the right role's VALUES list. The body must not
    // cross into another role's block, so it may not contain an intervening
    // `WHERE rc.role_key =` before the target — otherwise a greedy/lazy match
    // would swallow earlier blocks (which DO have lead_source.view).
    function permBlockFor(roleKey) {
        const re = new RegExp(
            `INSERT INTO company_role_permissions(?:(?!WHERE rc\\.role_key =)[\\s\\S])*?WHERE rc\\.role_key = '${roleKey}'`,
        );
        const m = sql.match(re);
        if (!m) throw new Error(`no permission block found for role ${roleKey}`);
        return m[0];
    }

    test.each(['tenant_admin', 'manager', 'dispatcher'])(
        '%s permission block includes lead_source.view',
        (role) => {
            expect(permBlockFor(role)).toContain("('lead_source.view')");
        },
    );

    test('provider permission block does NOT include lead_source.view', () => {
        expect(permBlockFor('provider')).not.toContain('lead_source.view');
    });

    test('catalog exposes lead_source.view exactly once', () => {
        const { ALL_PERMISSION_KEYS } = require('../backend/src/services/permissionCatalog');
        expect(ALL_PERMISSION_KEYS.filter(k => k === 'lead_source.view')).toHaveLength(1);
    });
});
