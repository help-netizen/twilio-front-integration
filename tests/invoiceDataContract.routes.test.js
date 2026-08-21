'use strict';

const express = require('express');
const request = require('supertest');

const COMPANY_ID = '00000000-0000-4000-8000-000000000091';
const CRM_USER_ID = '00000000-0000-4000-8000-000000000092';
const TX_CLIENT = { query: jest.fn() };

const mockListInvoices = jest.fn();
const mockCreateInvoice = jest.fn();
const mockUpdateInvoice = jest.fn();
const mockDeleteInvoice = jest.fn();
const mockVoidInvoice = jest.fn();
const mockPreviewInvoiceRemoval = jest.fn();
const mockRemoveInvoice = jest.fn();
const mockGetPayments = jest.fn();
const mockRecordOfflinePayment = jest.fn();
const mockEnsurePaymentLink = jest.fn();
const mockGetPaymentLink = jest.fn();
const mockCreateManualCardSession = jest.fn();
const mockWithTransaction = jest.fn(work => work(TX_CLIENT));

jest.mock('../backend/src/services/invoicesService', () => ({
    listInvoices: (...args) => mockListInvoices(...args),
    createInvoice: (...args) => mockCreateInvoice(...args),
    updateInvoice: (...args) => mockUpdateInvoice(...args),
    deleteInvoice: (...args) => mockDeleteInvoice(...args),
    voidInvoice: (...args) => mockVoidInvoice(...args),
    previewInvoiceRemoval: (...args) => mockPreviewInvoiceRemoval(...args),
    removeInvoice: (...args) => mockRemoveInvoice(...args),
    getPayments: (...args) => mockGetPayments(...args),
    recordOfflinePayment: (...args) => mockRecordOfflinePayment(...args),
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
    ensurePaymentLink: (...args) => mockEnsurePaymentLink(...args),
    getPaymentLink: (...args) => mockGetPaymentLink(...args),
    createManualCardSession: (...args) => mockCreateManualCardSession(...args),
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
    mockDeleteInvoice.mockResolvedValue({ deleted: true });
    mockVoidInvoice.mockResolvedValue({ id: 57, status: 'void' });
    mockPreviewInvoiceRemoval.mockResolvedValue({
        disposition: 'voided',
        payments_total: '50.00',
        payments_count: 1,
        candidate: { id: 58, invoice_number: 'INVOICE 10-2', balance_due: '50.00' },
        preview_version: 'a'.repeat(64),
    });
    mockRemoveInvoice.mockResolvedValue({
        invoice_id: 57,
        disposition: 'voided',
        payment_action: 'leave_unapplied',
    });
    mockGetPayments.mockResolvedValue([{ id: 81, invoice_id: 57 }]);
    mockRecordOfflinePayment.mockResolvedValue({ id: 81, invoice_id: 57 });
    mockEnsurePaymentLink.mockResolvedValue({ url: 'https://pay.test/invoice-57' });
    mockGetPaymentLink.mockResolvedValue({ active: null, attempts: [] });
    mockCreateManualCardSession.mockResolvedValue({ session_id: 91, amount: 188.5 });
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

describe('invoice collection route contract', () => {
    it('reads invoice payment-link state only with invoice and payment view rights', async () => {
        const response = await request(appWith(['invoices.view', 'payments.view']))
            .get('/57/stripe-payment-link');

        expect(response.status).toBe(200);
        expect(mockGetPaymentLink).toHaveBeenCalledWith(COMPANY_ID, '57');
    });

    it.each([
        ['payments.view only', ['payments.view']],
        ['invoices.view only', ['invoices.view']],
        ['neither permission', []],
    ])('denies payment-link reads with %s', async (_label, permissions) => {
        const response = await request(appWith(permissions))
            .get('/57/stripe-payment-link');

        expect(response.status).toBe(403);
        expect(mockGetPaymentLink).not.toHaveBeenCalled();
    });

    it('creates an online pay link with companyFilter and the crmUser actor', async () => {
        const response = await request(appWith(['payments.collect_online']))
            .post('/57/stripe-payment-link')
            .send({ amount: 188.5 });

        expect(response.status).toBe(200);
        expect(mockEnsurePaymentLink).toHaveBeenCalledWith(
            COMPANY_ID,
            { id: CRM_USER_ID },
            '57',
            { amount: 188.5 },
            TX_CLIENT,
            { id: CRM_USER_ID, type: 'user', label: null, source: 'crm' }
        );
        expect(mockEnsurePaymentLink.mock.calls[0]).not.toContain('keycloak-subject-must-not-be-used');
    });

    it('creates a keyed-card session bound to the selected invoice', async () => {
        const response = await request(appWith(['payments.collect_keyed']))
            .post('/57/stripe-manual-card-session')
            .send({ amount: 125 });

        expect(response.status).toBe(200);
        expect(mockCreateManualCardSession).toHaveBeenCalledWith(
            COMPANY_ID,
            { id: CRM_USER_ID },
            { invoiceId: '57', amount: 125 },
            TX_CLIENT,
            { id: CRM_USER_ID, type: 'user', label: null, source: 'crm' }
        );
    });

    it('records cash/check through the invoice service with tenant scope and crmUser actor', async () => {
        const body = { amount: 50, payment_method: 'check' };
        const response = await request(appWith(['payments.collect_offline']))
            .post('/57/record-payment')
            .send(body);

        expect(response.status).toBe(200);
        expect(mockRecordOfflinePayment).toHaveBeenCalledWith(
            COMPANY_ID,
            CRM_USER_ID,
            '57',
            body,
            TX_CLIENT,
            { id: CRM_USER_ID, type: 'user', label: null, source: 'crm' }
        );
    });

    it.each([
        ['online link', '/57/stripe-payment-link', 'payments.collect_online', ['payments.collect_keyed', 'payments.collect_offline'], mockEnsurePaymentLink],
        ['keyed card', '/57/stripe-manual-card-session', 'payments.collect_keyed', ['payments.collect_online', 'payments.collect_offline'], mockCreateManualCardSession],
        ['offline payment', '/57/record-payment', 'payments.collect_offline', ['payments.collect_online', 'payments.collect_keyed'], mockRecordOfflinePayment],
    ])('denies %s without %s even when other collection rights exist', async (_label, path, _permission, wrongPermissions, write) => {
        const response = await request(appWith(['invoices.view', ...wrongPermissions]))
            .post(path)
            .send({ amount: 10, payment_method: 'cash' });

        expect(response.status).toBe(403);
        expect(write).not.toHaveBeenCalled();
    });

    it.each([
        ['online link', '/57/stripe-payment-link', 'payments.collect_online', mockEnsurePaymentLink],
        ['keyed card', '/57/stripe-manual-card-session', 'payments.collect_keyed', mockCreateManualCardSession],
        ['offline payment', '/57/record-payment', 'payments.collect_offline', mockRecordOfflinePayment],
    ])('preserves tenant-safe not found for %s', async (_label, path, permission, write) => {
        write.mockRejectedValueOnce(Object.assign(
            new Error('Invoice 57 not found'),
            { code: 'NOT_FOUND', httpStatus: 404 }
        ));

        const response = await request(appWith([permission]))
            .post(path)
            .send({ amount: 10, payment_method: 'cash' });

        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe('NOT_FOUND');
        expect(write).toHaveBeenCalled();
        expect(write.mock.calls[0][0]).toBe(COMPANY_ID);
    });

    it('passes the selected invoice id through a tenant-safe offline 404', async () => {
        mockRecordOfflinePayment.mockRejectedValueOnce(Object.assign(
            new Error('Invoice 57 not found'),
            { code: 'NOT_FOUND', httpStatus: 404 }
        ));

        const response = await request(appWith(['payments.collect_offline']))
            .post('/57/record-payment')
            .send({ amount: 10, payment_method: 'cash' });

        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe('NOT_FOUND');
        expect(mockRecordOfflinePayment).toHaveBeenCalledWith(
            COMPANY_ID,
            CRM_USER_ID,
            '57',
            expect.any(Object),
            TX_CLIENT,
            expect.any(Object)
        );
    });
});

describe('unified invoice removal route contract', () => {
    it('previews with the isolated invoices.create gate and companyFilter scope', async () => {
        const response = await request(appWith(['invoices.create']))
            .get('/57/removal-preview');

        expect(response.status).toBe(200);
        expect(response.body.data.preview_version).toBe('a'.repeat(64));
        expect(mockPreviewInvoiceRemoval).toHaveBeenCalledWith(COMPANY_ID, '57');
        expect(mockPreviewInvoiceRemoval.mock.calls[0]).not.toContain(
            'LEGACY-COMPANY-MUST-NOT-BE-USED'
        );
    });

    it('performs the explicit choice in one transaction with the CRM actor', async () => {
        const body = {
            preview_version: 'a'.repeat(64),
            request_id: 'remove-request-57',
            payment_action: 'apply',
            target_invoice_id: 58,
        };
        const response = await request(appWith(['invoices.create']))
            .post('/57/remove')
            .send(body);

        expect(response.status).toBe(200);
        expect(response.body.data.disposition).toBe('voided');
        expect(mockRemoveInvoice).toHaveBeenCalledWith(
            COMPANY_ID,
            '57',
            CRM_USER_ID,
            body,
            TX_CLIENT,
            { id: CRM_USER_ID, type: 'user', label: null, source: 'crm' }
        );
        expect(mockRemoveInvoice.mock.calls[0]).not.toContain(
            'keycloak-subject-must-not-be-used'
        );
    });

    it.each([
        ['no permissions', []],
        ['invoice read only', ['invoices.view']],
        ['invoice send only', ['invoices.send']],
        ['payment collection rights', [
            'payments.collect_online',
            'payments.collect_keyed',
            'payments.collect_offline',
        ]],
    ])('R-matrix: denies preview and perform with %s', async (_label, permissions) => {
        const app = appWith(permissions);
        const preview = await request(app).get('/57/removal-preview');
        const perform = await request(app).post('/57/remove').send({
            preview_version: 'a'.repeat(64),
            request_id: 'remove-request-denied',
            payment_action: 'leave_unapplied',
        });

        expect(preview.status).toBe(403);
        expect(perform.status).toBe(403);
        expect(mockPreviewInvoiceRemoval).not.toHaveBeenCalled();
        expect(mockRemoveInvoice).not.toHaveBeenCalled();
        expect(mockWithTransaction).not.toHaveBeenCalled();
    });

    it('keeps a foreign invoice response tenant-safe and unchanged at the route seam', async () => {
        mockRemoveInvoice.mockRejectedValueOnce(Object.assign(
            new Error('Invoice 57 not found'),
            { code: 'NOT_FOUND', httpStatus: 404 }
        ));

        const response = await request(appWith(['invoices.create']))
            .post('/57/remove')
            .send({
                preview_version: 'a'.repeat(64),
                request_id: 'remove-request-foreign',
                payment_action: 'leave_unapplied',
            });

        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe('NOT_FOUND');
        expect(mockRemoveInvoice.mock.calls[0][0]).toBe(COMPANY_ID);
    });
});

describe('invoice destructive-action route contract', () => {
    it('passes the companyFilter scope and crmUser actor to draft deletion', async () => {
        const response = await request(appWith(['invoices.create'])).delete('/57');

        expect(response.status).toBe(200);
        expect(mockDeleteInvoice).toHaveBeenCalledWith(
            COMPANY_ID,
            '57',
            CRM_USER_ID,
            TX_CLIENT,
            { id: CRM_USER_ID, type: 'user', label: null, source: 'crm' }
        );
        expect(mockDeleteInvoice.mock.calls[0]).not.toContain('keycloak-subject-must-not-be-used');
        expect(mockDeleteInvoice.mock.calls[0]).not.toContain('LEGACY-COMPANY-MUST-NOT-BE-USED');
    });

    it('passes the same tenant and actor contract to issued-invoice void', async () => {
        const response = await request(appWith(['invoices.create'])).post('/57/void');

        expect(response.status).toBe(200);
        expect(mockVoidInvoice).toHaveBeenCalledWith(
            COMPANY_ID,
            '57',
            CRM_USER_ID,
            TX_CLIENT,
            { id: CRM_USER_ID, type: 'user', label: null, source: 'crm' }
        );
        expect(mockVoidInvoice.mock.calls[0]).not.toContain('keycloak-subject-must-not-be-used');
        expect(mockVoidInvoice.mock.calls[0]).not.toContain('LEGACY-COMPANY-MUST-NOT-BE-USED');
    });

    it.each([
        ['draft delete', app => request(app).delete('/57')],
        ['invoice void', app => request(app).post('/57/void')],
    ])('denies %s to an invoices.view-only user before any write', async (_label, callRoute) => {
        const response = await callRoute(appWith(['invoices.view']));

        expect(response.status).toBe(403);
        expect(mockWithTransaction).not.toHaveBeenCalled();
        expect(mockDeleteInvoice).not.toHaveBeenCalled();
        expect(mockVoidInvoice).not.toHaveBeenCalled();
    });
});
