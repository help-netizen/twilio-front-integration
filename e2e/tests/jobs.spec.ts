import { expect, test } from '../fixtures/test';
import { ApiClient, type CleanupEntity } from '../fixtures/api';
import { hasAdmin, JOBS_NATIVE, JOBS_BLOCKED_REASON } from '../fixtures/env';
import { JobsPage } from '../pages/JobsPage';
import { JobPanel } from '../pages/JobPanel';

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

    // FSM-SYSTEM-TRANSITIONS-001: "On the way" is a system status whose behaviour lives
    // on the STATE (blanc:op="arrival_eta"). Entering it must (1) apply as a plain
    // transition immediately, (2) then open the notify-only ETA modal, (3) NOT revert
    // when the modal is dismissed, and (4) reflect on the open card WITHOUT a reload
    // (the FSM apply now broadcasts SSE + the initiating click refetches).
    // Precondition: the admin has messages.send (the modal is gated on it).
    test('@p0 JOB-06 On the way — plain transition, notify-only modal, live card update', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const job = await api.createJob({ label: 'JOB-06 Job' });
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
            );

            const before = await api.getJob(job.id);
            expect(before.blanc_status).not.toBe('On the way');

            await new JobsPage(page).openJob(job.id, job.marker);
            const panel = new JobPanel(page);
            await panel.expectLoaded(job.marker);

            // "On the way" renders as a prominent FSM action button from this state.
            await expect(panel.statusButton('On the way')).toBeVisible();

            // Click it: transition applies plainly, THEN the notify-only ETA modal opens.
            await panel.goOnTheWay();

            // The transition fired immediately (before any notify) — status is On the way.
            await expect.poll(async () => (await api.getJob(job.id)).blanc_status).toBe('On the way');

            // Dismiss WITHOUT notifying — the status must stay On the way.
            await panel.closeEtaModal();

            // The open card reflects the new status live — no reload (SSE + initiator refetch).
            await expect(panel.statusButton('On the way')).toBeVisible();

            // …and it stayed On the way on the server (close ≠ revert).
            await expect.poll(async () => (await api.getJob(job.id)).blanc_status).toBe('On the way');
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });
});
