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

const mockPortalTokenWrite = jest.fn();
const mockPortal = {
    generatePortalLink: jest.fn(),
};
jest.mock('../backend/src/services/portalService', () => mockPortal);
jest.mock('../backend/src/middleware/keycloakAuth', () => ({
    authenticate: (_req, _res, next) => next(),
    requireCompanyAccess: (_req, _res, next) => next(),
}));
jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn(() => Promise.resolve()),
}));

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
const portalRouter = require('../backend/src/routes/portal');

const ROLE_SEED_SQL = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '050_seed_role_configs.sql'),
    'utf8',
);

function permBlockFor(roleKey) {
    const re = new RegExp(
        `INSERT INTO company_role_permissions(?:(?!WHERE rc\\.role_key =)[\\s\\S])*?WHERE rc\\.role_key = '${roleKey}'`,
    );
    const match = ROLE_SEED_SQL.match(re);
    if (!match) throw new Error(`no permission block found for role ${roleKey}`);
    return match[0];
}

// The provider's NEW finance perm set after PROVIDER-FINANCE-001 (no refund).
const PROVIDER_FINANCE = [
    'financial_data.view',
    'estimates.view', 'estimates.create', 'estimates.send',
    'invoices.view', 'invoices.create', 'invoices.send',
    'payments.view',
    'payments.collect_online', 'payments.collect_offline',
    'payments.collect_keyed', 'payments.collect_terminal',
];
const PROVIDER_PORTAL = [...PROVIDER_FINANCE];
const DISPATCHER_PORTAL = ['client_job_history.view', 'contacts.view'];

function appAs(router, perms) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'u1', email: 't@t.com', name: 'Tester', crmUser: { id: 'crm-u1' } };
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
    mockPortalTokenWrite.mockClear();
    mockPortal.generatePortalLink.mockReset().mockImplementation(async () => {
        mockPortalTokenWrite();
        return { url: 'https://portal.test/link', token: 'token-1' };
    });
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

describe('RBAC-WAVE1-001 — portal link permission matrix', () => {
    test.each([
        ['estimate document', { scope: 'document', document_type: 'estimate', document_id: 'est-1' }],
        ['invoice document', { scope: 'document', document_type: 'invoice', document_id: 'inv-1' }],
        ['full portal', { scope: 'full' }],
    ])('provider CAN generate a %s link with its document-send permissions', async (_label, query) => {
        const res = await request(appAs(portalRouter, PROVIDER_PORTAL))
            .get('/links').query({ contact_id: 'contact-1', ...query });

        expect(res.status).toBe(200);
        expect(mockPortal.generatePortalLink).toHaveBeenCalledWith('co', 'contact-1', expect.objectContaining({
            scope: query.scope,
            documentType: query.document_type,
        }));
    });

    test.each([
        ['estimate document', { scope: 'document', document_type: 'estimate', document_id: 'est-1' }],
        ['invoice document', { scope: 'document', document_type: 'invoice', document_id: 'inv-1' }],
        ['full portal', { scope: 'full' }],
    ])('dispatcher is denied a %s link because it has no send permission', async (_label, query) => {
        const res = await request(appAs(portalRouter, DISPATCHER_PORTAL))
            .get('/links').query({ contact_id: 'contact-1', ...query });

        expect(res.status).toBe(403);
        expect(mockPortal.generatePortalLink).not.toHaveBeenCalled();
        expect(mockPortalTokenWrite).not.toHaveBeenCalled();
    });

    test('T-foreign: foreign contact returns 404 and does not create a portal token', async () => {
        mockPortal.generatePortalLink.mockImplementationOnce(async () => {
            throw Object.assign(new Error('Contact not found in this company'), {
                httpStatus: 404,
                code: 'CONTACT_NOT_FOUND',
            });
        });

        const res = await request(appAs(portalRouter, PROVIDER_PORTAL))
            .get('/links')
            .query({ contact_id: 'foreign-contact', scope: 'document', document_type: 'estimate', document_id: 'est-1' });

        expect(res.status).toBe(404);
        expect(mockPortal.generatePortalLink).toHaveBeenCalledWith('co', 'foreign-contact', expect.any(Object));
        expect(mockPortalTokenWrite).not.toHaveBeenCalled();
    });
});

describe('SOURCE-PERM-001 — lead_source.view seeded for office roles, NOT provider', () => {
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

describe('RBAC-WAVE1-001 — role-holder proof from permission seeds', () => {
    const officeRoles = ['tenant_admin', 'manager', 'dispatcher'];
    const allRoles = [...officeRoles, 'provider'];

    test.each(allRoles)('%s retains job attachment read/write-flow and voice permissions', (role) => {
        const block = permBlockFor(role);
        expect(block).toContain("('jobs.view')");
        expect(block).toContain("('jobs.done_pending_approval')");
        expect(block).toContain("('phone_calls.use')");
    });

    test.each(officeRoles)('%s holds every office attachment permission', (role) => {
        const block = permBlockFor(role);
        for (const permission of ['jobs.edit', 'leads.view', 'leads.edit', 'contacts.view', 'contacts.edit']) {
            expect(block).toContain(`('${permission}')`);
        }
        expect(block).toContain("('client_job_history.view')");
    });

    test('provider is denied lead/contact attachments but retains estimate/invoice send', () => {
        const block = permBlockFor('provider');
        for (const permission of ['leads.view', 'leads.edit', 'contacts.view', 'contacts.edit', 'jobs.edit']) {
            expect(block).not.toContain(permission);
        }
        expect(block).not.toContain('client_job_history.view');
        expect(block).toContain("('estimates.send')");
        expect(block).toContain("('invoices.send')");

        const backfill = fs.readFileSync(
            path.join(__dirname, '..', 'backend', 'db', 'migrations', '138_provider_finance_and_source_perm.sql'),
            'utf8',
        );
        expect(backfill).toContain("('estimates.send')");
        expect(backfill).toContain("('invoices.send')");
        expect(backfill).toContain("WHERE rc.role_key = 'provider'");
    });

    test('provider job visibility is seeded assigned-only', () => {
        expect(ROLE_SEED_SQL).toMatch(
            /\('job_visibility',\s+'"assigned_only"'\)[\s\S]*WHERE rc\.role_key = 'provider'/,
        );
    });

    test('portal send matrix allows tenant_admin/manager/provider and denies dispatcher', () => {
        for (const role of ['tenant_admin', 'manager']) {
            expect(permBlockFor(role)).toContain("('estimates.send')");
            expect(permBlockFor(role)).toContain("('invoices.send')");
        }
        expect(permBlockFor('dispatcher')).not.toContain('estimates.send');
        expect(permBlockFor('dispatcher')).not.toContain('invoices.send');
    });

    test('every selected permission is in the runtime catalog', () => {
        const { ALL_PERMISSION_KEYS } = require('../backend/src/services/permissionCatalog');
        for (const permission of [
            'jobs.view', 'jobs.edit', 'jobs.done_pending_approval',
            'leads.view', 'leads.edit', 'contacts.view', 'contacts.edit',
            'estimates.send', 'invoices.send', 'phone_calls.use',
        ]) {
            expect(ALL_PERMISSION_KEYS).toContain(permission);
        }
    });
});
