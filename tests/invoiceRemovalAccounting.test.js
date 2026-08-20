'use strict';

jest.mock('../backend/src/db/invoiceRemovalQueries', () => ({}));
jest.mock('../backend/src/db/invoicesQueries', () => ({}));
jest.mock('../backend/src/db/documentPaymentQueries', () => ({
    applyInvoiceAllocations: jest.fn(),
}));
jest.mock('../backend/src/services/financialActivityService', () => ({
    logFinancialActivity: jest.fn(),
}));

const {
    summarizeTransactions,
    transactionDocumentCents,
} = require('../backend/src/services/invoiceRemovalService');

function payment(overrides = {}) {
    return {
        id: 1,
        transaction_type: 'payment',
        status: 'completed',
        amount: '100.00',
        currency: 'USD',
        metadata: {},
        voided_at: null,
        ...overrides,
    };
}

describe('invoice removal payment accounting', () => {
    it('keeps tips outside Paid', () => {
        const transactions = [payment({ amount: '115.00', metadata: { tip: 15 } })];

        expect(transactionDocumentCents(transactions[0])).toBe(10000);
        expect(summarizeTransactions(transactions, 'USD')).toMatchObject({
            detachedAmount: 100,
            paymentCount: 1,
            transactionCount: 1,
        });
    });

    it('nets completed refunds and gives voided payments zero effect', () => {
        const original = payment({ id: 11, amount: '100.00', status: 'refunded' });
        const refund = {
            id: 12,
            transaction_type: 'refund',
            status: 'completed',
            amount: '-30.00',
            currency: 'USD',
            metadata: { original_transaction_id: 11 },
            original_amount: '100.00',
            original_metadata: {},
            voided_at: null,
        };
        const voided = payment({ id: 13, amount: '500.00', voided_at: new Date() });

        expect(summarizeTransactions([original, refund, voided], 'USD')).toMatchObject({
            detachedAmount: 70,
            paymentCount: 1,
            transactionCount: 3,
        });
    });

    it('rejects effective cross-currency application', () => {
        expect(() => summarizeTransactions([
            payment(),
            payment({ id: 2, amount: '20.00', currency: 'CAD' }),
        ], 'USD')).toThrow(expect.objectContaining({
            code: 'PAYMENT_CURRENCY_MISMATCH',
            httpStatus: 409,
        }));
    });
});
