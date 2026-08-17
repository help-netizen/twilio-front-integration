import { describe, expect, it } from 'vitest';
import {
    calculateJobFinanceSummary,
    completedJobPoolDueOffset,
    completedJobPoolPaid,
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

    it('CTRL-ZBPAY-DUE-GUARD: an UNLINKED ZB payment credits Paid and Due alike', () => {
        // The guard used to skip every zenbooker row from the Due offset, on the
        // premise that ZB money already sat on its invoice. Production says
        // otherwise: 1403 completed ZB payments ($288,840), none carrying an
        // invoice_id, and no invoice carrying amount_paid without a linked
        // payment. So the money counted in Paid and never reduced Due, and every
        // ZB-funded job showed a debt it did not have (measured 2026-08-16).
        const payment = {
            amount: '95.00',
            invoice_id: null,
            transaction_type: 'payment',
            status: 'completed',
            external_source: 'zenbooker',
        };

        expect(completedJobPoolPaid([payment])).toBe(95);
        expect(completedJobPoolDueOffset([payment])).toBe(95);
        expect(calculateJobFinanceSummary([], [], [payment]))
            .toEqual({ estimated: 0, invoiced: 0, paid: 95, due: -95 });
    });

    it('CTRL-ZBPAY-DUE-GUARD: a LINKED ZB payment stays out of both, so it cannot count twice', () => {
        // This is the case the guard was written for: the invoice already carries
        // the money in amount_paid, so the pool must not add it again — to Paid
        // or to Due.
        const payment = {
            amount: '95.00',
            invoice_id: 12,
            transaction_type: 'payment',
            status: 'completed',
            external_source: 'zenbooker',
        };

        expect(completedJobPoolPaid([payment])).toBe(0);
        expect(completedJobPoolDueOffset([payment])).toBe(0);
        expect(calculateJobFinanceSummary([], [{ total: '95', amount_paid: '95', status: 'sent' }], [payment]))
            .toEqual({ estimated: 0, invoiced: 95, paid: 95, due: 0 });
    });

    it('reproduces job 1498: ZB money reduces Due instead of inflating it', () => {
        // Three invoices ($1,665.81 + $125 + $125), a card payment linked to the
        // first, and a $125 Zenbooker payment with no invoice. Due is what is
        // left over: $125, not the $250 the old guard produced.
        const summary = calculateJobFinanceSummary(
            [],
            [
                { total: '1665.81', amount_paid: '0', status: 'sent' },
                { total: '125.00', amount_paid: '0', status: 'sent' },
                { total: '125.00', amount_paid: '0', status: 'sent' },
            ],
            [
                { id: 23172, amount: '125.00', invoice_id: null, transaction_type: 'payment', status: 'completed', external_source: 'zenbooker' },
                { id: 46348, amount: '1665.81', invoice_id: 49, transaction_type: 'payment', status: 'completed', external_source: null },
            ],
        );

        expect(formatSignedCurrency(summary.invoiced)).toBe('$1,915.81');
        expect(formatSignedCurrency(summary.paid)).toBe('$1,790.81');
        expect(formatSignedCurrency(summary.due)).toBe('$125.00');
    });

    it('nets completed refunds, includes invoice-referenced payments, and ignores pending rows', () => {
        const payments = [
            { id: 1, amount: '25', invoice_id: null, transaction_type: 'payment', status: 'completed', external_source: 'manual' },
            { id: 2, amount: '100', invoice_id: 8, transaction_type: 'payment', status: 'completed' },
            { id: 3, amount: '50', invoice_id: null, transaction_type: 'payment', status: 'pending' },
            { id: 4, amount: '10', invoice_id: null, transaction_type: 'refund', status: 'completed' },
        ];

        // 25 + 100 completed payments − 10 completed refund = 115; pending contributes nothing.
        expect(completedJobPoolPaid(payments)).toBe(115);
        expect(completedJobPoolDueOffset(payments)).toBe(115);
        expect(calculateJobFinanceSummary(
            [{ total: '150' }],
            [{ total: '100', amount_paid: '100', job_payment_allocated: '60' }],
            payments,
        )).toEqual({ estimated: 150, invoiced: 100, paid: 155, due: -55 });
    });

    it('TXN-STATUS-VOID-001: gross counts refunded originals, nets the refund, excludes voided', () => {
        const payments = [
            { id: 1, amount: '100', invoice_id: null, transaction_type: 'payment', status: 'refunded', external_source: 'manual' },
            { id: 2, amount: '30', invoice_id: null, transaction_type: 'refund', status: 'completed', external_source: null, metadata: { original_transaction_id: 1 } },
            { id: 3, amount: '40', invoice_id: null, transaction_type: 'payment', status: 'voided', voided_at: '2026-01-01T00:00:00Z', external_source: 'manual' },
        ];

        // $100 payment (now 'refunded') still counts gross; −$30 refund → net $70; the voided $40 contributes nothing.
        expect(completedJobPoolPaid(payments)).toBe(70);
        expect(completedJobPoolDueOffset(payments)).toBe(70);
    });

    it('a refund of a Zenbooker payment inherits the source, and nets in Paid and Due alike', () => {
        const payments = [
            { id: 10, amount: '100', invoice_id: null, transaction_type: 'payment', status: 'refunded', external_source: 'zenbooker' },
            { id: 11, amount: '30', invoice_id: null, transaction_type: 'refund', status: 'completed', external_source: null, metadata: { original_transaction_id: 10 } },
        ];

        // Neither row carries an invoice_id, so the money is nowhere else — it
        // nets to 70 in both, exactly like any other unlinked payment.
        expect(completedJobPoolPaid(payments)).toBe(70);
        expect(completedJobPoolDueOffset(payments)).toBe(70);
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

    it('PAY-JOB-CENTRIC-001: job 1603 shape does not double count linked and unlinked pool rows', () => {
        expect(calculateJobFinanceSummary(
            [],
            [{ total: '280', amount_paid: '280', job_payment_allocated: '280', status: 'paid' }],
            [
                { id: 1, amount: '95', invoice_id: 44, transaction_type: 'payment', status: 'completed', external_source: 'manual' },
                { id: 2, amount: '185', invoice_id: null, transaction_type: 'payment', status: 'completed', external_source: 'stripe' },
            ],
        )).toEqual({ estimated: 0, invoiced: 280, paid: 280, due: 0 });
    });

    it('keeps linked Zenbooker money materialized and excludes it from the native pool', () => {
        expect(calculateJobFinanceSummary(
            [],
            [{ total: '100', amount_paid: '40', job_payment_allocated: '0' }],
            [{ id: 5, amount: '40', invoice_id: 12, transaction_type: 'payment', status: 'completed', external_source: 'zenbooker' }],
        )).toEqual({ estimated: 0, invoiced: 100, paid: 40, due: 60 });
    });

    it('counts tips in Paid but applies only the service amount to Due', () => {
        expect(calculateJobFinanceSummary(
            [],
            [{ total: '100', amount_paid: '100', job_payment_allocated: '100' }],
            [{ id: 6, amount: '115', invoice_id: 12, transaction_type: 'payment', status: 'completed', external_source: 'stripe', metadata: { tip: 15 } }],
        )).toEqual({ estimated: 0, invoiced: 100, paid: 115, due: 0 });
    });
});

describe('formatSignedCurrency', () => {
    it('always uses two decimals and puts a true minus before the dollar sign', () => {
        expect(formatSignedCurrency(1234.5)).toBe('$1,234.50');
        expect(formatSignedCurrency(-12.5)).toBe('−$12.50');
        expect(formatSignedCurrency(-0)).toBe('$0.00');
    });
});
