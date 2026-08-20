import { describe, expect, it } from 'vitest';
import { completedJobPoolPaid, formatSignedCurrency } from './jobFinanceMath';

/**
 * The job's Estimated / Invoiced / Paid / Due used to be computed in this module and
 * asserted here — thirteen cases covering Zenbooker money, refunds, voided rows and
 * legacy `amount_paid`. OB-70 moved that arithmetic to one server-side projector
 * (`GET /api/jobs/:id/finance`), and those same rules are now asserted against a real
 * database in tests/invoicePaymentAbsorption.db.test.js, by the same names:
 * CTRL-ZBPAY-DUE-GUARD, job 1498, TXN-STATUS-VOID-001, PAY-JOB-CENTRIC-001 job 1603,
 * SAB-OB70-LEGACY-PAID. They were verified green there before this file was trimmed —
 * a guard is only retired once its replacement is proven, never because the code it
 * watched went away.
 */

describe('completedJobPoolPaid', () => {
    it('counts completed native money and skips Zenbooker rows already on an invoice', () => {
        const paid = completedJobPoolPaid([
            { amount: '95.00', invoice_id: null, transaction_type: 'payment', status: 'completed', external_source: 'stripe' },
            { amount: '40.00', invoice_id: 12, transaction_type: 'payment', status: 'completed', external_source: 'zenbooker' },
            { amount: '10.00', invoice_id: null, transaction_type: 'payment', status: 'pending', external_source: 'stripe' },
        ]);
        expect(paid).toBe(95);
    });
});

describe('formatSignedCurrency', () => {
    it('always uses two decimals and puts a true minus before the dollar sign', () => {
        expect(formatSignedCurrency(1234.5)).toBe('$1,234.50');
        expect(formatSignedCurrency(-12.5)).toBe('−$12.50');
        expect(formatSignedCurrency(-0)).toBe('$0.00');
    });
});
