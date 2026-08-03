'use strict';

const fs = require('fs');
const path = require('path');

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const db = require('../backend/src/db/connection');
const finance = require('../backend/src/db/jobFinanceQueries');

const COMPANY = '11111111-1111-1111-1111-111111111111';

describe('canonical Job finance rollup', () => {
    beforeEach(() => jest.clearAllMocks());

    test('SAB-INSP-JOB-FINANCE-PARITY: invoice and standalone formulas are one required-company helper', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({
                rows: [{ job_id: 8, native_pool: '95.00', total_pool: '95.00' }],
            });
        const rows = await finance.listJobPaymentRollups(COMPANY, [8]);
        expect(rows[0]).toEqual({ job_id: 8, total_paid: 95, total_due: -95 });
        expect(db.query).toHaveBeenCalledTimes(2);
        const [[invoiceSql, invoiceParams], [poolSql, poolParams]] = db.query.mock.calls;
        expect(invoiceParams).toEqual([COMPANY, [8]]);
        expect(poolParams).toEqual([COMPANY, [8]]);
        expect(invoiceSql).toContain('i.company_id = $1');
        expect(invoiceSql).toContain('i.job_id = ANY($2::BIGINT[])');
        expect(invoiceSql).toContain('ORDER BY created_at ASC, invoice_id ASC');
        expect(poolSql).toContain('pt.company_id = $1');
        expect(poolSql).toContain('pt.job_id = ANY($2::BIGINT[])');
        expect(poolSql).toContain("effective_source IS DISTINCT FROM 'zenbooker'");
        expect(poolSql).toContain('OR invoice_id IS NULL');

        const jobsSource = fs.readFileSync(
            path.join(__dirname, '../backend/src/services/jobsService.js'),
            'utf8'
        );
        expect(jobsSource).toContain('jobFinanceQueries.listJobPaymentRollups(companyId, jobIds)');
        expect(jobsSource.match(/WITH invoice_rollup AS/g) || []).toHaveLength(0);
    });

    test('missing company rejects and empty ids avoid SQL', async () => {
        await expect(finance.listJobPaymentRollups(null, [8]))
            .rejects.toMatchObject({ code: 'COMPANY_ID_REQUIRED' });
        await expect(finance.listJobPaymentRollups(COMPANY, [])).resolves.toEqual([]);
        expect(db.query).not.toHaveBeenCalled();
    });
});
