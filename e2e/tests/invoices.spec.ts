import { expect, test } from '../fixtures/test';
import { ApiClient, type CleanupEntity } from '../fixtures/api';
import {
    CAN_DISPATCH_DOCUMENTS, DISPATCH_BLOCKED_REASON,
    hasAdmin, JOBS_NATIVE, JOBS_BLOCKED_REASON,
} from '../fixtures/env';
import { JobPanel } from '../pages/JobPanel';
import { JobsPage } from '../pages/JobsPage';
import { InvoicesPage } from '../pages/InvoicesPage';

test.describe('@suite:invoices', () => {
    test.skip(!hasAdmin(), 'requires E2E_ADMIN_USER / E2E_ADMIN_PASS');
    test.skip(!JOBS_NATIVE, JOBS_BLOCKED_REASON);

    test('@p0 INV-01 create invoice and calculate balance due', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const job = await api.createJob({ label: 'INV-01 Job' });
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
            );
            const marker = ApiClient.runName('INV-01 Invoice item');

            await new JobsPage(page).openJob(job.id, job.marker);
            const panel = new JobPanel(page);
            const editor = await panel.createInvoice();
            await editor.addCustomItem(marker, '125.00');
            await editor.createInvoice();
            await panel.openOnlyInvoice();
            await expect(page.getByText(marker, { exact: true })).toBeVisible();
            await editor.expectDraftTotals('$125.00');

            const invoice = await api.findInvoice(job.id, marker);
            expect(invoice).toBeDefined();
            if (invoice?.id) cleanup.push({ type: 'invoice', id: Number(invoice.id) });
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });

    test('@p0 INV-OB70-01 remove an unpaid invoice from active finance and retain its Void history row', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const job = await api.createJob({ label: 'INV-OB70-01 Job' });
            const invoice = await api.createInvoice(job.id, 'INV-OB70-01 Invoice', 125);
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
                { type: 'invoice', id: invoice.id },
            );

            const invoices = new InvoicesPage(page);
            await invoices.goto();
            const removal = await invoices.openRemovalFromListRow(invoice.invoiceNumber);
            await expect(removal.reapply).toHaveCount(0);
            await removal.submit();

            // OB-70's final owner decision is audit-safe voiding, not hard deletion:
            // the row remains readable while active finance excludes it.
            await invoices.expectStatus(invoice.invoiceNumber, 'void');
            const removed = await api.getInvoice(invoice.id);
            expect(removed.status).toBe('void');
            const finance = await api.getJobFinance(job.id);
            expect(Number(finance.invoiced)).toBe(0);
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });

    test('@p0 INV-OB70-02 paid removal leaves the money as job credit', async ({ page }) => {
        test.skip(!CAN_DISPATCH_DOCUMENTS, DISPATCH_BLOCKED_REASON);
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const job = await api.createJob({ label: 'INV-OB70-02 Job' });
            const invoice = await api.createInvoice(job.id, 'INV-OB70-02 Invoice', 200);
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
                { type: 'invoice', id: invoice.id },
            );
            await api.issueInvoice(invoice.id, job.contact.email);
            await api.recordInvoicePayment(invoice.id, { amount: 50, method: 'cash' });

            const invoices = new InvoicesPage(page);
            const detail = await invoices.openInvoice(invoice.id, invoice.invoiceNumber);
            const removal = await detail.openRemoveConfirm(invoice.invoiceNumber);
            await removal.expectPaidCreditCopy('$50.00');
            await expect(removal.reapply).toHaveCount(0);
            await removal.submit();

            await new JobsPage(page).openJob(job.id, job.marker);
            await new JobPanel(page).expectJobCredit('$50.00');
            const finance = await api.getJobFinance(job.id);
            expect(Number(finance.paid)).toBe(50);
            expect(Number(finance.due)).toBe(-50);
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });

    test('@p1 INV-OB70-03 paid removal can re-apply the money to a candidate invoice', async ({ page }) => {
        test.skip(!CAN_DISPATCH_DOCUMENTS, DISPATCH_BLOCKED_REASON);
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const job = await api.createJob({ label: 'INV-OB70-03 Job' });
            const candidate = await api.createInvoice(job.id, 'INV-OB70-03 Candidate', 120);
            const source = await api.createInvoice(job.id, 'INV-OB70-03 Source', 200);
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
                { type: 'invoice', id: candidate.id },
                { type: 'invoice', id: source.id },
            );
            await api.issueInvoice(source.id, job.contact.email);
            await api.recordInvoicePayment(source.id, { amount: 50, method: 'cash' });

            const invoices = new InvoicesPage(page);
            const detail = await invoices.openInvoice(source.id, source.invoiceNumber);
            const removal = await detail.openRemoveConfirm(source.invoiceNumber);
            await removal.expectPaidCreditCopy('$50.00');
            await removal.chooseReapply(candidate.invoiceNumber, '$50.00');
            await removal.submit();

            await invoices.openInvoice(candidate.id, candidate.invoiceNumber);
            await detail.expectPaymentSummary('$50.00', '$70.00');
            const moved = await api.getInvoice(candidate.id);
            expect(Number(moved.amount_paid)).toBe(50);
            expect(Number(moved.balance_due)).toBe(70);
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });

    test('@p0 INV-OB69-01 percentage discount survives invoice create, edit, and reload', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const job = await api.createJob({ label: 'INV-OB69-01 Job' });
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
            );
            const itemMarker = ApiClient.runName('INV-OB69-01 Item');

            await new JobsPage(page).openJob(job.id, job.marker);
            const create = await new JobPanel(page).createInvoice();
            await create.addCustomItem(itemMarker, '200.00');
            await create.setPercentageDiscount('10');
            await create.expectTotal('$180.00');
            await create.createInvoice();

            await expect.poll(async () => Number((await api.findInvoice(job.id, itemMarker))?.id || 0))
                .not.toBe(0);
            const created = await api.findInvoice(job.id, itemMarker);
            const invoiceId = Number(created?.id);
            const invoiceNumber = String(created?.invoice_number || '');
            cleanup.push({ type: 'invoice', id: invoiceId });

            const invoices = new InvoicesPage(page);
            await invoices.goto();
            const edit = await invoices.editFromListRow(invoiceNumber);
            await edit.expectPercentageDiscount('10');
            await edit.expectTotal('$180.00');
            await edit.setPercentageDiscount('25');
            await edit.expectTotal('$150.00');
            await edit.saveInvoice();

            await page.reload();
            const detail = await invoices.openInvoice(invoiceId, invoiceNumber);
            await detail.expectPercentageDiscount('25', '$150.00');
            const saved = await api.getInvoice(invoiceId);
            expect(saved.discount_type).toBe('percentage');
            expect(Number(saved.discount_value)).toBe(25);
            expect(Number(saved.total)).toBe(150);
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });
});
