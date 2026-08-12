jest.mock('../backend/src/db/connection', () => ({
    query: jest.fn(),
}));

const mockLogFinancialActivity = jest.fn();
jest.mock('../backend/src/services/financialActivityService', () => ({
    logFinancialActivity: (...args) => mockLogFinancialActivity(...args),
}));

const db = require('../backend/src/db/connection');
const paymentsService = require('../backend/src/services/paymentLedgerService');

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

        expect(countSql).toContain('p.is_check IS TRUE');
        expect(countSql).toContain('p.check_deposited IS NOT TRUE');
        expect(countSql).toContain("t.payment_method IN ('check', 'zb_check')");
        expect(rowsSql).toContain('check_deposited IS NOT TRUE');
        expect(rowsSql).toContain('LIMIT $4');
        expect(rowsSql).not.toContain('OFFSET');
        expect(countParams).toEqual(['company-1', '2026-05-01', '2026-06-14']);
        expect(rowsParams).toEqual(['company-1', '2026-05-01', '2026-06-14', 1001]);
    });
});

describe('zenbookerPaymentsSyncService check deposit activity', () => {
    const client = { query: jest.fn() };
    const actor = {
        id: '22222222-2222-4222-8222-222222222222',
        type: 'user',
        label: null,
        source: 'crm',
    };

    beforeEach(() => {
        jest.clearAllMocks();
        mockLogFinancialActivity.mockResolvedValue({ ok: true });
    });

    test.each([
        [true, 'payment.check_deposited', 'deposited'],
        [false, 'payment.check_deposit_reopened', 'not_deposited'],
    ])('logs the coalesced check action for deposited=%s', async (deposited, action, status) => {
        client.query.mockResolvedValue({
            rows: [{
                check_deposited: deposited,
                id: 81,
                job_id: 42,
                contact_id: 5,
                invoice_id: null,
                estimate_id: null,
            }],
        });

        await expect(paymentsService.updateCheckDeposited(
            'company-1',
            7,
            deposited,
            client,
            actor
        )).resolves.toEqual({ check_deposited: deposited });

        expect(client.query.mock.calls[0][0]).toContain(
            'WHERE company_id = $1 AND id = $2'
        );
        expect(client.query.mock.calls[0][0]).toContain('UPDATE payment_transactions');
        expect(client.query.mock.calls[0][0]).toContain("'{check_deposited}'");
        expect(client.query.mock.calls[0][0]).toContain("- 'pay_ledger_unify_001_check_deposited_backfill'");
        expect(client.query.mock.calls[0][0]).not.toContain('UPDATE zb_payments');
        expect(mockLogFinancialActivity).toHaveBeenCalledWith({
            companyId: 'company-1',
            entityType: 'payment',
            action,
            entity: {
                id: 81,
                job_id: 42,
                contact_id: 5,
                invoice_id: null,
                estimate_id: null,
            },
            actor,
            summary: { status },
        }, { client });
    });
});
