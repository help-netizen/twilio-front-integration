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
        db.query.mockResolvedValue({
            rows: [{ job_id: 8, total_paid: '95.00', total_due: '-95.00' }],
        });
        const rows = await finance.listJobPaymentRollups(COMPANY, [8]);
        expect(rows[0]).toEqual({ job_id: 8, total_paid: '95.00', total_due: '-95.00' });
        const [sql, params] = db.query.mock.calls[0];
        expect(params).toEqual([[8], COMPANY]);
        expect(sql).toContain('i.company_id = $2');
        expect(sql).toContain('pt.company_id = $2');
        expect(sql).toContain('pt.invoice_id IS NULL');
        expect(sql).toContain("pt.transaction_type = 'payment'");
        expect(sql).toContain("pt.status = 'completed'");
        expect(sql).toContain("pt.external_source IS DISTINCT FROM 'zenbooker'");
        expect(sql).toContain('COALESCE(ir.invoice_due, 0) - COALESCE(sr.standalone_due_offset, 0)');
        expect(sql).toContain('ir.company_id = jwm.company_id');
        expect(sql).toContain('sr.company_id = jwm.company_id');
        expect(sql).toContain('WHERE jwm.company_id = $2');

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
