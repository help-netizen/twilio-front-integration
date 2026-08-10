import { expect, test } from '../fixtures/test';
import { ApiClient, type CleanupEntity } from '../fixtures/api';
import { hasAdmin, JOBS_NATIVE, JOBS_BLOCKED_REASON } from '../fixtures/env';
import { JobPanel } from '../pages/JobPanel';
import { JobsPage } from '../pages/JobsPage';
import { SchedulePage } from '../pages/SchedulePage';

function jobIdFromUrl(url: string): number {
    const match = url.match(/\/jobs\/(\d+)/);
    if (!match) throw new Error(`Expected a /jobs/:id URL, received ${url}`);
    return Number(match[1]);
}

function assignedIds(job: Awaited<ReturnType<ApiClient['getJob']>>): string[] {
    return (job.assigned_techs || []).map((tech) => String(tech.id)).sort();
}

test.describe('@suite:schedule', () => {
    test.skip(!hasAdmin(), 'requires E2E_ADMIN_USER / E2E_ADMIN_PASS');
    test.skip(!JOBS_NATIVE, JOBS_BLOCKED_REASON);

    test('@p0 SCH-01 schedule a new job with the slot picker', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            await api.fetchTechs(1);
            const contact = await api.createContact('SCH-01 Customer');
            cleanup.push({ type: 'contact', id: contact.id }, { type: 'lead', id: contact.leadUuid });

            const schedule = new SchedulePage(page);
            await schedule.goto();
            const modal = await schedule.openNewJob();
            await modal.fillAndSubmit({
                contactMarker: contact.name,
                description: `${ApiClient.runName('SCH-01')} scheduled through slot picker`,
            });

            await expect(page).toHaveURL(/\/jobs\/\d+$/);
            const jobId = jobIdFromUrl(page.url());
            cleanup.push({ type: 'job', id: jobId });
            const created = await api.getJob(jobId);
            expect(created.start_date).toBeTruthy();

            await schedule.goto();
            await schedule.findScheduled(
                contact.name,
                undefined,
                created.start_date || undefined,
                String(jobId).padStart(6, '0'),
            );
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });

    test('@p0 SCH-02 assign a technician and show the job in that schedule lane', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];
        let provisionedUserIds: string[] = [];

        try {
            const provisioned = await api.provisionTechnicians(2);
            provisionedUserIds = provisioned.userIdsToRestore;
            const [techA] = provisioned.technicians;
            const job = await api.createJob({ label: 'SCH-02 Job' });
            await api.reassignJob(job.id, []);
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
            );

            await new JobsPage(page).openJob(job.id, job.marker);
            await new JobPanel(page).replaceTechnicians([], techA.name);
            await expect.poll(async () => assignedIds(await api.getJob(job.id))).toEqual([techA.id]);

            const updated = await api.getJob(job.id);
            const schedule = new SchedulePage(page);
            await schedule.goto();
            await schedule.findScheduled(job.marker, techA.name, updated.start_date || undefined);
        } finally {
            await api.cleanup(cleanup);
            await api.restoreProvisionedTechnicians(provisionedUserIds);
            await api.dispose();
        }
    });

    test('@p0 SCH-03 reschedule to a different slot without changing technician', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const [techA] = await api.fetchTechs(1);
            const job = await api.createJob({ label: 'SCH-03 Job' });
            await api.reassignJob(job.id, [techA]);
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
            );
            const before = await api.getJob(job.id);

            await new JobsPage(page).openJob(job.id, job.marker);
            await new JobPanel(page).rescheduleToNextDay(techA.name);

            await expect.poll(async () => (await api.getJob(job.id)).start_date).not.toBe(before.start_date);
            const updated = await api.getJob(job.id);
            expect(updated.start_date).not.toBe(before.start_date);
            expect(assignedIds(updated)).toEqual([techA.id]);

            const schedule = new SchedulePage(page);
            await schedule.goto();
            await schedule.findScheduled(job.marker, techA.name, updated.start_date || undefined);
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });

    test('@p0 SCH-04 reassign replaces technician A with technician B', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];
        let provisionedUserIds: string[] = [];

        try {
            const provisioned = await api.provisionTechnicians(2);
            provisionedUserIds = provisioned.userIdsToRestore;
            const [techA, techB] = provisioned.technicians;
            const job = await api.createJob({ label: 'SCH-04 Job' });
            await api.reassignJob(job.id, [techA]);
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
            );

            await new JobsPage(page).openJob(job.id, job.marker);
            await new JobPanel(page).replaceTechnicians([techA.name], techB.name);
            await expect.poll(async () => assignedIds(await api.getJob(job.id))).toEqual([techB.id]);

            const updated = await api.getJob(job.id);
            const schedule = new SchedulePage(page);
            await schedule.goto();
            await schedule.findScheduled(job.marker, techB.name, updated.start_date || undefined);
        } finally {
            await api.cleanup(cleanup);
            await api.restoreProvisionedTechnicians(provisionedUserIds);
            await api.dispose();
        }
    });
});
