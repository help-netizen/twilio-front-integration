import { describe, expect, it } from 'vitest';
import { getPaymentStatusInfo, isVoidablePayment, isVoidedPayment } from './paymentStatus';

describe('getPaymentStatusInfo', () => {
    it('shows a completed payment as "Succeeded", never the raw "Completed"', () => {
        const info = getPaymentStatusInfo('completed', 'payment');
        expect(info.label).toBe('Succeeded');
        expect(info.label).not.toBe('Completed');
    });

    it('shows both a refund row and a refunded original as "Refunded"', () => {
        expect(getPaymentStatusInfo('completed', 'refund').label).toBe('Refunded');
        expect(getPaymentStatusInfo('refunded', 'payment').label).toBe('Refunded');
    });

    it('maps the remaining statuses', () => {
        expect(getPaymentStatusInfo('voided', 'payment').label).toBe('Voided');
        expect(getPaymentStatusInfo('pending', 'payment').label).toBe('Pending');
        expect(getPaymentStatusInfo('processing', 'payment').label).toBe('Processing');
        expect(getPaymentStatusInfo('failed', 'payment').label).toBe('Failed');
    });
});

describe('isVoidablePayment', () => {
    const base = { transaction_type: 'payment', status: 'completed', external_source: 'manual' } as const;

    it('allows a completed, manually-recorded payment', () => {
        expect(isVoidablePayment(base)).toBe(true);
    });

    it('refuses Stripe / Zenbooker / null-source, refunds, and non-completed payments', () => {
        expect(isVoidablePayment({ ...base, external_source: 'stripe' })).toBe(false);
        expect(isVoidablePayment({ ...base, external_source: 'zenbooker' })).toBe(false);
        expect(isVoidablePayment({ ...base, external_source: null })).toBe(false);
        expect(isVoidablePayment({ ...base, transaction_type: 'refund' })).toBe(false);
        expect(isVoidablePayment({ ...base, status: 'voided' })).toBe(false);
        expect(isVoidablePayment({ ...base, status: 'pending' })).toBe(false);
    });
});

describe('isVoidedPayment', () => {
    it('is true only for a voided row', () => {
        expect(isVoidedPayment({ status: 'voided' })).toBe(true);
        expect(isVoidedPayment({ status: 'completed' })).toBe(false);
    });
});
