jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/fsmService', () => ({}));
jest.mock('../backend/src/services/eventService', () => ({}));
jest.mock('../backend/src/db/jobFinanceQueries', () => ({
    getJobFinance: jest.fn(),
    listJobFinances: jest.fn(),
}));

const db = require('../backend/src/db/connection');
const jobFinanceQueries = require('../backend/src/db/jobFinanceQueries');
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

        const sql = db.query.mock.calls[0][0];
        expect(sql).toContain('WHERE j.id = $1 AND j.company_id = $2');
        expect(sql).toContain("COALESCE(NULLIF(c.phone_e164, ''), NULLIF(j.customer_phone, '')) AS customer_phone");
        expect(sql).toContain("COALESCE(NULLIF(c.email, ''), NULLIF(j.customer_email, '')) AS customer_email");
        expect(sql).toContain('LEFT JOIN contacts c ON c.id = j.contact_id AND c.company_id = j.company_id');
        expect(job).toMatchObject({ id: 705, lead_serial_id: 53, job_number: '971346' });
    });
});

describe('jobsService.getJobFinance API projection', () => {
    const CO = 'company-uuid-001';

    beforeEach(() => {
        db.query.mockReset();
        jobFinanceQueries.getJobFinance.mockReset();
    });

    it('authorizes the Job before returning the exact canonical public shape', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{
                id: 7,
                company_id: CO,
                assigned_techs: [],
                notes: [],
                metadata: {},
            }] })
            .mockResolvedValueOnce({ rows: [] });
        jobFinanceQueries.getJobFinance.mockResolvedValue({
            job_id: 7,
            estimated: 250,
            invoiced: 100,
            paid: 100,
            due: 0,
            tips: 15,
            unapplied_credit: 100,
        });

        await expect(jobsService.getJobFinance(7, CO)).resolves.toEqual({
            estimated: 250,
            invoiced: 100,
            paid: 100,
            due: 0,
            tips: 15,
            unapplied_credit: 100,
        });
        expect(db.query.mock.calls[0][0]).toContain('j.company_id = $2');
        expect(jobFinanceQueries.getJobFinance).toHaveBeenCalledWith(CO, 7);
    });

    it('T-foreign stops before the projector and returns 404-compatible null', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        await expect(jobsService.getJobFinance(7, CO)).resolves.toBeNull();
        expect(jobFinanceQueries.getJobFinance).not.toHaveBeenCalled();
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
// getJobBalanceDue — compatibility shape over the canonical projection.
// ---------------------------------------------------------------------------
describe('jobsService.getJobBalanceDue', () => {
    const CO = 'company-uuid-001';
    beforeEach(() => {
        db.query.mockReset();
        jobFinanceQueries.getJobFinance.mockReset();
    });

    it('maps the canonical projection without a second formula', async () => {
        jobFinanceQueries.getJobFinance.mockResolvedValue({
            job_id: 50,
            estimated: 250,
            invoiced: 100,
            paid: 100,
            due: 0,
            tips: 15,
            unapplied_credit: 100,
        });

        const out = await jobsService.getJobBalanceDue(50, CO);

        expect(out).toEqual({ balanceDue: 0, total: 100, amountPaid: 100 });
        expect(jobFinanceQueries.getJobFinance).toHaveBeenCalledWith(CO, 50);
        expect(db.query).not.toHaveBeenCalled();
    });

    it('missing tenant Job returns the legacy null shape', async () => {
        jobFinanceQueries.getJobFinance.mockResolvedValue(null);

        const out = await jobsService.getJobBalanceDue(50, CO);
        expect(out).toEqual({ balanceDue: null, total: null, amountPaid: null });
    });

    it('missing companyId → null result AND no query issued (company scoping mandatory)', async () => {
        const out = await jobsService.getJobBalanceDue(50, null);
        expect(out).toEqual({ balanceDue: null, total: null, amountPaid: null });
        expect(db.query).not.toHaveBeenCalled();
        expect(jobFinanceQueries.getJobFinance).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// listJobs — signed local-finance rollup for the Jobs mobile tile/list.
// ---------------------------------------------------------------------------
describe('jobsService.listJobs signed payment rollup', () => {
    const CO = 'company-uuid-001';
    const FINANCE = {
        job_id: 7,
        estimated: 250,
        invoiced: 100,
        paid: 100,
        due: 0,
        tips: 15,
        unapplied_credit: 100,
    };
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

    function primeList(finances = [FINANCE]) {
        db.query
            .mockResolvedValueOnce({ rows: [{ total: '1' }] })
            .mockResolvedValueOnce({ rows: [jobRow] })
            .mockResolvedValueOnce({ rows: [] });
        jobFinanceQueries.listJobFinances.mockResolvedValue(finances);
    }

    beforeEach(() => {
        db.query.mockReset();
        jobFinanceQueries.listJobFinances.mockReset();
    });

    it('maps the common canonical scenario without another money calculation', async () => {
        primeList();

        const result = await jobsService.listJobs({ companyId: CO });

        expect(result.results[0]).toMatchObject({
            id: 7,
            amount_paid: 100,
            balance_due: 0,
        });
        expect(jobFinanceQueries.listJobFinances).toHaveBeenCalledWith(CO, [7]);
        expect(db.query).toHaveBeenCalledTimes(3);
    });

    it('preserves signed Job Due supplied by the projector', async () => {
        primeList([{ ...FINANCE, paid: 145, due: -45, unapplied_credit: 145 }]);

        const result = await jobsService.listJobs({ companyId: CO });

        expect(result.results[0]).toMatchObject({
            amount_paid: 145,
            balance_due: -45,
        });
    });

    it('SAB-OB70-SECOND-FORMULA: Unpaid quick-filter consumes positive-Due ids from the projector', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ total: '1' }] })
            .mockResolvedValueOnce({ rows: [jobRow] })
            .mockResolvedValueOnce({ rows: [] });
        jobFinanceQueries.listJobFinances
            .mockResolvedValueOnce([{ ...FINANCE, due: 40 }])
            .mockResolvedValueOnce([FINANCE]);

        await jobsService.listJobs({ companyId: CO, paymentStatus: 'unpaid' });

        expect(jobFinanceQueries.listJobFinances).toHaveBeenNthCalledWith(
            1,
            CO,
            null,
            null,
            { positiveDueOnly: true }
        );
        const metadataSql = db.query.mock.calls[0][0];
        const metadataParams = db.query.mock.calls[0][1];
        expect(metadataSql).toContain('j.id = ANY($2::BIGINT[])');
        expect(metadataParams.slice(0, 2)).toEqual([CO, [7]]);
    });
});
