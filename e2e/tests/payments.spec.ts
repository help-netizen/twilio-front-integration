import { expect, test } from '../fixtures/test';
import { ApiClient, type CleanupEntity } from '../fixtures/api';
import { hasAdmin, JOBS_NATIVE, JOBS_BLOCKED_REASON } from '../fixtures/env';

/**
 * Payments — the ledger and the payment card.
 *
 * PAY-01 is a regression test with a scar behind it: a direct link to
 * /payments/:id sat on "Unable to load payment details" in production, because
 * the panel only ever fetched from a row click and the URL was not the source
 * of truth. Nothing in the suite would have caught it — there was no payments
 * spec at all — so this is the gate that keeps that specific failure dead.
 */
test.describe('@suite:payments', () => {
    test.skip(!hasAdmin(), 'requires E2E_ADMIN_USER / E2E_ADMIN_PASS');
    test.skip(!JOBS_NATIVE, JOBS_BLOCKED_REASON);

    test('@p0 PAY-01 a direct link to a payment opens its card', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const job = await api.createJob({ label: 'PAY-01 Job' });
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
            );
            const payment = await api.recordJobPayment(job.id, { amount: 137.5, method: 'cash' });
            const jobRecord = await api.getJob(job.id);

            // Cold navigation — no list, no click, no warmed-up store.
            await page.goto(`/payments/${payment.id}`);

            const card = page.getByTestId('payment-card');
            await expect(card).toBeVisible({ timeout: 20_000 });
            await expect(page.getByTestId('payment-load-error')).toHaveCount(0);
            await expect(page.getByTestId('payment-amount')).toHaveText('$137.50');
            await expect(page.getByTestId('payment-job-title'))
                .toContainText(`Job #${String(jobRecord.job_number ?? '')}`);
            await expect(page.getByTestId('payment-status')).toBeVisible();
            // The job behind the payment is named, and its customer is on the card.
            await expect(card).toContainText(job.contact.name);
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });

    test('@p1 PAY-02 a row click opens the card and puts it in the URL', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const job = await api.createJob({ label: 'PAY-02 Job' });
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
            );
            const payment = await api.recordJobPayment(job.id, { amount: 42, method: 'cash' });

            await page.goto('/payments');
            const row = page.getByTestId(`payment-row-${payment.id}`);
            await expect(row).toBeVisible({ timeout: 20_000 });
            await row.click();

            // Both halves of the fix: the card renders AND the address bar now
            // holds a link that PAY-01 proves is openable.
            await expect(page.getByTestId('payment-card')).toBeVisible();
            await expect(page).toHaveURL(new RegExp(`/payments/${payment.id}$`));
            await expect(page.getByTestId('payment-amount')).toHaveText('$42.00');
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });

    test('@p1 PAY-03 a note written on the payment card lands on the job', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const job = await api.createJob({ label: 'PAY-03 Job' });
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
            );
            const payment = await api.recordJobPayment(job.id, { amount: 88, method: 'cash' });
            const marker = ApiClient.runName('PAY-03 note');

            await page.goto(`/payments/${payment.id}`);
            await expect(page.getByTestId('payment-card')).toBeVisible({ timeout: 20_000 });

            // The composer is the job card's own — the point of the whole card.
            // The panel renders the notes block twice (a `md:hidden` mobile copy
            // and the desktop one), and the hidden copy comes first in the DOM —
            // so ask for the visible one, not the first one.
            await page.getByText('Add note…').filter({ visible: true }).first().click();
            const editor = page.locator('textarea, [contenteditable="true"]').first();
            await editor.fill(marker);
            await page.getByRole('button', { name: /^(Save|Post|Add note)$/i }).first().click();

            await expect(page.getByText(marker).first()).toBeVisible({ timeout: 15_000 });

            // …and it is the JOB's note, not a payment-only one. Polled, because
            // the composer renders the note the moment the write returns and the
            // list read can still be a beat behind it.
            await expect.poll(
                async () => (await api.getJobNotes(job.id)).some(note => note.includes(marker)),
                { timeout: 15_000 },
            ).toBe(true);
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });
});
