jest.mock('../backend/src/db/connection', () => ({
    query: jest.fn(),
}));

jest.mock('../backend/src/services/zenbookerClient', () => ({}));

const db = require('../backend/src/db/connection');
const paymentsService = require('../backend/src/services/zenbookerPaymentsSyncService');

describe('zenbookerPaymentsSyncService listPayments new checks filter', () => {
    beforeEach(() => {
        db.query.mockReset();
    });

    test('filters undeposited checks in SQL before applying limit', async () => {
        db.query
            .mockResolvedValueOnce({
                rows: [{
                    transaction_count: 1,
                    total_amount: '95.00',
                    payment_methods: ['check'],
                    providers: ['Russell'],
                    undeposited_check_count: 1,
                }],
            })
            .mockResolvedValueOnce({
                rows: [{
                    id: 1,
                    transaction_id: 'txn_730302',
                    invoice_id: 'inv_730302',
                    job_id: 'job_730302',
                    job_number: '730302',
                    client: 'Kimberly Weydemeyer',
                    job_type: 'Repair',
                    status: 'complete',
                    payment_methods: 'check',
                    display_payment_method: 'check',
                    amount_paid: '95.00',
                    tags: '',
                    payment_date: '2026-05-12T17:39:00.000Z',
                    source: '',
                    tech: 'Russell',
                    transaction_status: 'succeeded',
                    missing_job_link: false,
                    invoice_status: 'paid',
                    invoice_total: '95.00',
                    invoice_amount_paid: '95.00',
                    invoice_amount_due: '0.00',
                    invoice_paid_in_full: true,
                    check_deposited: false,
                    custom_fields: '',
                }],
            });

        const result = await paymentsService.listPayments('company-1', {
            dateFrom: '2026-05-01',
            dateTo: '2026-06-14',
            quickFilter: 'new_checks',
            limit: 1000,
        });

        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].job_number).toBe('730302');

        const [countSql, countParams] = db.query.mock.calls[0];
        const [rowsSql, rowsParams] = db.query.mock.calls[1];

        expect(countSql).toContain('check_deposited IS NOT TRUE');
        expect(countSql).toContain('payment_methods ILIKE');
        expect(countSql).toContain('display_payment_method ILIKE');
        expect(rowsSql).toContain('check_deposited IS NOT TRUE');
        expect(rowsSql).toContain('LIMIT $5');
        expect(rowsSql).not.toContain('OFFSET');
        expect(countParams).toEqual(['company-1', '2026-05-01', '2026-06-14', '%check%']);
        expect(rowsParams).toEqual(['company-1', '2026-05-01', '2026-06-14', '%check%', 1001]);
    });
});
