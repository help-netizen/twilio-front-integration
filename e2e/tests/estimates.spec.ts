import { expect, test } from '../fixtures/test';
import { ApiClient, type CleanupEntity } from '../fixtures/api';
import { hasAdmin, JOBS_NATIVE, JOBS_BLOCKED_REASON } from '../fixtures/env';
import { JobPanel } from '../pages/JobPanel';
import { JobsPage } from '../pages/JobsPage';

test.describe('@suite:estimates', () => {
    test.skip(!hasAdmin(), 'requires E2E_ADMIN_USER / E2E_ADMIN_PASS');
    test.skip(!JOBS_NATIVE, JOBS_BLOCKED_REASON);

    test('@p0 EST-01 create estimate with a custom item on a job', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const job = await api.createJob({ label: 'EST-01 Job' });
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
            );
            const marker = ApiClient.runName('EST-01 Estimate');

            await new JobsPage(page).openJob(job.id, job.marker);
            const panel = new JobPanel(page);
            await panel.expectLoaded(job.marker);
            const editor = await panel.createEstimate();
            await editor.addSummary(marker);
            await editor.addCustomItem(`${marker} item`, '125.00');
            await editor.saveEstimate();

            await expect(panel.estimateSection).toContainText(marker);
            await expect(panel.estimateSection).toContainText('draft');
            await expect(panel.estimateSection).toContainText('$125.00');
            await panel.openEstimate(marker);
            await editor.addDetailCustomItem(`${marker} detail item`, '25.00');
            await expect(page.getByText('$150.00', { exact: true }).last()).toBeVisible();
            const estimate = await api.findEstimate(job.id, marker);
            expect(estimate).toBeDefined();
            if (estimate?.id) cleanup.push({ type: 'estimate', id: Number(estimate.id) });
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });

    test('@p0 EST-04 approve estimate and expose Create Invoice without closing', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const job = await api.createJob({ label: 'EST-04 Job' });
            const estimate = await api.createEstimate(job.id, 'EST-04 Estimate', 175);
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
                { type: 'estimate', id: estimate.id },
            );

            await new JobsPage(page).openJob(job.id, job.marker);
            const panel = new JobPanel(page);
            await panel.openEstimate(estimate.marker);
            await panel.estimateEditor.approveOpenEstimate();

            const approved = await api.getEstimate(estimate.id);
            expect(approved.status).toBe('approved');
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });
});
