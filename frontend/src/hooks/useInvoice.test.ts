import { describe, expect, it } from 'vitest';
import { getInvoiceCapabilities, shouldFetchInvoicePayments } from './useInvoice';

const issuedInvoice = { status: 'sent' as const, balance_due: '100.00' };

describe('invoice permission selector', () => {
    it('keeps every write/collection affordance hidden for invoices.view-only users', () => {
        const capabilities = getInvoiceCapabilities(['invoices.view'], issuedInvoice);

        expect(capabilities).toMatchObject({
            canView: true,
            canEdit: false,
            canRemove: false,
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
            canRemove: true,
            canSend: true,
            canViewPayments: true,
            canCollect: true,
            canCollectOnline: true,
            canCollectOffline: true,
            canVoidPayment: true,
            canManagePriceBook: true,
        });
    });

    it('offers ONE removal, whatever state the invoice is in (OB-70)', () => {
        // Two capabilities meant two labels, and a draft that had taken a card
        // payment matched neither cleanly: the card offered Void and the server
        // answered "Draft invoices must be deleted, not voided". Draft or issued,
        // paid or not, the dispatcher may remove it — what that costs underneath
        // (delete a clean draft, void anything with history) is not their problem.
        const permissions = ['invoices.view', 'invoices.create'];

        expect(getInvoiceCapabilities(permissions, {
            status: 'draft',
            balance_due: '100.00',
        })).toMatchObject({ canRemove: true });
        expect(getInvoiceCapabilities(permissions, issuedInvoice))
            .toMatchObject({ canRemove: true });
        expect(getInvoiceCapabilities(permissions, { status: 'draft', balance_due: '0.00' }))
            .toMatchObject({ canRemove: true });
    });

    it('does not offer to remove what is already gone', () => {
        const permissions = ['invoices.view', 'invoices.create'];
        for (const status of ['void', 'refunded'] as const) {
            expect(getInvoiceCapabilities(permissions, { status, balance_due: '0.00' }))
                .toMatchObject({ canRemove: false });
        }
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
