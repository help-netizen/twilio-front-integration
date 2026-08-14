import { describe, expect, it } from 'vitest';
import {
    invoiceCollectionMethods,
    validateInvoiceCollectionAmount,
} from './InvoiceCollectPaymentDialog';
import collectSource from './InvoiceCollectPaymentDialog.tsx?raw';
import detailSource from './InvoiceDetailPanel.tsx?raw';

describe('invoice collect method permissions', () => {
    it('shows only methods backed by the exact collection permissions', () => {
        expect(invoiceCollectionMethods({
            canCollectKeyed: true,
            canCollectOffline: false,
            canCollectOnline: false,
        })).toEqual(['card']);
        expect(invoiceCollectionMethods({
            canCollectKeyed: false,
            canCollectOffline: true,
            canCollectOnline: false,
        })).toEqual(['cash', 'check']);
        expect(invoiceCollectionMethods({
            canCollectKeyed: false,
            canCollectOffline: false,
            canCollectOnline: true,
        })).toEqual(['link']);
    });
});

describe('invoice collect amount ceiling', () => {
    it('accepts full/partial cents and rejects zero or an amount over the live balance', () => {
        expect(validateInvoiceCollectionAmount('188.50', 188.5)).toBeNull();
        expect(validateInvoiceCollectionAmount('25.00', 188.5)).toBeNull();
        expect(validateInvoiceCollectionAmount('0.00', 188.5)).toContain('greater');
        expect(validateInvoiceCollectionAmount('188.51', 188.5)).toContain('cannot exceed');
    });
});

describe('invoice-bound collection wiring', () => {
    it('keeps every method on the selected invoice and exposes stable e2e drivers', () => {
        expect(collectSource).toContain('invoiceId={invoice.id}');
        expect(collectSource).toContain('recordInvoicePayment(invoice.id');
        expect(collectSource).toContain('invoiceStripeApi.createLink(invoice.id');
        expect(collectSource).toContain('data-testid="collect-amount"');
        expect(collectSource).toContain('data-testid="collect-method"');
        expect(collectSource).toContain('data-testid="collect-charge"');
        expect(detailSource).toContain('data-testid="collect-open"');
        expect(detailSource).toContain('<InvoiceCollectPaymentDialog');
    });
});
