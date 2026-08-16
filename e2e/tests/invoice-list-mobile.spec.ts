import { expect, test } from '../fixtures/test';
import { ApiClient, type CleanupEntity, type CreatedInvoice } from '../fixtures/api';
import { hasAdmin, JOBS_BLOCKED_REASON, JOBS_NATIVE } from '../fixtures/env';
import { InvoicesPage } from '../pages/InvoicesPage';

test.describe('@suite:invoice-redesign mobile list', () => {
    test.skip(!hasAdmin(), 'requires E2E_ADMIN_USER / E2E_ADMIN_PASS');
    test.skip(!JOBS_NATIVE, JOBS_BLOCKED_REASON);

    test('@p1 list-mobile renders tappable rows and offset Load more', async ({ page }) => {
        test.setTimeout(180_000);
        await page.setViewportSize({ width: 390, height: 844 });
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const batchMarker = ApiClient.runName('Invoice mobile list batch');
            const job = await api.createJob({ label: batchMarker });
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
            );

            const seeded: CreatedInvoice[] = [];
            for (let index = 0; index < 51; index += 1) {
                const invoice = await api.createInvoice(
                    job.id,
                    `${batchMarker} ${String(index + 1).padStart(2, '0')}`,
                    10,
                );
                seeded.push(invoice);
                cleanup.push({ type: 'invoice', id: invoice.id });
            }

            const invoices = new InvoicesPage(page);
            await invoices.goto();
            await invoices.mobileSearch.fill(batchMarker);
            await expect(invoices.rows).toHaveCount(50);

            // Newest first: the last invoice seeded heads the list, and the one
            // seeded first is the single row that page two brings in.
            const newest = seeded[seeded.length - 1];
            const oldest = seeded[0];

            const first = invoices.row(newest.invoiceNumber);
            await expect(first).toHaveAttribute('aria-label', `Open ${newest.invoiceNumber}`);
            await expect(first.getByText('Draft', { exact: true })).toBeVisible();
            await expect(first.getByText('$10.00', { exact: true })).toBeVisible();
            await expect(invoices.row(oldest.invoiceNumber)).toHaveCount(0);
            await expect(invoices.loadMore).toBeVisible();

            await invoices.loadMore.click();
            await expect(invoices.rows).toHaveCount(51);
            await expect(invoices.row(oldest.invoiceNumber)).toBeVisible();
            await invoices.openMobileRow(oldest.invoiceNumber);
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });
});
