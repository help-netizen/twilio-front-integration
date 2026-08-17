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
