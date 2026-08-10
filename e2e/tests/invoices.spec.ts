import { expect, test } from '../fixtures/test';
import { ApiClient, type CleanupEntity } from '../fixtures/api';
import { hasAdmin, JOBS_NATIVE, JOBS_BLOCKED_REASON } from '../fixtures/env';
import { JobPanel } from '../pages/JobPanel';
import { JobsPage } from '../pages/JobsPage';

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
});
