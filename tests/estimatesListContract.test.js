'use strict';

const mockQuery = jest.fn();
const mockApplyEstimatePayments = jest.fn(async (_companyId, rows) => rows);

jest.mock('../backend/src/db/connection', () => ({
    query: (...args) => mockQuery(...args),
}));
jest.mock('../backend/src/db/documentPaymentQueries', () => ({
    applyEstimatePayments: (...args) => mockApplyEstimatePayments(...args),
}));

const estimatesQueries = require('../backend/src/db/estimatesQueries');

const COMPANY_ID = '00000000-0000-0000-0000-0000000000a1';

beforeEach(() => {
    jest.clearAllMocks();
});

describe('estimate list row contract', () => {
    test('returns row rendering fields plus stable viewed_at without line items or per-row detail fetches', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [{
                id: 42,
                company_id: COMPANY_ID,
                contact_name: 'Customer A',
                estimate_number: 'ESTIMATE L-53-2',
                summary: 'Replace the failed control board',
                total: '475.00',
                status: 'viewed',
                sent_at: '2026-08-12T14:00:00.000Z',
                viewed_at: '2026-08-13T15:30:00.000Z',
                _total: '1',
            }],
        });

        const result = await estimatesQueries.listEstimates(COMPANY_ID, {
            limit: 25,
            offset: 50,
        });

        expect(result).toEqual({
            total: 1,
            rows: [{
                id: 42,
                company_id: COMPANY_ID,
                contact_name: 'Customer A',
                estimate_number: 'ESTIMATE L-53-2',
                summary: 'Replace the failed control board',
                total: '475.00',
                status: 'viewed',
                sent_at: '2026-08-12T14:00:00.000Z',
                viewed_at: '2026-08-13T15:30:00.000Z',
            }],
        });
        expect(result.rows[0]).not.toHaveProperty('items');
        expect(mockQuery).toHaveBeenCalledTimes(1);

        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toContain('e.company_id = $1');
        expect(sql).toContain('viewed.viewed_at AS viewed_at');
        expect(sql).toMatch(/FROM estimate_events ee[\s\S]+event_owner\.company_id = e\.company_id/);
        expect(sql).toContain("ee.event_type = 'viewed'");
        expect(sql).toContain('ORDER BY ee.created_at ASC');
        expect(sql).not.toContain('estimate_items');
        expect(params).toEqual([COMPANY_ID, 25, 50]);
    });

    test('customer and recipient fields prefer the estimate contact over an unrelated job contact', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });

        await estimatesQueries.listEstimates(COMPANY_ID);

        const sql = mockQuery.mock.calls[0][0];
        expect(sql).toContain('ON c.id = COALESCE(e.contact_id, j.contact_id)');
        expect(sql).toContain('AND c.company_id = e.company_id');
        expect(sql).toContain("CASE WHEN e.contact_id IS NULL THEN NULLIF(j.customer_email, '') END");
        expect(sql).toContain("CASE WHEN e.contact_id IS NULL THEN NULLIF(j.customer_phone, '') END");
    });
});

describe('estimate detail job identifier contract', () => {
    test('returns job_seq and public_code from the company-scoped Job join', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [{
                id: 42,
                company_id: COMPANY_ID,
                job_id: 71,
                job_number: null,
                job_seq: 171,
                public_code: 'aB3xZ',
            }],
        });

        await expect(estimatesQueries.getEstimateById(COMPANY_ID, 42)).resolves.toMatchObject({
            job_id: 71,
            job_number: null,
            job_seq: 171,
            public_code: 'aB3xZ',
        });
        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toContain('j.job_seq AS job_seq');
        expect(sql).toContain('j.public_code AS public_code');
        expect(sql).toContain('j.company_id = e.company_id');
        expect(params).toEqual([42, COMPANY_ID]);
    });
});
