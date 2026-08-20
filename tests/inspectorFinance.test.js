'use strict';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const db = require('../backend/src/db/connection');
const finance = require('../backend/src/db/jobFinanceQueries');

const COMPANY = '11111111-1111-1111-1111-111111111111';

describe('canonical Job finance rollup', () => {
    beforeEach(() => jest.clearAllMocks());

    test('normalizes every public field from one company-scoped SQL projection', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                job_id: '8',
                estimated: '250.00',
                invoiced: '100.00',
                paid: '100.00',
                due: '0.00',
                tips: '15.00',
                unapplied_credit: '100.00',
            }],
        });

        await expect(finance.getJobFinance(COMPANY, 8)).resolves.toEqual({
            job_id: '8',
            estimated: 250,
            invoiced: 100,
            paid: 100,
            due: 0,
            tips: 15,
            unapplied_credit: 100,
        });
        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql, params] = db.query.mock.calls[0];
        expect(params).toEqual([COMPANY, [8], false]);
        expect(sql).toContain('estimate.company_id = $1');
        expect(sql).toContain('estimate.archived_at IS NULL');
        expect(sql).toContain("estimate.status <> 'declined'");
        expect(sql).toContain('invoice.company_id = $1');
        expect(sql).toContain("invoice.status NOT IN ('void', 'voided', 'refunded')");
        expect(sql).toContain('payment.company_id = $1');
        expect(sql).toContain('AS unapplied_credit');
    });

    test('missing company rejects and empty ids avoid SQL', async () => {
        await expect(finance.listJobFinances(null, [8]))
            .rejects.toMatchObject({ code: 'COMPANY_ID_REQUIRED' });
        await expect(finance.listJobFinances(COMPANY, [])).resolves.toEqual([]);
        expect(db.query).not.toHaveBeenCalled();
    });

    test('positive-Due selection is a mode of the same projection', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        await finance.listJobFinances(COMPANY, null, null, { positiveDueOnly: true });
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('WHERE ($3::BOOLEAN = FALSE OR due > 0)'),
            [COMPANY, null, true]
        );
    });
});
