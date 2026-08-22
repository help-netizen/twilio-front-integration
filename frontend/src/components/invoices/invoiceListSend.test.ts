import { describe, expect, it } from 'vitest';
import type { Invoice } from '../../services/invoicesApi';
import { appendInvoicesById } from '../../hooks/useInvoices';
import {
    invoiceBalanceTone,
    invoiceStatusLabel,
    invoiceStatusTone,
    invoiceTimingLabel,
} from './InvoiceMobileRow';
import {
    buildDefaultInvoiceMessage,
    getInvoiceSendPrefill,
} from './InvoiceSendDialog';
import listSource from '../../pages/InvoicesPage.tsx?raw';
import sendSource from './InvoiceSendDialog.tsx?raw';

function invoice(overrides: Partial<Invoice> = {}): Invoice {
    return {
        id: 1042,
        company_id: 'company-a',
        invoice_number: 'INV-1042',
        status: 'partial',
        contact_id: 2,
        lead_id: null,
        job_id: 1658,
        estimate_id: null,
        title: 'Repair',
        notes: null,
        internal_note: null,
        subtotal: '338.50',
        tax_rate: '0.00',
        tax_amount: '0.00',
        discount_amount: '0.00',
        total: '338.50',
        amount_paid: '150.00',
        balance_due: '188.50',
        currency: 'USD',
        payment_terms: null,
        due_date: '2026-08-20T12:00:00Z',
        sent_at: '2026-08-10T12:00:00Z',
        paid_at: null,
        voided_at: null,
        created_by: null,
        updated_by: null,
        created_at: '2026-08-10T12:00:00Z',
        updated_at: '2026-08-10T12:00:00Z',
        contact_name: 'Maria Chen',
        contact_email: 'maria@example.com',
        contact_phone: '+12125550142',
        job_number: '1658',
        ...overrides,
    };
}

describe('mobile invoice rows', () => {
    it('uses plain-language status/timing labels and semantic balance colors', () => {
        expect(invoiceStatusLabel('viewed')).toBe('Sent');
        expect(invoiceStatusLabel('partial')).toBe('Partial');
        expect(invoiceTimingLabel(invoice())).toBe('Due Aug 20');
        expect(invoiceTimingLabel(invoice({ status: 'draft', due_date: null }))).toBe('Not sent');
        expect(invoiceTimingLabel(invoice({
            status: 'paid',
            paid_at: '2026-08-05T12:00:00Z',
        }))).toBe('Paid Aug 5');
        expect(invoiceStatusTone('partial')).toContain('--blanc-lead-soft');
        expect(invoiceStatusTone('overdue')).toContain('--blanc-danger-soft');
        expect(invoiceStatusTone('paid')).toContain('--blanc-task-soft');
        expect(invoiceBalanceTone('overdue')).toContain('--blanc-danger');
        expect(invoiceBalanceTone('paid')).toContain('--blanc-success');
    });

    it('appends an offset page in order without duplicating repeated records', () => {
        const first = [invoice({ id: 1 }), invoice({ id: 2 })];
        const next = [invoice({ id: 2 }), invoice({ id: 3 })];

        expect(appendInvoicesById(first, next).map(row => row.id)).toEqual([1, 2, 3]);
    });

    it('renders mobile rows/load-more while keeping the desktop table off mobile', () => {
        expect(listSource).toContain('data-testid="invoice-list-row"');
        expect(listSource).toContain('data-testid="invoice-load-more"');
        expect(listSource).toContain('hidden w-full text-sm blanc-table-tiles md:table');
        expect(listSource).toContain("onClick={page.loadMore}");
        expect(listSource).toContain("{page.loadingMore ? 'Loading…' : 'Load more'}");
    });
});

describe('single-object send contract', () => {
    it('derives the invoice id and every recipient/message prefill from the same invoice', () => {
        const first = invoice();
        const second = invoice({
            id: 1041,
            invoice_number: 'INV-1041',
            contact_name: 'John Ruiz',
            contact_email: '',
            contact_phone: '+13125550141',
            total: '420.00',
            balance_due: '420.00',
            due_date: '2026-08-08T12:00:00Z',
        });

        expect(getInvoiceSendPrefill(first)).toMatchObject({
            invoiceId: 1042,
            invoiceNumber: 'INV-1042',
            contactName: 'Maria Chen',
            emailRecipient: 'maria@example.com',
            phoneRecipient: '+12125550142',
            balanceDue: 188.5,
            total: 338.5,
            channel: 'email',
        });
        expect(getInvoiceSendPrefill(second)).toMatchObject({
            invoiceId: 1041,
            invoiceNumber: 'INV-1041',
            contactName: 'John Ruiz',
            emailRecipient: '',
            phoneRecipient: '+13125550141',
            balanceDue: 420,
            total: 420,
            channel: 'sms',
        });
    });

    it('composes nothing for email and keeps the text message whole', () => {
        // This case used to require the email default to carry the number, the amount,
        // the due date and the link. DOC-EMAIL-001 overturned that (owner, 21.08): the
        // letter itself says all of it and carries the button, so the paragraph was the
        // same thing twice. SMS keeps everything — there is no document behind a text.
        const options = {
            invoiceNumber: 'INV-1042',
            name: 'Maria',
            url: 'https://app.albusto.test/pay/token',
            balanceDue: 188.5,
            total: 338.5,
            dueDate: '2026-08-20T12:00:00Z',
            signOff: 'Sam',
        };

        const email = buildDefaultInvoiceMessage('email', options);
        const sms = buildDefaultInvoiceMessage('sms', options);
        expect(email).toBe('');
        expect(sms).toContain('INV-1042');
        expect(sms).toContain('$188.50');
        expect(sms).toContain(options.url);
        expect(sms).not.toMatch(/[\p{Extended_Pictographic}]/u);
    });

    it('keeps the dialog API atomic and puts mobile actions in the scrolling body', () => {
        expect(sendSource).toContain('invoice: Invoice;');
        expect(sendSource).toContain('await onSend(invoice.id, {');
        expect(sendSource).not.toContain('invoiceId: number;');
        expect(listSource).toContain('invoice={sendInvoice}');
        expect(listSource).not.toContain('contactEmail={page.selectedInvoice');
        expect(sendSource).toContain('<div className="mt-4 md:hidden">{actionButtons}</div>');
        expect(sendSource).toContain('<DialogPanelFooter className="max-md:hidden">');
    });
});
