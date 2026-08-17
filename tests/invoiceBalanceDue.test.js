'use strict';

jest.mock('../backend/src/db/connection', () => ({
    query: jest.fn(),
}));

const db = require('../backend/src/db/connection');
const invoicesQueries = require('../backend/src/db/invoicesQueries');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';

beforeEach(() => jest.clearAllMocks());

test('FINANCE-DUE-001: total 100 minus amount_paid 30 produces balance_due 70', () => {
    expect(invoicesQueries.calculateBalanceDue('100.00', '30.00')).toBe(70);
    expect(invoicesQueries.withCalculatedBalance({
        total: '100.00',
        amount_paid: '30.00',
        balance_due: '100.00',
    })).toMatchObject({
        total: '100.00',
        amount_paid: '30.00',
        balance_due: '70.00',
    });
});

test('authenticated invoice detail ignores a stale stored balance and remains company-scoped', async () => {
    db.query.mockResolvedValueOnce({
        rows: [{
            id: 1528,
            company_id: COMPANY_A,
            job_seq: 171,
            total: '100.00',
            amount_paid: '30.00',
            balance_due: '100.00',
        }],
    });

    const invoice = await invoicesQueries.getInvoiceById(COMPANY_A, 1528);

    expect(invoice.balance_due).toBe('70.00');
    expect(invoice.job_seq).toBe(171);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('WHERE i.id = $1 AND i.company_id = $2');
    expect(sql).toContain("COALESCE(NULLIF(c.email, ''), NULLIF(j.customer_email, '')) AS contact_email");
    expect(sql).toContain("COALESCE(NULLIF(c.phone_e164, ''), NULLIF(j.customer_phone, '')) AS contact_phone");
    expect(sql).toContain('ON c.id = COALESCE(j.contact_id, i.contact_id)');
    expect(sql).toContain('AND c.company_id = i.company_id');
    expect(sql).toContain('j.job_seq AS job_seq');
    expect(params).toEqual([1528, COMPANY_A]);
});

test('invoice list surfaces normalize every row without changing the tenant filter', async () => {
    db.query.mockResolvedValueOnce({
        rows: [{
            id: 1528,
            company_id: COMPANY_A,
            job_seq: 171,
            total: '100.00',
            amount_paid: '30.00',
            balance_due: '100.00',
            _total: '1',
        }],
    });

    const result = await invoicesQueries.listInvoices(COMPANY_A);

    expect(result).toMatchObject({
        total: 1,
        rows: [expect.objectContaining({ id: 1528, job_seq: 171, balance_due: '70.00' })],
    });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('i.company_id = $1');
    expect(params[0]).toBe(COMPANY_A);
    expect(sql).toContain('ON c.id = COALESCE(j.contact_id, i.contact_id)');
    expect(sql).toContain('c.company_id = i.company_id');
    expect(sql).toContain('j.job_seq AS job_seq');
});

test('mobile unpaid filter stays tenant-scoped and uses the requested offset', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    await invoicesQueries.listInvoices(COMPANY_A, {
        status: 'unpaid',
        limit: 25,
        offset: 50,
    });

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('i.company_id = $1');
    expect(sql).toContain("i.status IN ('sent', 'viewed', 'partial', 'overdue')");
    expect(sql).not.toContain('i.status = $2');
    expect(params).toEqual([COMPANY_A, 25, 50]);
    expect(sql).toContain('LIMIT $2 OFFSET $3');
});

test('public-token invoice reads also normalize the balance for PDF/public consumers', async () => {
    db.query.mockResolvedValueOnce({
        rows: [{
            id: 1528,
            company_id: COMPANY_A,
            total: '100.00',
            amount_paid: '30.00',
            balance_due: '100.00',
        }],
    });

    const invoice = await invoicesQueries.getInvoiceByPublicToken('opaque-token');

    expect(invoice.balance_due).toBe('70.00');
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('c.company_id = i.company_id');
    expect(sql).toContain('i.public_token_expires_at > NOW()');
    expect(sql).toContain('i.status = ANY($2::text[])');
    expect(params).toEqual([
        'opaque-token',
        ['sent', 'viewed', 'partial', 'paid', 'overdue'],
    ]);
});

test('invoice token rotation is company-scoped and sets expiry from the database clock', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    await invoicesQueries.setPublicToken(1528, COMPANY_A, 'rotated-token', null, 18);

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('public_token = $3');
    expect(sql).toContain("public_token_expires_at = NOW() + ($4::integer * INTERVAL '1 month')");
    expect(sql).toContain('id = $1 AND company_id = $2');
    expect(params).toEqual([1528, COMPANY_A, 'rotated-token', 18]);
});
