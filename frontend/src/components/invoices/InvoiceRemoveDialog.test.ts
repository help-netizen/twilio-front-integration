import { describe, expect, it } from 'vitest';
import dialogRaw from './InvoiceRemoveDialog.tsx?raw';
import panelRaw from './InvoiceDetailPanel.tsx?raw';
import listRaw from '../../pages/InvoicesPage.tsx?raw';
import apiRaw from '../../services/invoicesApi.ts?raw';

/**
 * OB-70 — removing an invoice must not lose the money, and must not lie about it.
 *
 * The bug that started this: a draft that had taken a card payment offered "Void" and the
 * server answered "Draft invoices must be deleted, not voided". Two actions, two copies of
 * the same confirm on two surfaces, and no path at all for a paid invoice.
 */
describe('one removal, on every surface that offers it', () => {
    it('leaves no Delete-draft / Void-invoice pair behind', () => {
        // The labels, not the word — the comment that explains why they went is welcome.
        for (const source of [panelRaw, listRaw]) {
            expect(source).not.toMatch(/label: 'Delete draft'|>Delete draft</);
            expect(source).not.toMatch(/label: 'Void invoice'|>Void invoice</);
        }
        expect(panelRaw).toMatch(/label: 'Remove invoice'/);
        expect(listRaw).toContain('>Remove invoice</DropdownMenuItem>');
    });

    it('sends both surfaces through the one dialog', () => {
        expect(panelRaw).toContain('<InvoiceRemoveDialog');
        expect(listRaw).toContain('<InvoiceRemoveDialog');
        // ...and neither keeps a private copy of the confirm.
        expect(panelRaw).not.toContain('<InvoiceConfirmDialog');
        expect(listRaw).not.toContain('<InvoiceConfirmDialog');
    });

    it('asks one capability, not two', () => {
        expect(panelRaw).toContain('capabilities.canRemove');
        expect(listRaw).toContain('capabilities.canRemove');
        for (const source of [panelRaw, listRaw]) {
            expect(source).not.toContain('canDelete');
            expect(source).not.toContain('canVoid ');
        }
    });
});

describe('the confirm tells the truth about the money', () => {
    it('asks the server before it promises anything', () => {
        // A confirm that cannot name the figure is not a confirm: the dialog fetches the
        // preview on open and renders a loading line until it has it.
        expect(dialogRaw).toContain('previewInvoiceRemoval(invoice.id)');
        expect(dialogRaw).toContain('Checking what is paid on it');
    });

    it('names the amount, never "the payments"', () => {
        expect(dialogRaw).toContain('{money(preview.payments_total)}');
        expect(dialogRaw).toContain('stays on the job as credit');
    });

    it('never re-applies money unless the dispatcher ticked the box', () => {
        // Owner, 19.08: always ask, even when exactly one invoice matches. Default OFF,
        // and the request carries the answer — the server picks nothing.
        expect(dialogRaw).toContain('useState(false)');
        expect(dialogRaw).toContain("payment_action: target ? 'apply' : 'leave_unapplied'");
        expect(dialogRaw).toContain('const target = reapply ? candidate : null;');
    });

    it('says the word once — the number is printed short', () => {
        // Stored numbers carry the word inside them ("INVOICE 1668-2"), so a sentence
        // that says "invoice" must print the short form or it reads "Remove invoice
        // INVOICE 1668-2?" — which is what the staging audit found. One rule, shared
        // with the backend's utils/docNumber.js.
        expect(dialogRaw).toContain('shortDocNumber(invoice.invoice_number)');
        expect(dialogRaw).toContain('shortDocNumber(candidate.invoice_number)');
        expect(dialogRaw).toContain('shortDocNumber(target.invoice_number)');
        expect(dialogRaw).not.toMatch(/\{invoice\.invoice_number\}\?/);
    });

    it('offers the choice only when there is money to move', () => {
        expect(dialogRaw).toContain('const candidate = paid > 0 ? preview?.candidate ?? null : null;');
    });

    it('survives a double tap and a stale preview', () => {
        // One request id per opening, and the preview version travels back so a server
        // that has since changed refuses instead of acting on an old picture.
        expect(dialogRaw).toContain('requestId.current');
        expect(dialogRaw).toContain('preview_version: preview.preview_version');
        expect(apiRaw).toContain('preview_version: string');
        expect(apiRaw).toContain('request_id: string');
    });
});

/**
 * After the money is detached, the invoice card says "Amount paid $0.00" while the job
 * says "Paid $462.00". Somebody has to say why.
 */
describe('the card explains money it is not showing', () => {
    it('names the job credit under the totals', () => {
        expect(panelRaw).toContain('Job credit {money(invoice.job_unapplied_credit)} not applied to this invoice');
        expect(panelRaw).toContain('data-testid="invoice-job-credit"');
    });

    it('says nothing when there is nothing to explain', () => {
        // The server sends 0 when this is the job's only active invoice — the figures
        // above already include the money — and an unexplained "credit $0.00" row would
        // be exactly the empty state the design canon forbids.
        expect(panelRaw).toContain("Number(invoice.job_unapplied_credit || 0) > 0 ?");
    });
});

describe('one action, one outcome (owner, 21.08)', () => {
    it('never offers two fates for the record', () => {
        // The UI merged "Delete draft" and "Void invoice" into one action; the split
        // survived underneath and surfaced again as two different promises in this
        // confirm. Removing always voids — the invoice stays readable in the job.
        // The sentence is a constant, not a branch — the comment above it may still
        // explain what the old two-path version said.
        expect(dialogRaw).toMatch(/const fate = 'The invoice itself stays in the job’s history, marked void\.'/);
        expect(dialogRaw).not.toMatch(/disposition === 'deleted'/);
        expect(dialogRaw).not.toMatch(/const fate = preview\?/);
    });
});
