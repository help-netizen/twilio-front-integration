import { describe, expect, it } from 'vitest';
import invoiceRaw from '../invoices/InvoiceSendDialog.tsx?raw';
import estimateRaw from '../estimates/EstimateSendDialog.tsx?raw';
import { buildDefaultInvoiceMessage } from '../invoices/InvoiceSendDialog';

/**
 * DOC-EMAIL-001 — the send dialogs stop writing the letter.
 *
 * They used to compose a paragraph carrying the amount, the due date and the link, and
 * the backend rendered a document underneath saying the same thing. The owner's words:
 * remove it. What the operator types is now the only prose in the email, and it arrives
 * as a note from them.
 */
describe('email goes without a composed paragraph', () => {
    const opts = {
        invoiceNumber: 'INVOICE J-1516-1',
        name: 'Dana',
        url: 'https://app.albusto.com/pay/abc',
        balanceDue: 210.7,
        total: 210.7,
        dueDate: '2026-08-23',
        signOff: 'Dana',
        timeZone: 'America/New_York',
    };

    it('composes nothing for an invoice email', () => {
        expect(buildDefaultInvoiceMessage('email', opts)).toBe('');
    });

    it('still writes the text message, which has no document behind it', () => {
        const sms = buildDefaultInvoiceMessage('sms', opts);
        expect(sms).toContain('Dana');
        expect(sms).toContain('$210.70');
        expect(sms).toContain(opts.url);
    });

    it('says the number once — short, through the shared rule', () => {
        expect(buildDefaultInvoiceMessage('sms', opts)).toContain('invoice J-1516-1');
        expect(buildDefaultInvoiceMessage('sms', opts)).not.toContain('INVOICE J-1516-1');
        for (const source of [invoiceRaw, estimateRaw]) {
            expect(source).toContain('shortDocNumber');
            expect(source).not.toMatch(/replace\(\/\^\(\?:INVOICE\|ESTIMATE\)/);
        }
    });

    it('leaves the estimate email empty too', () => {
        // Its letter is a document now — price, items, approve button, sign-off.
        expect(estimateRaw).toContain("     * Email gets NO default");
        expect(estimateRaw).not.toContain("Thanks so much for the opportunity");
    });
});

describe('an empty message must not block the send', () => {
    it('requires a message only where the message IS the send', () => {
        // The estimate dialog used to mark it required outright; with no default that
        // would have made the letter unsendable.
        expect(estimateRaw).toContain("const messageSatisfied = channel === 'sms' ? message.trim().length > 0 : true;");
        expect(estimateRaw).not.toContain('recipient.trim().length > 0 && message.trim().length > 0');
    });

    it('tells the operator what the field is for', () => {
        expect(estimateRaw).toContain('it arrives as a note from you');
        expect(invoiceRaw).toContain('label="Message (optional)"');
    });
});
