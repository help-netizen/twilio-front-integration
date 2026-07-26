'use strict';

const mockGetTransactionReceiptView = jest.fn();
const mockEmailTransactionReceipt = jest.fn();

jest.mock('../backend/src/services/paymentsService', () => ({
    getTransactionReceiptView: mockGetTransactionReceiptView,
    emailTransactionReceipt: mockEmailTransactionReceipt,
}));
jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../backend/src/services/transactionService', () => ({
    withTransaction: jest.fn(work => work(null)),
}));
jest.mock('../backend/src/services/financialActivityService', () => ({
    userActor: jest.fn(id => ({
        id: id || null, type: 'user', label: null, source: 'crm',
    })),
}));

const paymentsRouter = require('../backend/src/routes/payments');

const COMPANY_A = '00000000-0000-0000-0000-0000000000aa';
const COMPANY_B = '00000000-0000-0000-0000-0000000000bb';
const CRM_USER_ID = '22222222-2222-4222-8222-222222222222';

const viewRoute = paymentsRouter.stack.find(
    layer => layer.route?.path === '/:id/receipt/view'
).route;
const emailRoute = paymentsRouter.stack.find(
    layer => layer.route?.path === '/:id/receipt/email'
).route;

async function dispatch(route, {
    method,
    company = COMPANY_A,
    permissions = [],
    email,
} = {}) {
    const req = {
        method,
        originalUrl: `/api/payments/71/receipt/${method === 'GET' ? 'view' : 'email'}`,
        params: { id: '71' },
        body: email === undefined ? {} : { email },
        ip: '127.0.0.1',
        companyFilter: { company_id: company },
        companyId: 'LEGACY-DO-NOT-USE',
        authz: {
            scope: 'tenant',
            company: { id: company },
            permissions,
        },
        user: {
            sub: 'keycloak-sub',
            name: 'Agent Smith',
            email: 'agent@example.com',
            crmUser: { id: CRM_USER_ID },
        },
    };
    const res = {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };

    for (const layer of route.stack) {
        let nextCalled = false;
        let nextError;
        await Promise.resolve(layer.handle(req, res, (err) => {
            nextCalled = true;
            nextError = err;
        }));
        if (nextError) throw nextError;
        if (!nextCalled) break;
    }
    return { status: res.statusCode, body: res.body };
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('GET /api/payments/:id/receipt/view', () => {
    test('uses payments.view and the companyFilter tenant', async () => {
        const data = {
            receipt_type: 'stripe',
            receipt_url: 'https://pay.stripe.com/receipts/one',
            receipt: { transaction_id: 71 },
        };
        mockGetTransactionReceiptView.mockResolvedValue(data);

        const response = await dispatch(viewRoute, {
            method: 'GET',
            permissions: ['payments.view'],
        });

        expect(response).toEqual({ status: 200, body: { ok: true, data } });
        expect(mockGetTransactionReceiptView).toHaveBeenCalledWith(COMPANY_A, '71');
        expect(mockGetTransactionReceiptView.mock.calls[0][0]).not.toBe('LEGACY-DO-NOT-USE');
    });

    test('returns 403 without payments.view', async () => {
        const response = await dispatch(viewRoute, {
            method: 'GET',
            permissions: ['payments.collect_online'],
        });

        expect(response.status).toBe(403);
        expect(response.body.code).toBe('ACCESS_DENIED');
        expect(mockGetTransactionReceiptView).not.toHaveBeenCalled();
    });

    test('preserves a foreign-company lookup as 404', async () => {
        const error = Object.assign(new Error('Transaction 71 not found'), {
            code: 'NOT_FOUND',
            httpStatus: 404,
        });
        mockGetTransactionReceiptView.mockRejectedValue(error);

        const response = await dispatch(viewRoute, {
            method: 'GET',
            company: COMPANY_B,
            permissions: ['payments.view'],
        });

        expect(response).toEqual({
            status: 404,
            body: {
                ok: false,
                error: { code: 'NOT_FOUND', message: 'Transaction 71 not found' },
            },
        });
        expect(mockGetTransactionReceiptView).toHaveBeenCalledWith(COMPANY_B, '71');
    });
});

describe('POST /api/payments/:id/receipt/email', () => {
    test.each([
        'payments.collect_online',
        'payments.collect_offline',
        'payments.collect_keyed',
        'payments.collect_terminal',
    ])('accepts existing collection permission %s', async permission => {
        const data = {
            sent: true,
            delivery: 'stripe',
            receipt_url: 'https://pay.stripe.com/receipts/one',
            contact_email_saved: false,
        };
        mockEmailTransactionReceipt.mockResolvedValue(data);

        const response = await dispatch(emailRoute, {
            method: 'POST',
            permissions: [permission],
            email: 'customer@example.com',
        });

        expect(response).toEqual({ status: 200, body: { ok: true, data } });
        expect(mockEmailTransactionReceipt).toHaveBeenCalledWith(
            COMPANY_A,
            '71',
            'customer@example.com',
            {
                id: CRM_USER_ID,
                name: 'Agent',
                email: 'agent@example.com',
            },
            null,
            {
                id: CRM_USER_ID,
                type: 'user',
                label: null,
                source: 'crm',
            }
        );
    });

    test('returns 403 without a payment collection permission', async () => {
        const response = await dispatch(emailRoute, {
            method: 'POST',
            permissions: ['payments.view'],
        });

        expect(response.status).toBe(403);
        expect(response.body.code).toBe('ACCESS_DENIED');
        expect(mockEmailTransactionReceipt).not.toHaveBeenCalled();
    });

    test('passes the active company into the email service so foreign ids stay 404', async () => {
        const error = Object.assign(new Error('Transaction 71 not found'), {
            code: 'NOT_FOUND',
            httpStatus: 404,
        });
        mockEmailTransactionReceipt.mockRejectedValue(error);

        const response = await dispatch(emailRoute, {
            method: 'POST',
            company: COMPANY_B,
            permissions: ['payments.collect_online'],
        });

        expect(response.status).toBe(404);
        expect(mockEmailTransactionReceipt).toHaveBeenCalledWith(
            COMPANY_B,
            '71',
            undefined,
            expect.objectContaining({ id: CRM_USER_ID }),
            null,
            {
                id: CRM_USER_ID,
                type: 'user',
                label: null,
                source: 'crm',
            }
        );
    });
});
