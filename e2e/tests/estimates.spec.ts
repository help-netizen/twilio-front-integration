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

            // A draft's primary action is Send — approving is what you do to an
            // estimate the customer has actually seen (ESTIMATE-REDESIGN-001
            // §2.2). Recording a yes on a draft is done by invoicing it, which
            // EST-P2-01 covers; this case is the ordinary path.
            await api.prepareEstimateAsSent(estimate.id);

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

    test('@p0 EST-OB69-01 percentage discount survives estimate create, edit, and reload', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const job = await api.createJob({ label: 'EST-OB69-01 Job' });
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
            );
            const marker = ApiClient.runName('EST-OB69-01 Estimate');

            await new JobsPage(page).openJob(job.id, job.marker);
            const panel = new JobPanel(page);
            const editor = await panel.createEstimate();
            await editor.addSummary(marker);
            await editor.addCustomItem(`${marker} item`, '200.00');
            await editor.setPercentageDiscount('10');
            await editor.expectEditorTotal('$180.00');
            await editor.saveEstimate();

            await expect.poll(async () => Number((await api.findEstimate(job.id, marker))?.id || 0))
                .not.toBe(0);
            const created = await api.findEstimate(job.id, marker);
            const estimateId = Number(created?.id);
            cleanup.push({ type: 'estimate', id: estimateId });

            await panel.openEstimate(marker);
            await editor.expectDetailPercentageDiscount('10', '$180.00');

            // Change the discount to 25% through the SAME PUT /api/estimates/:id the detail
            // panel calls on blur. Playwright cannot reliably drive that inline-blur control;
            // the full UI discount edit+reload round-trip is covered by INV-OB69 (invoice
            // editor), and the endpoint's persist+recalculate is exercised directly here.
            await api.updateEstimate(estimateId, { discount_type: 'percentage', discount_value: 25 });
            await expect.poll(async () => Number((await api.getEstimate(estimateId)).discount_value))
                .toBe(25);

            await page.reload();
            await panel.expectLoaded(job.marker);
            await panel.openEstimate(marker);
            await editor.expectDetailPercentageDiscount('25', '$150.00');
            const saved = await api.getEstimate(estimateId);
            expect(saved.discount_type).toBe('percentage');
            expect(Number(saved.discount_value)).toBe(25);
            expect(Number(saved.total)).toBe(150);
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });

    test('@p0 EST-P1-01 customer approves from the public estimate link', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const job = await api.createJob({ label: 'EST-P1-01 Job' });
            const estimate = await api.createEstimate(job.id, 'EST-P1-01 Estimate', 185);
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
                { type: 'estimate', id: estimate.id },
            );
            await api.prepareEstimateAsSent(estimate.id);
            const publicUrl = await api.ensureEstimatePublicLink(estimate.id);
            const publicPath = new URL(publicUrl, 'http://albusto.local').pathname;

            await page.goto(publicPath);
            await page.getByTestId('public-estimate-approve').click();

            await expect.poll(async () => (await api.getEstimate(estimate.id)).status)
                .toBe('approved');
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });

    test('@p0 EST-P1-02 customer decline creates dispatcher follow-up work', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const job = await api.createJob({ label: 'EST-P1-02 Job' });
            const estimate = await api.createEstimate(job.id, 'EST-P1-02 Estimate', 245);
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
                { type: 'estimate', id: estimate.id },
            );
            await api.prepareEstimateAsSent(estimate.id);
            const detail = await api.getEstimate(estimate.id);
            const shortNumber = String(detail.estimate_number || estimate.id)
                .replace(/^ESTIMATE\s+/i, '');
            const taskTitle = `Estimate #${shortNumber} declined — win it back`;
            const comment = ApiClient.runName('EST-P1-02 price objection');
            const publicUrl = await api.ensureEstimatePublicLink(estimate.id);
            const publicPath = new URL(publicUrl, 'http://albusto.local').pathname;

            await page.goto(publicPath);
            await page.getByTestId('public-estimate-decline').click();
            await page.getByTestId('public-estimate-decline-reason-price').click();
            await page.getByTestId('public-estimate-decline-comment').fill(comment);
            await page.getByTestId('public-estimate-decline-submit').click();

            await expect.poll(async () => (await api.getEstimate(estimate.id)).status)
                .toBe('declined');
            await expect.poll(async () => Boolean(await api.findTask(taskTitle))).toBe(true);
            const createdTask = await api.findTask(taskTitle);
            expect(createdTask?.marker).toContain(taskTitle);
            if (createdTask) cleanup.push({ type: 'task', id: createdTask.id });
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });

    test('@p0 EST-P1-03 double approval is idempotent', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const job = await api.createJob({ label: 'EST-P1-03 Job' });
            const estimate = await api.createEstimate(job.id, 'EST-P1-03 Estimate', 315);
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
                { type: 'estimate', id: estimate.id },
            );
            await api.prepareEstimateAsSent(estimate.id);
            const publicUrl = await api.ensureEstimatePublicLink(estimate.id);
            const token = new URL(publicUrl, 'http://albusto.local').pathname.split('/').pop();
            if (!token) throw new Error('Estimate public link had no token');
            const endpoint = `/api/public/estimates/${encodeURIComponent(token)}/approve`;

            const [first, second] = await Promise.all([
                page.request.post(endpoint),
                page.request.post(endpoint),
            ]);
            expect(first.status()).toBe(200);
            expect(second.status()).toBe(200);
            expect((await first.json()).data.status).toBe('approved');
            expect((await second.json()).data.status).toBe('approved');
            await expect.poll(async () => (await api.getEstimate(estimate.id)).status)
                .toBe('approved');

            const events = await api.getEstimateEvents(estimate.id);
            expect(events.filter(event => event.event_type === 'approved')).toHaveLength(1);
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });
});
