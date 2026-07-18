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
        for (const method of ['zb_card', 'zb_check', 'zb_cash', 'zb_ach', 'zb_venmo', 'zb_zelle', 'zb_other']) {
            expect(sql).toContain(`'${method}'`);
        }
        expect(sql).toContain("'zenbooker'");
        expect(sql).toContain('FROM zb_payments zp');
        expect(sql).toContain('WHERE zp.company_id = $1');
        expect(sql).toMatch(/ON CONFLICT .*external_source = 'zenbooker'\s*DO UPDATE/s);
        expect(params).toEqual([COMPANY]);
    });

    it('retypes in place and preserves existing metadata on conflict', async () => {
        db.query.mockResolvedValueOnce({ rowCount: 1 });
        await sync.projectCompanyLedger(COMPANY);
        const sql = db.query.mock.calls[0][0];
        expect(sql).toContain('transaction_type = EXCLUDED.transaction_type');
        expect(sql).toContain('payment_method = EXCLUDED.payment_method');
        expect(sql).toContain("COALESCE(payment_transactions.metadata, '{}'::jsonb) || EXCLUDED.metadata");
        expect(sql).toContain("'zb_payment_method'");
        expect(sql).toContain("'zb_custom_payment_method_name'");
        expect(sql).toContain("'zb_card_brand'");
    });

    it('maps zb transaction_status → ledger status', async () => {
        db.query.mockResolvedValueOnce({ rowCount: 0 });
        await sync.projectCompanyLedger(COMPANY);
        const sql = db.query.mock.calls[0][0];
        expect(sql).toMatch(/'succeeded'\s+THEN\s+'completed'/);
        expect(sql).toMatch(/'failed'\s+THEN\s+'failed'/);
        expect(sql).toMatch(/'voided'\s+THEN\s+'voided'/);
    });

    it('stages refund-like or negative rows as non-financial adjustments', async () => {
        db.query.mockResolvedValueOnce({ rowCount: 0 });
        await sync.projectCompanyLedger(COMPANY);
        const sql = db.query.mock.calls[0][0];
        expect(sql).toContain("~ '(refund|reversal|reversed)'");
        expect(sql).toContain('COALESCE(zp.amount_paid, 0) < 0');
        expect(sql).toMatch(/THEN 'adjustment'/);
        expect(sql).toContain("'zb_transaction_kind'");
        expect(sql).toContain("'zb_transaction_status'");
    });
});

describe('normalizeZenbookerPaymentMethod', () => {
    const { normalizeZenbookerPaymentMethod } = require('../backend/src/services/zenbookerPaymentsSyncService');

    test.each([
        ['stripe', 'zb_card'],
        ['STRIPE (visa)', 'zb_card'],
        ['card', 'zb_card'],
        ['credit_card', 'zb_card'],
        ['check', 'zb_check'],
        ['cheque', 'zb_check'],
        ['cash', 'zb_cash'],
        ['ACH', 'zb_ach'],
        ['venmo', 'zb_venmo'],
        ['zelle', 'zb_zelle'],
        ['custom', 'zb_other'],
        ['Financing', 'zb_other'],
        ['', 'zb_other'],
    ])('%s → %s', (raw, expected) => {
        expect(normalizeZenbookerPaymentMethod(raw)).toBe(expected);
    });
});

describe('classifyZenbookerTransaction', () => {
    const { classifyZenbookerTransaction } = require('../backend/src/services/zenbookerPaymentsSyncService');

    it('makes only succeeded, non-refund-like rows financially completed payments', () => {
        expect(classifyZenbookerTransaction({ status: 'succeeded', amount_collected: '95.00' }))
            .toEqual({ transaction_type: 'payment', status: 'completed' });
        expect(classifyZenbookerTransaction({ status: 'succeeded', type: 'refund', amount_collected: '95.00' }))
            .toEqual({ transaction_type: 'adjustment', status: 'pending' });
        expect(classifyZenbookerTransaction({ status: 'succeeded', amount_collected: '-95.00' }))
            .toEqual({ transaction_type: 'adjustment', status: 'pending' });
        expect(classifyZenbookerTransaction({ status: 'failed', amount_collected: '95.00' }))
            .toEqual({ transaction_type: 'payment', status: 'failed' });
    });
});

describe('analyticsService.listJobs — single canonical source', () => {
    const analytics = require('../backend/src/services/analyticsService');

    it('reads only payment_transactions (no zb_payments cross-join) with Zenbooker-priority', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        await analytics.listJobs({ from: '2026-05-01', to: '2026-06-01', companyId: COMPANY, limit: 10 });
        const sql = db.query.mock.calls[0][0];
        // Paid total now comes from the ledger, preferring source-provenance rows.
        expect(sql).toContain("pt.external_source = 'zenbooker'");
        expect(sql).not.toContain("pt.payment_method = 'zenbooker_sync'");
        expect(sql).toContain('FROM payment_transactions pt');
        expect(sql).toContain('pt.company_id = j.company_id');
        // The legacy dual-source fallback is gone.
        expect(sql).not.toContain('zb_payments');
    });
});
