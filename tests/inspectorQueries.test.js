'use strict';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/db/jobFinanceQueries', () => ({
    listJobPaymentRollups: jest.fn(),
}));

const db = require('../backend/src/db/connection');
const jobFinanceQueries = require('../backend/src/db/jobFinanceQueries');
const queries = require('../backend/src/db/inspectorQueries');

const COMPANY = '11111111-1111-1111-1111-111111111111';
const BOUNDARY = new Date('2026-07-20T04:00:00.000Z');

describe('Inspector dedicated data layer', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('SAB-INSP-ELIG-IGNORE + SAB-INSP-ELIG-FUTURE: Job candidates bind local boundary, ignores, company, dedup, and review', async () => {
        db.query.mockResolvedValue({ rows: [] });
        await queries.listCandidateJobs(
            COMPANY,
            BOUNDARY,
            ['Canceled'],
            '2026-07-20',
            { afterId: 7, limit: 25 }
        );
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('j.company_id = $1');
        expect(sql).toContain('j.start_date < $2::TIMESTAMPTZ');
        expect(sql).toContain('NOT (j.blanc_status = ANY($3::TEXT[]))');
        expect(sql).toContain('task.company_id = j.company_id');
        expect(sql).toContain("task.agent_type = 'inspector'");
        expect(sql).toContain('review.company_id = j.company_id');
        expect(params).toEqual([COMPANY, BOUNDARY, ['Canceled'], '2026-07-20', 7, 25]);
    });

    test('Lead candidates use updated_at proxy and preserve the same tenant/dedup contract', async () => {
        db.query.mockResolvedValue({ rows: [] });
        await queries.listCandidateLeads(COMPANY, BOUNDARY, ['Lost'], '2026-07-20');
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('l.company_id = $1');
        expect(sql).toContain('l.updated_at < $2::TIMESTAMPTZ');
        expect(sql).toContain('NOT (l.status = ANY($3::TEXT[]))');
        expect(sql).toContain('task.company_id = l.company_id');
        expect(params.slice(0, 4)).toEqual([COMPANY, BOUNDARY, ['Lost'], '2026-07-20']);
    });

    test('SAB-INSP-T-BLAST: recent communications pair contact/natural keys with company on every tenant join', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });
        await queries.getRecentCommunications(COMPANY, {
            contact_id: 9,
            contact_phone: '+15555550100',
            customer_phone: '+15555550100',
        });
        const callsSql = db.query.mock.calls[0][0];
        const smsSql = db.query.mock.calls[1][0];
        const emailSql = db.query.mock.calls[2][0];
        expect(callsSql).toContain('call.company_id = $1');
        expect(callsSql).toContain('call.contact_id = $2');
        expect(callsSql).toContain('item.company_id = call.company_id');
        expect(callsSql).toContain('item.call_sid = call.call_sid');
        expect(smsSql).toContain('conversation.company_id = $1');
        expect(smsSql).toContain('message.company_id = conversation.company_id');
        expect(smsSql).toContain('conversation.customer_e164 = ANY($2::TEXT[])');
        expect(emailSql).toContain('message.company_id = $1');
        expect(emailSql).toContain('message.contact_id = $2');
        expect(db.query.mock.calls[1][1]).toEqual([COMPANY, ['+15555550100']]);
    });

    test('SAB-INSP-ESTIMATE-NO-DOUBLE-COUNT: latest actionable estimate + counts do not sum revisions', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{
                count: 2,
                statuses: { draft: 1, sent: 1 },
                latest_actionable: { id: 2, total: '200.00', status: 'sent' },
            }] })
            .mockResolvedValueOnce({ rows: [{
                count: 1, total_invoiced: '100.00', invoice_paid: '20.00', invoice_due: '80.00',
            }] });
        jobFinanceQueries.listJobPaymentRollups.mockResolvedValue([
            { job_id: 5, total_paid: '30.00', total_due: '70.00' },
        ]);
        const result = await queries.getFinanceSummary(COMPANY, 'job', 5);
        const estimateSql = db.query.mock.calls[0][0];
        expect(estimateSql).toContain('estimate.company_id = $1');
        expect(estimateSql).toContain('estimate.job_id = $2');
        expect(estimateSql).toContain('estimate.archived_at IS NULL');
        expect(estimateSql).toContain('status <> ALL($3::TEXT[])');
        expect(estimateSql).not.toMatch(/SUM\s*\(\s*(?:estimate\.)?total/i);
        expect(result).toMatchObject({ amount_paid: '30.00', balance_due: '70.00' });
        expect(jobFinanceQueries.listJobPaymentRollups).toHaveBeenCalledWith(COMPANY, [5], null);
    });

    test('every tenant operation rejects a missing companyId before querying', async () => {
        await expect(queries.getSettings(null)).rejects.toMatchObject({ code: 'COMPANY_ID_REQUIRED' });
        await expect(queries.getEntityContext(null, 'job', 1)).rejects.toMatchObject({ code: 'COMPANY_ID_REQUIRED' });
        await expect(queries.getOpenInspectorTask(null, 'job', 1)).rejects.toMatchObject({ code: 'COMPANY_ID_REQUIRED' });
        expect(db.query).not.toHaveBeenCalled();
    });
});
