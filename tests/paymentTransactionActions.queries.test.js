'use strict';

jest.mock('../backend/src/db/connection', () => ({
    query: jest.fn(),
}));

const db = require('../backend/src/db/connection');
const paymentsQueries = require('../backend/src/db/paymentsQueries');

const COMPANY = '00000000-0000-0000-0000-0000000000aa';

beforeEach(() => {
    jest.clearAllMocks();
});

describe('canonical transaction action projection', () => {
    test('new invoice payments retain their original invoice marker', async () => {
        db.query.mockResolvedValue({ rows: [{ id: 72, origin_invoice_id: 57 }] });

        await paymentsQueries.createTransaction(COMPANY, {
            invoice_id: 57,
            job_id: 9,
            transaction_type: 'payment',
            payment_method: 'cash',
            amount: 25,
        });

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('processed_at, recorded_by, origin_invoice_id');
        expect(params[17]).toBe(57);
    });

    test('refund rows inherit provenance after a payment was re-applied', async () => {
        db.query
            .mockResolvedValueOnce({
                rows: [{
                    id: 72,
                    invoice_id: 58,
                    origin_invoice_id: 57,
                    job_id: 9,
                    payment_method: 'cash',
                    currency: 'USD',
                }],
            })
            .mockResolvedValueOnce({ rows: [{ id: 73, origin_invoice_id: 57 }] })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 });

        await paymentsQueries.createRefundTransaction(COMPANY, 72, 10, null);

        const [sql, params] = db.query.mock.calls[1];
        expect(sql).toContain('origin_invoice_id');
        expect(params[13]).toBe(57);
    });

    test('list exposes Stripe dashboard metadata only for Stripe credit-card rows', async () => {
        db.query.mockResolvedValue({
            rows: [{
                id: 71,
                external_source: 'stripe',
                payment_method: 'credit_card',
                job_seq: 171,
                stripe_payment_id: 'ch_71',
                stripe_livemode: false,
                _total: '1',
            }],
        });

        const result = await paymentsQueries.listTransactions(COMPANY, {
            jobId: 9,
            limit: 100,
        });

        expect(result).toEqual({
            rows: [{
                id: 71,
                external_source: 'stripe',
                payment_method: 'credit_card',
                job_seq: 171,
                stripe_payment_id: 'ch_71',
                stripe_livemode: false,
            }],
            total: 1,
        });
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain("t.external_source = 'stripe' AND t.payment_method = 'credit_card'");
        expect(sql).toContain('END AS stripe_payment_id');
        expect(sql).toContain('END AS stripe_livemode');
        expect(sql).toContain('s.company_id = t.company_id');
        expect(sql).toContain('stripe_account.company_id = t.company_id');
        expect(sql).toContain('j.job_seq');
        expect(sql).toContain('j.company_id = t.company_id');
        expect(sql).toContain('t.company_id = $1');
        expect(params[0]).toBe(COMPANY);
    });

    test('receipt context anchors the transaction and every customer join to company', async () => {
        const context = { id: 71, company_id: COMPANY, customer_email: 'customer@example.com' };
        db.query.mockResolvedValue({ rows: [context] });

        await expect(
            paymentsQueries.getTransactionReceiptContext(COMPANY, 71)
        ).resolves.toEqual(context);

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('WHERE t.company_id = $1 AND t.id = $2');
        expect(sql).toContain('s.company_id = t.company_id');
        expect(sql).toContain('i.company_id = t.company_id');
        expect(sql).toContain('j.company_id = t.company_id');
        expect(sql).toContain('c.company_id = t.company_id');
        expect(params).toEqual([COMPANY, 71]);
    });
});
