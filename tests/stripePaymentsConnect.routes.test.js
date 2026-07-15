/**
 * STRIPE-CONNECT-ERR-001 — admin Connect endpoint error diagnostics.
 */

const express = require('express');
const request = require('supertest');

const mockConnect = jest.fn();
const mockGetCompanyById = jest.fn();

jest.mock('../backend/src/services/stripePaymentsService', () => {
    class StripePaymentsError extends Error {
        constructor(code, message, httpStatus = 400) {
            super(message);
            this.name = 'StripePaymentsError';
            this.code = code;
            this.httpStatus = httpStatus;
        }
    }

    return {
        connect: mockConnect,
        StripePaymentsError,
    };
});

jest.mock('../backend/src/db/companyQueries', () => ({
    getCompanyById: mockGetCompanyById,
}));

const stripePaymentsService = require('../backend/src/services/stripePaymentsService');
const stripePaymentsRouter = require('../backend/src/routes/stripePayments');

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const REQUEST_ID = 'req-stripe-err';

function app() {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
        req.companyFilter = { company_id: COMPANY_ID };
        req.user = { crmUser: { id: '22222222-2222-4222-8222-222222222222' } };
        req.requestId = REQUEST_ID;
        next();
    });
    instance.use('/', stripePaymentsRouter);
    return instance;
}

let consoleError;

beforeEach(() => {
    jest.clearAllMocks();
    mockGetCompanyById.mockResolvedValue({ name: 'Test Company' });
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    consoleError.mockRestore();
});

describe('POST /connect error responses', () => {
    test('surfaces provider error details and status', async () => {
        const providerError = new Error('You can only create new accounts if you have signed up for Connect');
        providerError.stripeCode = 'account_invalid';
        providerError.httpStatus = 400;
        mockConnect.mockRejectedValue(providerError);

        const response = await request(app()).post('/connect').send({});

        expect(response.status).toBe(400);
        expect(response.body).toEqual({
            success: false,
            code: 'account_invalid',
            message: 'Stripe: You can only create new accounts if you have signed up for Connect',
            request_id: REQUEST_ID,
        });
        expect(response.body.message).not.toBe('Internal server error.');
        expect(consoleError).toHaveBeenCalledWith(
            '[StripePayments] /connect error:',
            expect.objectContaining({
                message: providerError.message,
                stripeCode: 'account_invalid',
                httpStatus: 400,
                stack: expect.any(String),
            })
        );
    });

    test('surfaces a plain internal error with a diagnostic code', async () => {
        const internalError = new Error('relation "x" does not exist');
        mockConnect.mockRejectedValue(internalError);

        const response = await request(app()).post('/connect').send({});

        expect(response.status).toBe(500);
        expect(response.body).toEqual({
            success: false,
            code: 'STRIPE_CONNECT_FAILED',
            message: 'relation "x" does not exist',
            request_id: REQUEST_ID,
        });
        expect(response.body.message).not.toBe('Internal server error.');
    });

    test('keeps StripePaymentsError status and envelope unchanged', async () => {
        mockConnect.mockRejectedValue(new stripePaymentsService.StripePaymentsError(
            'NOT_CONFIGURED',
            'Stripe is not configured',
            503
        ));

        const response = await request(app()).post('/connect').send({});

        expect(response.status).toBe(503);
        expect(response.body).toEqual({
            success: false,
            code: 'NOT_CONFIGURED',
            message: 'Stripe is not configured',
            request_id: REQUEST_ID,
        });
        expect(consoleError).not.toHaveBeenCalled();
    });
});
