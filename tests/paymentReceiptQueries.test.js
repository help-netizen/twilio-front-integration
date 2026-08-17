'use strict';

jest.mock('../backend/src/db/connection', () => ({
    query: jest.fn(),
}));

const db = require('../backend/src/db/connection');
const paymentsQueries = require('../backend/src/db/paymentsQueries');

const COMPANY_A = '00000000-0000-0000-0000-0000000000aa';
const COMPANY_B = '00000000-0000-0000-0000-0000000000bb';

beforeEach(() => {
    jest.clearAllMocks();
});

test('DETAIL-TENANT-CUT: detail query scopes the transaction and every operator join to company', async () => {
    db.query.mockResolvedValue({ rows: [{ id: 71 }] });

    await paymentsQueries.getTransactionReceiptContext(COMPANY_A, 71);

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('WHERE t.company_id = $1 AND t.id = $2');
    expect(sql).toContain('creator_membership.company_id = t.company_id');
    expect(sql).toContain('voider_membership.company_id = t.company_id');
    expect(sql).toContain('i.company_id = t.company_id');
    expect(sql).toContain('j.company_id = t.company_id');
    expect(sql).toContain('j.job_seq');
    expect(sql).toContain('c.company_id = t.company_id');
    expect(params).toEqual([COMPANY_A, 71]);
});

test('receipt history is tenant-scoped and newest first', async () => {
    db.query.mockResolvedValue({ rows: [] });

    await paymentsQueries.listReceiptHistory(COMPANY_B, 71);

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('pt.company_id = $1');
    expect(sql).toContain('pr.sent_at IS NOT NULL');
    expect(sql).toContain('ORDER BY pr.sent_at DESC, pr.id DESC');
    expect(params).toEqual([COMPANY_B, 71]);
});

test('claim and collision lookup both retain company scope (T-blast)', async () => {
    db.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
            rows: [{
                id: 501,
                transaction_id: 71,
                idempotency_key: 'same-key-across-tenants',
            }],
        });

    const result = await paymentsQueries.claimReceiptDelivery(
        COMPANY_B,
        71,
        {
            receiptNumber: 'REC-20260728-test',
            idempotencyKey: 'same-key-across-tenants',
            email: 'same@example.com',
        }
    );

    expect(result.claimed).toBe(false);
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls[0][0]).toContain('pt.company_id = $1 AND pt.id = $2');
    expect(db.query.mock.calls[0][1]).toEqual([
        COMPANY_B,
        71,
        'REC-20260728-test',
        'same@example.com',
        'same-key-across-tenants',
    ]);
    expect(db.query.mock.calls[1][0]).toContain('pt.company_id = $1');
    expect(db.query.mock.calls[1][1]).toEqual([
        COMPANY_B,
        71,
        'same-key-across-tenants',
    ]);
});

test('complete and release can mutate only a receipt joined to an owned payment', async () => {
    db.query
        .mockResolvedValueOnce({ rows: [{ id: 501, sent_at: '2026-07-28T16:00:00.000Z' }] })
        .mockResolvedValueOnce({ rows: [{ id: 502 }] });

    await paymentsQueries.completeReceiptDelivery(COMPANY_A, 501, 'gmail-1');
    await paymentsQueries.releaseReceiptDelivery(COMPANY_A, 502);

    expect(db.query.mock.calls[0][0]).toContain('pt.company_id = $1');
    expect(db.query.mock.calls[0][0]).toContain('pr.sent_at IS NULL');
    expect(db.query.mock.calls[0][1]).toEqual([COMPANY_A, 501, 'gmail-1']);
    expect(db.query.mock.calls[1][0]).toContain('pt.company_id = $1');
    expect(db.query.mock.calls[1][0]).toContain('pr.sent_at IS NULL');
    expect(db.query.mock.calls[1][1]).toEqual([COMPANY_A, 502]);
});
