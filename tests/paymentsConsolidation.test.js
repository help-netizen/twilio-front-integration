/**
 * Debt #6 — zb_payments → payment_transactions ledger consolidation.
 * Covers the write-through projection and the analytics single-source read
 * (Zenbooker-priority). Numeric equivalence to the legacy path was verified
 * on a prod-data copy (migration 104, 0/1164 mismatched jobs).
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const db = require('../backend/src/db/connection');
const COMPANY = '11111111-1111-1111-1111-111111111111';

beforeEach(() => db.query.mockReset());

describe('projectCompanyLedger (write-through)', () => {
    const sync = require('../backend/src/services/zenbookerPaymentsSyncService');

    it('upserts the company zb_payments into the ledger, Zenbooker-priority', async () => {
        db.query.mockResolvedValueOnce({ rowCount: 5 });
        const res = await sync.projectCompanyLedger(COMPANY);
        expect(res.rowCount).toBe(5);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('INSERT INTO payment_transactions');
        expect(sql).toContain("'zenbooker_sync'");
        expect(sql).toContain("'zenbooker'");
        expect(sql).toContain('FROM zb_payments zp');
        expect(sql).toContain('WHERE zp.company_id = $1');
        expect(sql).toMatch(/ON CONFLICT .*external_source = 'zenbooker'\s*DO UPDATE/s);
        expect(params).toEqual([COMPANY]);
    });

    it('maps zb transaction_status → ledger status', async () => {
        db.query.mockResolvedValueOnce({ rowCount: 0 });
        await sync.projectCompanyLedger(COMPANY);
        const sql = db.query.mock.calls[0][0];
        expect(sql).toMatch(/'succeeded'\s+THEN\s+'completed'/);
        expect(sql).toMatch(/'failed'\s+THEN\s+'failed'/);
        expect(sql).toMatch(/'voided'\s+THEN\s+'voided'/);
    });
});

describe('analyticsService.listJobs — single canonical source', () => {
    const analytics = require('../backend/src/services/analyticsService');

    it('reads only payment_transactions (no zb_payments cross-join) with Zenbooker-priority', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        await analytics.listJobs({ from: '2026-05-01', to: '2026-06-01', companyId: COMPANY, limit: 10 });
        const sql = db.query.mock.calls[0][0];
        // Paid total now comes from the ledger, preferring zenbooker_sync rows.
        expect(sql).toContain("pt.payment_method = 'zenbooker_sync'");
        expect(sql).toContain('FROM payment_transactions pt');
        // The legacy dual-source fallback is gone.
        expect(sql).not.toContain('zb_payments');
    });
});
