import { expect, test } from '../fixtures/test';
import { ApiClient, type CleanupEntity } from '../fixtures/api';
import { hasAdmin, JOBS_NATIVE, JOBS_BLOCKED_REASON } from '../fixtures/env';
import { JobsPage } from '../pages/JobsPage';

function jobIdFromUrl(url: string): number {
    const match = url.match(/\/jobs\/(\d+)/);
    if (!match) throw new Error(`Expected a /jobs/:id URL, received ${url}`);
    return Number(match[1]);
}

test.describe('@suite:jobs', () => {
    test.skip(!hasAdmin(), 'requires E2E_ADMIN_USER / E2E_ADMIN_PASS');
    test.skip(!JOBS_NATIVE, JOBS_BLOCKED_REASON);

    test('@p0 JOB-01 create job for an API-seeded contact', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const contact = await api.createContact('JOB-01 Customer');
            cleanup.push({ type: 'contact', id: contact.id }, { type: 'lead', id: contact.leadUuid });

            const marker = ApiClient.runName('JOB-01');
            const jobs = new JobsPage(page);
            await jobs.goto();
            const modal = await jobs.openNewJob();
            await modal.fillAndSubmit({ contactMarker: contact.name, description: `${marker} description` });

            await expect(page).toHaveURL(/\/jobs\/\d+$/);
            const jobId = jobIdFromUrl(page.url());
            cleanup.push({ type: 'job', id: jobId });
            await expect(page.getByText(/^Job created/)).toBeVisible();
            await expect(page.getByText(contact.name, { exact: false }).first()).toBeVisible();
            await expect(page.getByText(`${marker} description`, { exact: true }).last()).toBeVisible();

            await jobs.goto();
            const row = await jobs.searchFor(contact.name);
            await expect(row).toContainText(`${contact.name}, New York`);
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });
});
