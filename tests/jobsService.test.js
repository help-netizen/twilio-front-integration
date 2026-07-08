jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/zenbookerClient', () => ({}));
jest.mock('../backend/src/services/fsmService', () => ({}));
jest.mock('../backend/src/services/eventService', () => ({}));

const db = require('../backend/src/db/connection');
const jobsService = require('../backend/src/services/jobsService');

describe('jobsService.getJobById', () => {
    beforeEach(() => {
        db.query.mockReset();
    });

    it('qualifies job id and company id when joining leads for lead serial id', async () => {
        db.query
            .mockResolvedValueOnce({
                rows: [{
                    id: 705,
                    lead_id: 389,
                    lead_serial_id: 53,
                    contact_id: 3346,
                    zenbooker_job_id: 'zb-job',
                    blanc_status: 'Submitted',
                    zb_status: 'scheduled',
                    zb_rescheduled: false,
                    zb_canceled: false,
                    job_number: '971346',
                    service_name: 'COD Service',
                    start_date: new Date('2026-04-21T17:00:00Z'),
                    end_date: new Date('2026-04-21T19:00:00Z'),
                    assigned_techs: [],
                    notes: [],
                    company_id: 'company-uuid-001',
                    created_at: new Date('2026-04-21T00:00:00Z'),
                    updated_at: new Date('2026-04-21T00:00:00Z'),
                }],
            })
            .mockResolvedValueOnce({ rows: [] });

        const job = await jobsService.getJobById(705, 'company-uuid-001');

        expect(db.query.mock.calls[0][0]).toContain('WHERE j.id = $1 AND j.company_id = $2');
        expect(job).toMatchObject({ id: 705, lead_serial_id: 53, job_number: '971346' });
    });
});

// ---------------------------------------------------------------------------
// getJobBalanceDue — company-scoped local-invoice rollup for the outbound
// "part arrived" voice agent (OUTBOUND-PARTS-CALL balance injection). Mirrors
// listJobs' payments exclusion (void/voided/refunded) and null-for-no-invoice.
// ---------------------------------------------------------------------------
describe('jobsService.getJobBalanceDue', () => {
    const CO = 'company-uuid-001';
    beforeEach(() => {
        db.query.mockReset();
    });

    it('sums the job invoices → numeric dollars, company-scoped query + params', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ total: '300.00', amount_paid: '100.00', balance_due: '200.00' }],
        });

        const out = await jobsService.getJobBalanceDue(50, CO);

        // pg NUMERIC strings coerced to Numbers.
        expect(out).toEqual({ balanceDue: 200, total: 300, amountPaid: 100 });
        // One company-scoped query, params [jobId, companyId].
        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('i.job_id = $1 AND i.company_id = $2');
        expect(params).toEqual([50, CO]);
    });

    it('excludes void/voided/refunded invoices (same exclusion set as listJobs)', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ total: '0', amount_paid: '0', balance_due: '0' }],
        });

        await jobsService.getJobBalanceDue(50, CO);

        const sql = db.query.mock.calls[0][0];
        expect(sql).toMatch(/NOT IN \('void','voided','refunded'\)/);
    });

    it('all invoices void → present-but-zero (NOT null — never invents null for existing invoices)', async () => {
        // A row IS returned (GROUP BY matched invoice rows), sums clamp to 0.
        db.query.mockResolvedValueOnce({
            rows: [{ total: '0', amount_paid: '0', balance_due: '0' }],
        });

        const out = await jobsService.getJobBalanceDue(50, CO);
        expect(out).toEqual({ balanceDue: 0, total: 0, amountPaid: 0 });
    });

    it('no local invoice (0 rows) → all null (never invents 0)', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const out = await jobsService.getJobBalanceDue(50, CO);
        expect(out).toEqual({ balanceDue: null, total: null, amountPaid: null });
    });

    it('missing companyId → null result AND no query issued (company scoping mandatory)', async () => {
        const out = await jobsService.getJobBalanceDue(50, null);
        expect(out).toEqual({ balanceDue: null, total: null, amountPaid: null });
        expect(db.query).not.toHaveBeenCalled();
    });
});
