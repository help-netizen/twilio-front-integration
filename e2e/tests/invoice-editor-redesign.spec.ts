import { expect, test } from '../fixtures/test';
import { ApiClient, type CleanupEntity } from '../fixtures/api';
import { hasAdmin, JOBS_BLOCKED_REASON, JOBS_NATIVE } from '../fixtures/env';
import { JobPanel } from '../pages/JobPanel';
import { JobsPage } from '../pages/JobsPage';
import { InvoicesPage } from '../pages/InvoicesPage';

test.describe('@suite:invoice-redesign editor', () => {
    test.skip(!hasAdmin(), 'requires E2E_ADMIN_USER / E2E_ADMIN_PASS');
    test.skip(!JOBS_NATIVE, JOBS_BLOCKED_REASON);

    test('@p0 create-invoice inserts Price Book and custom items', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const job = await api.createJob({ label: 'Invoice rebuild create Job' });
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
            );
            const preset = await api.createPriceBookItem('Invoice rebuild Price Book item', 75);
            cleanup.push({ type: 'price_book_item', id: preset.id });
            const customMarker = ApiClient.runName('Invoice rebuild custom item');

            await new JobsPage(page).openJob(job.id, job.marker);
            const panel = new JobPanel(page);
            const editor = await panel.createInvoice();
            await expect(editor.aiBlock).toBeVisible();

            await editor.addPriceBookItem(preset.marker);
            await editor.addCustomItem(customMarker, '25.50', '2');
            await editor.expectTotal('$126.00');
            await editor.createInvoice();

            await expect.poll(async () => {
                const invoice = await api.findInvoice(job.id, customMarker);
                return invoice?.id ? Number(invoice.id) : 0;
            }).not.toBe(0);
            const createdListRow = await api.findInvoice(job.id, customMarker);
            const invoiceId = Number(createdListRow?.id);
            cleanup.push({ type: 'invoice', id: invoiceId });

            await panel.openOnlyInvoice();
            await expect(editor.detailPanel.getByTestId('invoice-item-row').filter({ hasText: preset.marker })).toBeVisible();
            await expect(editor.detailPanel.getByTestId('invoice-item-row').filter({ hasText: customMarker })).toBeVisible();

            const created = await api.getInvoice(invoiceId);
            const items = Array.isArray(created.items) ? created.items : [];
            expect(items).toHaveLength(2);
            expect(items.map(item => JSON.stringify(item))).toEqual(expect.arrayContaining([
                expect.stringContaining(preset.marker),
                expect.stringContaining(customMarker),
            ]));
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });

    test('@p0 edit-hydration preserves list-row invoice items on save', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const job = await api.createJob({ label: 'Invoice hydration Job' });
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
            );
            const firstMarker = ApiClient.runName('Hydrated first item');
            const secondMarker = ApiClient.runName('Hydrated second item');
            const invoice = await api.createInvoiceWithItems(job.id, 'Invoice hydration', [
                { name: firstMarker, quantity: 1, unitPrice: 60, taxable: false },
                { name: secondMarker, quantity: 2, unitPrice: 35, taxable: false },
            ]);
            cleanup.push({ type: 'invoice', id: invoice.id });

            const invoices = new InvoicesPage(page);
            await invoices.goto();
            const editor = await invoices.editFromListRow(invoice.invoiceNumber);
            await editor.expectItem(firstMarker);
            await editor.expectItem(secondMarker);
            await editor.saveInvoice();

            const saved = await api.getInvoice(invoice.id);
            const savedItems = Array.isArray(saved.items) ? saved.items : [];
            expect(savedItems).toHaveLength(2);
            expect(savedItems.map(item => JSON.stringify(item))).toEqual(expect.arrayContaining([
                expect.stringContaining(firstMarker),
                expect.stringContaining(secondMarker),
            ]));
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });

    test('@p1 close-safely keeps or discards a dirty mobile editor', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const job = await api.createJob({ label: 'Invoice safe close Job' });
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
            );
            const itemMarker = ApiClient.runName('Invoice safe close item');

            await new JobsPage(page).openJob(job.id, job.marker);
            const editor = await new JobPanel(page).createInvoice();
            await editor.addCustomItem(itemMarker, '40.00');

            await editor.requestClose();
            await editor.keepEditing();
            await editor.expectItem(itemMarker);

            await editor.requestClose();
            await editor.discard();
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });
});
