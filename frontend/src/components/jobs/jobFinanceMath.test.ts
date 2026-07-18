import { describe, expect, it } from 'vitest';
import { calculateJobFinanceSummary, completedStandalonePaid, formatSignedCurrency } from './jobFinanceMath';

describe('calculateJobFinanceSummary', () => {
    it('turns a no-invoice $95 standalone payment into Paid $95 and signed Due -$95', () => {
        const summary = calculateJobFinanceSummary([], [], [{
            amount: '95.00',
            invoice_id: null,
            transaction_type: 'payment',
            status: 'completed',
        }]);

        expect(summary).toEqual({ estimated: 0, invoiced: 0, paid: 95, due: -95 });
        expect(formatSignedCurrency(summary.paid)).toBe('$95.00');
        expect(formatSignedCurrency(summary.due)).toBe('−$95.00');
        expect(formatSignedCurrency(summary.due).codePointAt(0)).toBe(0x2212);
    });

    it('combines invoice paid with only completed standalone payment rows', () => {
        const payments = [
            { amount: '25', invoice_id: null, transaction_type: 'payment', status: 'completed' },
            { amount: '100', invoice_id: 8, transaction_type: 'payment', status: 'completed' },
            { amount: '50', invoice_id: null, transaction_type: 'payment', status: 'pending' },
            { amount: '10', invoice_id: null, transaction_type: 'refund', status: 'completed' },
        ];

        expect(completedStandalonePaid(payments)).toBe(25);
        expect(calculateJobFinanceSummary(
            [{ total: '150' }],
            [{ total: '100', amount_paid: '40' }],
            payments,
        )).toEqual({ estimated: 150, invoiced: 100, paid: 65, due: 35 });
    });
});

describe('formatSignedCurrency', () => {
    it('always uses two decimals and puts a true minus before the dollar sign', () => {
        expect(formatSignedCurrency(1234.5)).toBe('$1,234.50');
        expect(formatSignedCurrency(-12.5)).toBe('−$12.50');
        expect(formatSignedCurrency(-0)).toBe('$0.00');
    });
});
