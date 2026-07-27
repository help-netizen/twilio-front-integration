import { describe, expect, it } from 'vitest';
import {
    calculateJobFinanceSummary,
    completedStandaloneDueOffset,
    completedStandalonePaid,
    formatSignedCurrency,
} from './jobFinanceMath';

describe('calculateJobFinanceSummary', () => {
    it('keeps a native no-invoice $95 payment as Paid $95 and signed Due -$95', () => {
        const summary = calculateJobFinanceSummary([], [], [{
            amount: '95.00',
            invoice_id: null,
            transaction_type: 'payment',
            status: 'completed',
            external_source: 'stripe',
        }]);

        expect(summary).toEqual({ estimated: 0, invoiced: 0, paid: 95, due: -95 });
        expect(formatSignedCurrency(summary.paid)).toBe('$95.00');
        expect(formatSignedCurrency(summary.due)).toBe('−$95.00');
        expect(formatSignedCurrency(summary.due).codePointAt(0)).toBe(0x2212);
    });

    it('CTRL-ZBPAY-DUE-GUARD: counts a standalone ZB payment in Paid but not Due credit', () => {
        const payment = {
            amount: '95.00',
            invoice_id: null,
            transaction_type: 'payment',
            status: 'completed',
            external_source: 'zenbooker',
        };

        expect(completedStandalonePaid([payment])).toBe(95);
        expect(completedStandaloneDueOffset([payment])).toBe(0);
        expect(calculateJobFinanceSummary([], [], [payment]))
            .toEqual({ estimated: 0, invoiced: 0, paid: 95, due: 0 });
    });

    it('nets a completed refund against standalone payments and ignores invoice-linked/pending rows', () => {
        const payments = [
            { id: 1, amount: '25', invoice_id: null, transaction_type: 'payment', status: 'completed', external_source: 'manual' },
            { id: 2, amount: '100', invoice_id: 8, transaction_type: 'payment', status: 'completed' },
            { id: 3, amount: '50', invoice_id: null, transaction_type: 'payment', status: 'pending' },
            { id: 4, amount: '10', invoice_id: null, transaction_type: 'refund', status: 'completed' },
        ];

        // 25 completed payment − 10 completed refund = 15 (pending + invoice-linked ignored).
        expect(completedStandalonePaid(payments)).toBe(15);
        expect(completedStandaloneDueOffset(payments)).toBe(15);
        expect(calculateJobFinanceSummary(
            [{ total: '150' }],
            [{ total: '100', amount_paid: '40' }],
            payments,
        )).toEqual({ estimated: 150, invoiced: 100, paid: 55, due: 45 });
    });

    it('TXN-STATUS-VOID-001: gross counts refunded originals, nets the refund, excludes voided', () => {
        const payments = [
            { id: 1, amount: '100', invoice_id: null, transaction_type: 'payment', status: 'refunded', external_source: 'manual' },
            { id: 2, amount: '30', invoice_id: null, transaction_type: 'refund', status: 'completed', external_source: null, metadata: { original_transaction_id: 1 } },
            { id: 3, amount: '40', invoice_id: null, transaction_type: 'payment', status: 'voided', voided_at: '2026-01-01T00:00:00Z', external_source: 'manual' },
        ];

        // $100 payment (now 'refunded') still counts gross; −$30 refund → net $70; the voided $40 contributes nothing.
        expect(completedStandalonePaid(payments)).toBe(70);
        expect(completedStandaloneDueOffset(payments)).toBe(70);
    });

    it('a refund of a Zenbooker payment inherits the zenbooker source (Paid nets, Due gets no credit)', () => {
        const payments = [
            { id: 10, amount: '100', invoice_id: null, transaction_type: 'payment', status: 'refunded', external_source: 'zenbooker' },
            { id: 11, amount: '30', invoice_id: null, transaction_type: 'refund', status: 'completed', external_source: null, metadata: { original_transaction_id: 10 } },
        ];

        expect(completedStandalonePaid(payments)).toBe(70);
        expect(completedStandaloneDueOffset(payments)).toBe(0);
    });

    it('drops a voided invoice from Invoiced/Paid/Due', () => {
        expect(calculateJobFinanceSummary(
            [],
            [{ total: '100', amount_paid: '100', status: 'voided' }],
            [],
        )).toEqual({ estimated: 0, invoiced: 0, paid: 0, due: 0 });
    });

    it('FINANCE-DUE-001: total 100 and paid 30 yields due 70 while estimates stay separate', () => {
        expect(calculateJobFinanceSummary(
            [{ total: '250' }],
            [{ total: '100', amount_paid: '30' }],
            [],
        )).toEqual({ estimated: 250, invoiced: 100, paid: 30, due: 70 });
    });
});

describe('formatSignedCurrency', () => {
    it('always uses two decimals and puts a true minus before the dollar sign', () => {
        expect(formatSignedCurrency(1234.5)).toBe('$1,234.50');
        expect(formatSignedCurrency(-12.5)).toBe('−$12.50');
        expect(formatSignedCurrency(-0)).toBe('$0.00');
    });
});
