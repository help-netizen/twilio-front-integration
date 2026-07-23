'use strict';

const express = require('express');
const request = require('supertest');

const mockVoidPayment = jest.fn();
jest.mock('../backend/src/services/invoicesService', () => ({
    voidPayment: mockVoidPayment,
}));
jest.mock('../backend/src/services/stripePaymentsService', () => ({
    StripePaymentsError: class StripePaymentsError extends Error {},
}));
jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn(() => Promise.resolve()),
}));

const invoicesRouter = require('../backend/src/routes/invoices');

const COMPANY_ID = '00000000-0000-4000-8000-000000000031';
const CRM_USER_ID = '00000000-0000-4000-8000-000000000032';
const INVOICE_ID = '57';
const PAYMENT_ID = '81';

const ROLE_PERMISSIONS = {
    tenant_admin: ['payments.collect_offline'],
    manager: ['payments.collect_offline'],
    dispatcher: [],
    provider: ['payments.collect_offline'],
};

function appAs(role, { includeCrmUser = true } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.companyFilter = { company_id: COMPANY_ID };
        req.companyId = 'LEGACY-COMPANY-MUST-NOT-BE-USED';
        req.user = { sub: 'keycloak-subject' };
        if (includeCrmUser) req.user.crmUser = { id: CRM_USER_ID };
        req.authz = {
            scope: 'tenant',
            permissions: ROLE_PERMISSIONS[role],
            scopes: {},
        };
        next();
    });
    app.use('/', invoicesRouter);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockVoidPayment.mockResolvedValue({
        payment: { id: PAYMENT_ID, status: 'voided', voided_at: '2026-07-23T12:00:00Z' },
        invoice: { id: INVOICE_ID, amount_paid: '0.00', balance_due: '100.00', status: 'sent' },
        idempotent: false,
    });
});

describe('POST /api/invoices/:invoiceId/payments/:paymentId/void', () => {
    test.each(['tenant_admin', 'manager', 'provider'])(
        'R-matrix allow: %s can void a manual/offline payment',
        async (role) => {
            const response = await request(appAs(role))
                .post(`/${INVOICE_ID}/payments/${PAYMENT_ID}/void`);

            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({
                ok: true,
                data: { idempotent: false, payment: { status: 'voided' } },
            });
            expect(mockVoidPayment).toHaveBeenCalledWith(
                COMPANY_ID,
                CRM_USER_ID,
                INVOICE_ID,
                PAYMENT_ID
            );
            expect(mockVoidPayment.mock.calls[0]).not.toContain('keycloak-subject');
            expect(mockVoidPayment.mock.calls[0]).not.toContain(
                'LEGACY-COMPANY-MUST-NOT-BE-USED'
            );
        }
    );

    test('R-matrix deny: dispatcher gets 403 and the mutation service is not called', async () => {
        const response = await request(appAs('dispatcher'))
            .post(`/${INVOICE_ID}/payments/${PAYMENT_ID}/void`);

        expect(response.status).toBe(403);
        expect(mockVoidPayment).not.toHaveBeenCalled();
    });

    test('passes only crmUser.id; a missing CRM actor becomes the service 401', async () => {
        const actorError = Object.assign(
            new Error('A CRM user is required to void an invoice payment.'),
            { code: 'CRM_ACTOR_REQUIRED', httpStatus: 401 }
        );
        mockVoidPayment.mockRejectedValueOnce(actorError);

        const response = await request(
            appAs('tenant_admin', { includeCrmUser: false })
        ).post(`/${INVOICE_ID}/payments/${PAYMENT_ID}/void`);

        expect(response.status).toBe(401);
        expect(mockVoidPayment).toHaveBeenCalledWith(
            COMPANY_ID,
            null,
            INVOICE_ID,
            PAYMENT_ID
        );
        expect(mockVoidPayment.mock.calls[0]).not.toContain('keycloak-subject');
    });

    test.each([
        ['EXTERNAL_PAYMENT_NOT_VOIDABLE', 409],
        ['NOT_FOUND', 404],
    ])('maps %s service failures to HTTP %i', async (code, status) => {
        mockVoidPayment.mockRejectedValueOnce(
            Object.assign(new Error(code), { code, httpStatus: status })
        );

        const response = await request(appAs('tenant_admin'))
            .post(`/${INVOICE_ID}/payments/${PAYMENT_ID}/void`);

        expect(response.status).toBe(status);
        expect(response.body).toEqual({
            ok: false,
            error: { code, message: code },
        });
    });
});
