'use strict';

const express = require('express');
const request = require('supertest');

const COMPANY_ID = '00000000-0000-4000-8000-000000000091';
const CRM_USER_ID = '00000000-0000-4000-8000-000000000092';
const TX_CLIENT = { query: jest.fn() };

const mockListInvoices = jest.fn();
const mockCreateInvoice = jest.fn();
const mockUpdateInvoice = jest.fn();
const mockGetPayments = jest.fn();
const mockWithTransaction = jest.fn(work => work(TX_CLIENT));

jest.mock('../backend/src/services/invoicesService', () => ({
    listInvoices: (...args) => mockListInvoices(...args),
    createInvoice: (...args) => mockCreateInvoice(...args),
    updateInvoice: (...args) => mockUpdateInvoice(...args),
    getPayments: (...args) => mockGetPayments(...args),
}));
jest.mock('../backend/src/services/aiGenerationLogService', () => ({ linkFinal: jest.fn() }));
jest.mock('../backend/src/services/documentSendNoteService', () => ({
    actorFromRequest: jest.fn(() => null),
}));
jest.mock('../backend/src/services/financialActivityService', () => ({
    userActor: jest.fn(id => ({ id, type: 'user', label: null, source: 'crm' })),
}));
jest.mock('../backend/src/services/transactionService', () => ({
    withTransaction: (...args) => mockWithTransaction(...args),
}));
jest.mock('../backend/src/services/stripePaymentsService', () => ({
    StripePaymentsError: class StripePaymentsError extends Error {},
}));
jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn(() => Promise.resolve()),
}));

const invoicesRouter = require('../backend/src/routes/invoices');

function appWith(permissions) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.companyFilter = { company_id: COMPANY_ID };
        req.companyId = 'LEGACY-COMPANY-MUST-NOT-BE-USED';
        req.user = {
            sub: 'keycloak-subject-must-not-be-used',
            crmUser: { id: CRM_USER_ID },
        };
        req.authz = { permissions };
        next();
    });
    app.use('/', invoicesRouter);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockListInvoices.mockResolvedValue({ rows: [{ id: 57 }], total: 76 });
    mockCreateInvoice.mockResolvedValue({ id: 57, items: [] });
    mockUpdateInvoice.mockResolvedValue({ id: 57, items: [] });
    mockGetPayments.mockResolvedValue([{ id: 81, invoice_id: 57 }]);
    mockWithTransaction.mockImplementation(work => work(TX_CLIENT));
});

describe('invoice list pagination contract', () => {
    it('uses the tenant-scoped offset contract and ignores the obsolete page query', async () => {
        const response = await request(appWith(['invoices.view']))
            .get('/?limit=25&offset=50&page=99');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            ok: true,
            data: { rows: [{ id: 57 }], total: 76 },
        });
        expect(mockListInvoices).toHaveBeenCalledWith(COMPANY_ID, {
            limit: 25,
            offset: 50,
        });
        expect(mockListInvoices.mock.calls[0]).not.toContain('LEGACY-COMPANY-MUST-NOT-BE-USED');
    });

    it('denies list reads without invoices.view', async () => {
        const response = await request(appWith([])).get('/?offset=50');

        expect(response.status).toBe(403);
        expect(mockListInvoices).not.toHaveBeenCalled();
    });
});

describe('hydrated invoice item replacement contract', () => {
    it('rejects a whole-item-array PUT that does not prove hydration', async () => {
        const response = await request(appWith(['invoices.create']))
            .put('/57')
            .send({ title: 'Unsafe summary edit', items: [] });

        expect(response.status).toBe(409);
        expect(response.body).toEqual({
            ok: false,
            error: {
                code: 'INVOICE_ITEMS_NOT_HYDRATED',
                message: 'Reload the full invoice before replacing its line items.',
            },
        });
        expect(mockWithTransaction).not.toHaveBeenCalled();
        expect(mockUpdateInvoice).not.toHaveBeenCalled();
    });

    it('accepts a hydrated item replacement and passes only companyFilter/crmUser ids', async () => {
        const body = { title: 'Hydrated edit', items: [] };
        const response = await request(appWith(['invoices.create']))
            .put('/57')
            .set('X-Invoice-Items-Hydrated', 'true')
            .send(body);

        expect(response.status).toBe(200);
        expect(mockUpdateInvoice).toHaveBeenCalledWith(
            COMPANY_ID,
            CRM_USER_ID,
            '57',
            body,
            TX_CLIENT,
            { id: CRM_USER_ID, type: 'user', label: null, source: 'crm' }
        );
        expect(mockUpdateInvoice.mock.calls[0]).not.toContain('keycloak-subject-must-not-be-used');
        expect(mockUpdateInvoice.mock.calls[0]).not.toContain('LEGACY-COMPANY-MUST-NOT-BE-USED');
    });

    it('keeps scalar-only updates and invoice creation unchanged without the header', async () => {
        const updateResponse = await request(appWith(['invoices.create']))
            .put('/57')
            .send({ notes: 'Scalar detail edit' });
        const createResponse = await request(appWith(['invoices.create']))
            .post('/')
            .send({ title: 'New empty invoice', items: [] });

        expect(updateResponse.status).toBe(200);
        expect(createResponse.status).toBe(201);
        expect(mockUpdateInvoice).toHaveBeenCalledTimes(1);
        expect(mockCreateInvoice).toHaveBeenCalledTimes(1);
    });

    it('denies item replacement to an invoices.view-only user before any write', async () => {
        const response = await request(appWith(['invoices.view']))
            .put('/57')
            .set('X-Invoice-Items-Hydrated', 'true')
            .send({ items: [] });

        expect(response.status).toBe(403);
        expect(mockWithTransaction).not.toHaveBeenCalled();
        expect(mockUpdateInvoice).not.toHaveBeenCalled();
    });
});

describe('invoice payment-history permission', () => {
    it('loads payment history only with both the backend read permission and tenant scope', async () => {
        const response = await request(appWith(['invoices.view', 'payments.view']))
            .get('/57/payments');

        expect(response.status).toBe(200);
        expect(response.body.data).toEqual([{ id: 81, invoice_id: 57 }]);
        expect(mockGetPayments).toHaveBeenCalledWith(COMPANY_ID, '57');
    });

    it.each([
        ['invoice view only', ['invoices.view']],
        ['payments view only', ['payments.view']],
        ['collection write only', ['invoices.view', 'payments.collect_offline']],
    ])('does not treat %s as payments.view', async (_label, permissions) => {
        const response = await request(appWith(permissions)).get('/57/payments');

        expect(response.status).toBe(403);
        expect(mockGetPayments).not.toHaveBeenCalled();
    });
});
