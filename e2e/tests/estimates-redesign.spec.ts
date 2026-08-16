import { expect, test } from '../fixtures/test';
import { ApiClient, type CleanupEntity } from '../fixtures/api';
import { hasAdmin, JOBS_NATIVE, JOBS_BLOCKED_REASON } from '../fixtures/env';

/**
 * ESTIMATE-REDESIGN-001 — the behaviours the rebuild exists for.
 *
 * `estimates.spec.ts` covers the pre-existing flows and P1's customer answer.
 * These are P2–P5: the shortcut that records a verbal yes, the undo that makes
 * offering it honest, the save that used to delete line items, the link that
 * used to live forever, and the page that could not create the thing it is about.
 */
test.describe('@suite:estimates', () => {
    test.skip(!hasAdmin(), 'requires E2E_ADMIN_USER / E2E_ADMIN_PASS');
    test.skip(!JOBS_NATIVE, JOBS_BLOCKED_REASON);

    /**
     * P2 — the yes happens out loud, in the customer's kitchen. Recording it
     * used to cost three taps and two status changes because the conversion
     * refused anything but `approved`, so dispatchers routed around it.
     */
    test('@p0 EST-P2-01 a draft becomes an invoice in one action, and is marked approved', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];
        try {
            const job = await api.createJob({ label: 'EST-P2-01 Job' });
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
            );
            const estimate = await api.createEstimate(job.id, 'EST-P2-01 Estimate');
            expect((await api.getEstimate(estimate.id)).status).toBe('draft');

            const invoice = await api.convertEstimate(estimate.id);
            const invoiceId = Number((invoice as { id: number }).id);
            cleanup.push({ type: 'invoice', id: invoiceId });

            const after = await api.getEstimate(estimate.id);
            expect(after.status).toBe('approved');
            expect(Number(after.invoice_id)).toBe(invoiceId);

            // Converting again must open the same invoice, never make a second.
            const again = await api.convertEstimate(estimate.id);
            expect(Number((again as { id: number }).id)).toBe(invoiceId);
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });

    /** P2 — Undo replaces a confirmation dialog, so it has to actually work. */
    test('@p0 EST-P2-02 undo removes the invoice and restores the estimate', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];
        try {
            const job = await api.createJob({ label: 'EST-P2-02 Job' });
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
            );
            const estimate = await api.createEstimate(job.id, 'EST-P2-02 Estimate');
            const invoice = await api.convertEstimate(estimate.id);
            const invoiceId = Number((invoice as { id: number }).id);

            await api.undoEstimateConversion(estimate.id, invoiceId);

            const after = await api.getEstimate(estimate.id);
            expect(after.invoice_id ?? null).toBeNull();
            expect(after.status).toBe('draft');
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });

    /**
     * P3 — the bug that deleted work in silence. A list row carries no line
     * items, and saving from it replaced the real ones with nothing.
     */
    test('@p0 EST-P3-01 saving without an items key keeps the line items', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];
        try {
            const job = await api.createJob({ label: 'EST-P3-01 Job' });
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
            );
            const estimate = await api.createEstimate(job.id, 'EST-P3-01 Estimate');
            const before = await api.getEstimate(estimate.id);
            const itemCount = Array.isArray(before.items) ? before.items.length : 0;
            expect(itemCount).toBeGreaterThan(0);

            // Exactly what list-row Edit used to send: a save with no `items`.
            await api.updateEstimate(estimate.id, { summary: 'Edited from a list row' });

            const after = await api.getEstimate(estimate.id);
            expect(Array.isArray(after.items) ? after.items.length : 0).toBe(itemCount);
            expect(after.summary).toBe('Edited from a list row');
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });

    /**
     * P5 — a live link must stop being live the moment the document behind it
     * stops being the one that was sent.
     *
     * Editing a non-draft estimate returns it to draft (existing behaviour, kept
     * deliberately — spec §2.12). From that moment the customer's link must go
     * dark: the page they hold no longer matches what we would stand behind, and
     * a stale price left readable is worse than a dead link.
     *
     * Rotation-on-send is asserted at the unit level (`sendDocEstimate.test.js`),
     * because dispatching a real estimate needs a connected mailbox that a test
     * run must not depend on.
     */
    test('@p0 EST-P5-01 a link stops reading once the estimate is edited back to draft', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];
        try {
            const job = await api.createJob({ label: 'EST-P5-01 Job' });
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
            );
            const estimate = await api.createEstimate(job.id, 'EST-P5-01 Estimate');
            await api.prepareEstimateAsSent(estimate.id);

            const token = (await api.ensureEstimatePublicLink(estimate.id)).split('/').pop() as string;
            expect((await api.readPublicEstimate(token)).status).toBe(200);

            // Any edit to a sent estimate returns it to draft…
            await api.updateEstimate(estimate.id, { summary: 'Repriced after a call' });
            expect((await api.getEstimate(estimate.id)).status).toBe('draft');

            // …and the link the customer is holding goes dark, with the same
            // generic 404 a wrong token gets — never a hint that it exists.
            expect((await api.readPublicEstimate(token)).status).toBe(404);
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });

    /** P5 — a draft was never shown to anyone, so its link must not read. */
    test('@p1 EST-P5-02 a draft estimate is not readable by link', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];
        try {
            const job = await api.createJob({ label: 'EST-P5-02 Job' });
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
            );
            const estimate = await api.createEstimate(job.id, 'EST-P5-02 Estimate');
            const token = (await api.ensureEstimatePublicLink(estimate.id)).split('/').pop() as string;

            const read = await api.readPublicEstimate(token);
            expect(read.status).toBe(404);
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });

    /** P4 — the one page about estimates could not create one. */
    test('@p1 EST-P4-01 an estimate can be created from the estimates page', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        try {
            await page.goto('/estimates');
            const create = page.getByTestId('estimate-new');
            await expect(create).toBeVisible({ timeout: 20_000 });
            await create.click();
            await expect(page.getByRole('dialog')).toBeVisible();
        } finally {
            await api.dispose();
        }
    });

    /** P4 — rows, and the status that carries how long it has been waiting. */
    test('@p1 EST-P4-02 the list renders rows with a plain-language status', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];
        try {
            const job = await api.createJob({ label: 'EST-P4-02 Job' });
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
            );
            const estimate = await api.createEstimate(job.id, 'EST-P4-02 Estimate');

            await page.goto('/estimates');
            const row = page.getByTestId(`estimate-row-${estimate.id}`);
            await expect(row).toBeVisible({ timeout: 20_000 });
            await expect(row).toContainText('Draft · not sent');

            // Opening the row IS the action — there is no per-row menu to hunt in.
            await row.click();
            await expect(page.getByTestId('estimate-total')).toBeVisible();
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });
});
