import { describe, expect, it } from 'vitest';
import { getInvoiceCapabilities, shouldFetchInvoicePayments } from './useInvoice';

const issuedInvoice = { status: 'sent' as const, balance_due: '100.00' };

describe('invoice permission selector', () => {
    it('keeps every write/collection affordance hidden for invoices.view-only users', () => {
        const capabilities = getInvoiceCapabilities(['invoices.view'], issuedInvoice);

        expect(capabilities).toMatchObject({
            canView: true,
            canEdit: false,
            canDelete: false,
            canVoid: false,
            canSend: false,
            canViewPayments: false,
            canCollect: false,
            canVoidPayment: false,
        });
    });

    it('derives actions from permission keys and invoice state, never role names', () => {
        const capabilities = getInvoiceCapabilities([
            'invoices.view',
            'invoices.create',
            'invoices.send',
            'payments.view',
            'payments.collect_online',
            'payments.collect_offline',
            'price_book.manage',
        ], issuedInvoice);

        expect(capabilities).toMatchObject({
            canEdit: true,
            canDelete: false,
            canVoid: true,
            canSend: true,
            canViewPayments: true,
            canCollect: true,
            canCollectOnline: true,
            canCollectOffline: true,
            canVoidPayment: true,
            canManagePriceBook: true,
        });
    });

    it('offers Delete only for a draft and Void only for an issued invoice', () => {
        const permissions = ['invoices.view', 'invoices.create'];

        expect(getInvoiceCapabilities(permissions, {
            status: 'draft',
            balance_due: '100.00',
        })).toMatchObject({ canDelete: true, canVoid: false });
        expect(getInvoiceCapabilities(permissions, issuedInvoice))
            .toMatchObject({ canDelete: false, canVoid: true });
    });

    it('does not open the invoice sheet for a terminal-only collector', () => {
        expect(getInvoiceCapabilities([
            'invoices.view',
            'payments.collect_terminal',
        ], issuedInvoice)).toMatchObject({
            canCollect: false,
            canCollectTerminal: true,
        });
    });
});

describe('payment-history fetch gate', () => {
    it('requires invoice view plus payments.view and never substitutes collection rights', () => {
        expect(shouldFetchInvoicePayments(57, true, ['invoices.view', 'payments.view']))
            .toBe(true);
        expect(shouldFetchInvoicePayments(57, true, ['invoices.view']))
            .toBe(false);
        expect(shouldFetchInvoicePayments(57, true, [
            'invoices.view',
            'payments.collect_offline',
        ])).toBe(false);
        expect(shouldFetchInvoicePayments(57, false, ['invoices.view', 'payments.view']))
            .toBe(false);
    });
});
