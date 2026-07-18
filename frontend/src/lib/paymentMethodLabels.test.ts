import { describe, expect, it } from 'vitest';
import { paymentMethodLabel } from './paymentMethodLabels';

describe('paymentMethodLabel', () => {
    it.each([
        ['zb_card', 'Zenbooker · Card'],
        ['zb_check', 'Zenbooker · Check'],
        ['zb_cash', 'Zenbooker · Cash'],
        ['zb_ach', 'Zenbooker · ACH'],
        ['zb_venmo', 'Zenbooker · Venmo'],
        ['zb_zelle', 'Zenbooker · Zelle'],
        ['zb_other', 'Zenbooker · Other'],
    ])('labels %s as %s', (method, label) => {
        expect(paymentMethodLabel(method)).toBe(label);
    });

    it('keeps legacy and unknown values readable', () => {
        expect(paymentMethodLabel('zenbooker_sync')).toBe('Zenbooker');
        expect(paymentMethodLabel('gift_card')).toBe('Gift Card');
        expect(paymentMethodLabel('')).toBe('Other');
    });
});

