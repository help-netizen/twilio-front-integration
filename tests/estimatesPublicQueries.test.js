'use strict';

const COMPANY_ID = '00000000-0000-0000-0000-00000000000a';
const ESTIMATE_ID = 42;
const TOKEN = 'public_EST_42';

const mockDbQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({
    query: (...args) => mockDbQuery(...args),
}));
jest.mock('../backend/src/db/documentPaymentQueries', () => ({
    applyEstimatePayments: jest.fn(async (_companyId, rows) => rows),
}));

const queries = require('../backend/src/db/estimatesQueries');

beforeEach(() => {
    jest.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [] });
});

test('read tokens exclude archived estimates while leaving status unrestricted', async () => {
    await queries.getEstimateByPublicToken(TOKEN);

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toContain('e.public_token = $1');
    expect(sql).toContain('e.archived_at IS NULL');
    expect(sql).not.toContain("e.status = 'declined'");
    expect(params).toEqual([TOKEN]);
});

test('public action lookup row-locks only the statuses authorized for that action', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };

    await queries.lockEstimateByPublicToken(TOKEN, 'approve', client);
    await queries.lockEstimateByPublicToken(TOKEN, 'decline', client);

    const [approveSql, approveParams] = client.query.mock.calls[0];
    const [declineSql, declineParams] = client.query.mock.calls[1];
    for (const sql of [approveSql, declineSql]) {
        expect(sql).toContain('e.public_token = $1');
        expect(sql).toContain('e.archived_at IS NULL');
        expect(sql).toContain('e.status = ANY($2::text[])');
        expect(sql).toContain('FOR UPDATE OF e');
    }
    expect(approveParams).toEqual([TOKEN, ['sent', 'viewed', 'approved']]);
    expect(declineParams).toEqual([TOKEN, ['sent', 'viewed']]);
});

test('view transition is atomic, company-scoped, and can only advance sent to viewed once', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ estimate_id: ESTIMATE_ID }] });

    await expect(queries.markEstimateViewed(COMPANY_ID, ESTIMATE_ID)).resolves.toBe(true);

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toContain("SET status = 'viewed'");
    expect(sql).toContain('company_id = $1');
    expect(sql).toContain("status = 'sent'");
    expect(sql).toContain("SELECT id, 'viewed', 'client'");
    expect(params).toEqual([COMPANY_ID, ESTIMATE_ID]);
});

test('decline task context accepts only the active estimate author in the same company', async () => {
    await queries.getDeclineTaskContext(COMPANY_ID, ESTIMATE_ID);

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toContain('author.id = e.created_by');
    expect(sql).toContain('author.company_id = e.company_id');
    expect(sql).toContain("author.status = 'active'");
    expect(sql).toContain('e.company_id = $1');
    expect(params).toEqual([COMPANY_ID, ESTIMATE_ID]);
});
