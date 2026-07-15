/**
 * JOB-RECORD-PAYMENT-001 — offline job-payment route and payment-date threading.
 */

const express = require('express');
const request = require('supertest');

const mockGetJobById = jest.fn();
jest.mock('../backend/src/services/jobsService', () => ({
    getJobById: mockGetJobById,
}));

const mockRecordManualPayment = jest.fn();
class MockPaymentsServiceError extends Error {
    constructor(code, message, httpStatus = 500) {
        super(message);
        this.code = code;
        this.httpStatus = httpStatus;
    }
}
jest.mock('../backend/src/services/paymentsService', () => ({
    PaymentsServiceError: MockPaymentsServiceError,
    recordManualPayment: mockRecordManualPayment,
}));

// Cheap require-time stubs for unrelated jobs-router dependencies.
jest.mock('../backend/src/services/zenbookerClient', () => ({}));
jest.mock('../backend/src/services/noteAttachmentsService', () => ({
    MAX_FILE_SIZE: 1,
    MAX_FILES_PER_NOTE: 1,
}));
jest.mock('../backend/src/services/notesMutationService', () => ({}));
jest.mock('../backend/src/services/eventService', () => ({
    logEvent: jest.fn(),
    actorName: jest.fn(),
    getEntityHistory: jest.fn(),
}));
jest.mock('../backend/src/services/conversationsService', () => ({}));
jest.mock('../backend/src/services/routeDistanceService', () => ({}));
jest.mock('../backend/src/services/googlePlacesService', () => ({}));
jest.mock('../backend/src/services/emailService', () => ({}));
jest.mock('../backend/src/services/rateMeService', () => ({
    RateMeServiceError: class extends Error {},
}));
jest.mock('../backend/src/db/companyQueries', () => ({}));
jest.mock('../backend/src/db/rateMeQueries', () => ({}));
jest.mock('../backend/src/services/messagingHelper', () => ({
    resolveCompanyProxyE164: jest.fn(),
}));
jest.mock('../backend/src/middleware/providerScope', () => ({
    getProviderScope: () => null,
}));
jest.mock('../backend/src/services/stripePaymentsService', () => ({
    StripePaymentsError: class extends Error {},
}));
jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn(() => Promise.resolve()),
}));

const jobsRouter = require('../backend/src/routes/jobs');

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const CREATED_TRANSACTION = {
    id: 'pay-1',
    company_id: COMPANY_ID,
    job_id: '41',
    invoice_id: null,
    transaction_type: 'payment',
    status: 'completed',
    payment_method: 'cash',
    amount: 125.5,
    reference_number: 'CASH-17',
    memo: 'Deposit',
    processed_at: '2026-07-10',
    recorded_by: 'crm-user-7',
};

function routeApp({
    permissions = ['payments.collect_offline'],
    includeCrmUser = true,
} = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'keycloak-sub', email: 'user@example.com' };
        if (includeCrmUser) req.user.crmUser = { id: 'crm-user-7' };
        req.authz = { scope: 'tenant', permissions, scopes: {} };
        req.companyFilter = { company_id: COMPANY_ID };
        req.companyId = 'LEGACY-DO-NOT-USE';
        next();
    });
    app.use('/', jobsRouter);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetJobById.mockResolvedValue({ id: 41, company_id: COMPANY_ID });
    mockRecordManualPayment.mockResolvedValue({ ...CREATED_TRANSACTION });
});

describe('POST /api/jobs/:id/record-payment', () => {
    test('TC-RP-1: records valid cash against the tenant-scoped job', async () => {
        const response = await request(routeApp())
            .post('/41/record-payment')
            .send({
                amount: 125.5,
                payment_method: 'cash',
                reference_number: 'CASH-17',
                payment_date: '2026-07-10',
                memo: 'Deposit',
            });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ ok: true, data: CREATED_TRANSACTION });
        expect(mockGetJobById).toHaveBeenCalledWith('41', COMPANY_ID);
        expect(mockRecordManualPayment).toHaveBeenCalledWith(COMPANY_ID, 'crm-user-7', {
            job_id: '41',
            amount: 125.5,
            payment_method: 'cash',
            reference_number: 'CASH-17',
            memo: 'Deposit',
            processed_at: '2026-07-10',
        });
        expect(mockRecordManualPayment.mock.calls[0][2].invoice_id).toBeUndefined();
    });

    test('TC-RP-2: a foreign or absent job returns 404 without a ledger write', async () => {
        mockGetJobById.mockResolvedValue(null);

        const response = await request(routeApp())
            .post('/41/record-payment')
            .send({ amount: 10, payment_method: 'cash' });

        expect(response.status).toBe(404);
        expect(response.body).toEqual({
            ok: false,
            error: { code: 'NOT_FOUND', message: 'Job not found' },
        });
        expect(mockGetJobById).toHaveBeenCalledWith('41', COMPANY_ID);
        expect(mockRecordManualPayment).not.toHaveBeenCalled();
    });

    test.each([0, -1])(
        'TC-RP-3: amount %p is rejected without a ledger write',
        async (amount) => {
            const response = await request(routeApp())
                .post('/41/record-payment')
                .send({ amount, payment_method: 'cash' });

            expect(response.status).toBe(400);
            expect(response.body.error.code).toBe('VALIDATION');
            expect(mockRecordManualPayment).not.toHaveBeenCalled();
        }
    );

    test.each(['credit_card', 'other', undefined])(
        'TC-RP-3: payment method %p is rejected without a ledger write',
        async (paymentMethod) => {
            const response = await request(routeApp())
                .post('/41/record-payment')
                .send({ amount: 10, payment_method: paymentMethod });

            expect(response.status).toBe(400);
            expect(response.body.error.code).toBe('VALIDATION');
            expect(mockRecordManualPayment).not.toHaveBeenCalled();
        }
    );

    test('TC-RP-4: uses crmUser.id, or null when crmUser is absent, never the Keycloak sub', async () => {
        const withCrmUser = await request(routeApp())
            .post('/41/record-payment')
            .send({ amount: 10, payment_method: 'check' });

        expect(withCrmUser.status).toBe(200);
        expect(mockRecordManualPayment.mock.calls[0][1]).toBe('crm-user-7');
        expect(mockRecordManualPayment.mock.calls[0][1]).not.toBe('keycloak-sub');

        mockRecordManualPayment.mockClear();
        const withoutCrmUser = await request(routeApp({ includeCrmUser: false }))
            .post('/41/record-payment')
            .send({ amount: 10, payment_method: 'check' });

        expect(withoutCrmUser.status).toBe(200);
        expect(mockRecordManualPayment).toHaveBeenCalledWith(
            COMPANY_ID,
            null,
            expect.objectContaining({ job_id: '41', payment_method: 'check' })
        );
        expect(mockRecordManualPayment.mock.calls[0][1]).not.toBe('keycloak-sub');
    });

    test('TC-RP-5: honors payment_date and passes undefined when it is absent', async () => {
        const withPaymentDate = await request(routeApp())
            .post('/41/record-payment')
            .send({ amount: 10, payment_method: 'cash', payment_date: '2026-07-11' });

        expect(withPaymentDate.status).toBe(200);
        expect(mockRecordManualPayment.mock.calls[0][2].processed_at).toBe('2026-07-11');

        mockRecordManualPayment.mockClear();
        const withoutPaymentDate = await request(routeApp())
            .post('/41/record-payment')
            .send({ amount: 10, payment_method: 'cash' });

        expect(withoutPaymentDate.status).toBe(200);
        expect(mockRecordManualPayment.mock.calls[0][2].processed_at).toBeUndefined();
    });

    test('TC-RP-8: missing payments.collect_offline returns 403', async () => {
        const response = await request(routeApp({ permissions: [] }))
            .post('/41/record-payment')
            .send({ amount: 10, payment_method: 'cash' });

        expect(response.status).toBe(403);
        expect(mockGetJobById).not.toHaveBeenCalled();
        expect(mockRecordManualPayment).not.toHaveBeenCalled();
    });
});
