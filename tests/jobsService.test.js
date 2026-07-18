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

describe('jobsService.addNote company scope', () => {
    beforeEach(() => {
        db.query.mockReset();
    });

    it('qualifies both the job read and note update when companyId is supplied', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 705, notes: [], company_id: 'company-uuid-001' }] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });

        const result = await jobsService.addNote(
            705,
            'Invoice #100 sent to customer@example.com',
            [],
            'Agent',
            'crm-user-id',
            null,
            'company-uuid-001',
        );

        expect(db.query.mock.calls[0][0]).toContain('WHERE j.id = $1 AND j.company_id = $2');
        expect(db.query.mock.calls[0][1]).toEqual([705, 'company-uuid-001']);
        expect(db.query.mock.calls[2][0]).toContain('WHERE id = $2 AND company_id = $3');
        expect(db.query.mock.calls[2][1][1]).toBe(705);
        expect(db.query.mock.calls[2][1][2]).toBe('company-uuid-001');
        expect(result.notes[0]).toMatchObject({
            text: 'Invoice #100 sent to customer@example.com',
            author: 'Agent',
            created_by: 'crm-user-id',
        });
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

// ---------------------------------------------------------------------------
// listJobs — signed local-finance rollup for the Jobs mobile tile/list.
// ---------------------------------------------------------------------------
describe('jobsService.listJobs signed payment rollup', () => {
    const CO = 'company-uuid-001';
    const jobRow = {
        id: 7,
        company_id: CO,
        assigned_techs: [],
        assigned_provider_user_ids: [],
        notes: [],
        metadata: {},
        start_date: null,
        end_date: null,
        created_at: null,
        updated_at: null,
    };

    function primeList(paymentRows) {
        db.query
            .mockResolvedValueOnce({ rows: [{ total: '1' }] })
            .mockResolvedValueOnce({ rows: [jobRow] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: paymentRows });
    }

    beforeEach(() => {
        db.query.mockReset();
    });

    it('CTRL-DUE-SIGNED: no invoice + completed standalone $95 returns paid 95 and due -95', async () => {
        primeList([{ job_id: 7, total_paid: '95.00', total_due: '-95.00' }]);

        const result = await jobsService.listJobs({ companyId: CO });

        expect(result.results).toHaveLength(1);
        expect(result.results[0]).toMatchObject({
            id: 7,
            amount_paid: '95.00',
            balance_due: '-95.00',
        });

        const [sql, params] = db.query.mock.calls[3];
        expect(params).toEqual([[7], CO]);
        expect(sql).toContain('i.company_id = $2');
        expect(sql).toContain('pt.company_id = $2');
        expect(sql).toContain('pt.invoice_id IS NULL');
        expect(sql).toContain("pt.transaction_type = 'payment'");
        expect(sql).toContain("pt.status = 'completed'");
        expect(sql).toContain('COALESCE(ir.invoice_paid, 0) + COALESCE(sr.standalone_paid, 0)');
        expect(sql).toContain('COALESCE(ir.invoice_due, 0) - COALESCE(sr.standalone_paid, 0)');
    });

    it('keeps amount_paid and balance_due null when no local invoice or standalone payment exists', async () => {
        primeList([]);

        const result = await jobsService.listJobs({ companyId: CO });

        expect(result.results[0]).toMatchObject({ amount_paid: null, balance_due: null });
    });

    it('maps the combined invoice + standalone rollup without a second calculation', async () => {
        primeList([{ job_id: 7, total_paid: '70.00', total_due: '30.00' }]);

        const result = await jobsService.listJobs({ companyId: CO });

        expect(result.results[0]).toMatchObject({ amount_paid: '70.00', balance_due: '30.00' });
        expect(db.query).toHaveBeenCalledTimes(4);
    });
});
