import { expect, test } from '../fixtures/test';
import { ApiClient, type CleanupEntity } from '../fixtures/api';
import {
    CAN_DISPATCH_DOCUMENTS, DISPATCH_BLOCKED_REASON,
    hasAdmin, JOBS_BLOCKED_REASON, JOBS_NATIVE,
} from '../fixtures/env';
import { InvoicesPage } from '../pages/InvoicesPage';

const COLLECTION_PERMISSIONS = [
    'payments.collect_keyed',
    'payments.collect_offline',
    'payments.collect_online',
];

test.describe('@suite:invoice-redesign detail', () => {
    test.skip(!hasAdmin(), 'requires E2E_ADMIN_USER / E2E_ADMIN_PASS');
    test.skip(!JOBS_NATIVE, JOBS_BLOCKED_REASON);
    // Both cases need an ISSUED invoice, and only a real send issues one.
    test.skip(!CAN_DISPATCH_DOCUMENTS, DISPATCH_BLOCKED_REASON);

    test('@p0 detail-actions exposes issued actions and one status-safe removal', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const job = await api.createJob({ label: 'Invoice detail actions Job' });
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
            );
            const issued = await api.createInvoice(job.id, 'Invoice detail partial', 200);
            cleanup.push({ type: 'invoice', id: issued.id });
            await api.issueInvoice(issued.id, job.contact.email);
            await api.recordInvoicePayment(issued.id, { amount: 50, method: 'cash' });

            const draft = await api.createInvoice(job.id, 'Invoice detail draft', 25);
            cleanup.push({ type: 'invoice', id: draft.id });

            const invoices = new InvoicesPage(page);
            const detail = await invoices.openInvoice(issued.id, issued.invoiceNumber);
            await expect(detail.root.getByText('partial', { exact: true })).toBeVisible();
            await detail.expectIssuedActions();
            // OB-70: every live status ends in the same separated danger action.
            await detail.openMore();
            await expect(detail.removeInvoice).toHaveAttribute('style', /--blanc-danger/);
            await expect(page.getByRole('menuitem').last()).toHaveText(/Remove invoice/);
            await page.keyboard.press('Escape');

            const issuedRemoval = await detail.openRemoveConfirm(issued.invoiceNumber);
            await issuedRemoval.expectPaidCreditCopy('$50.00');
            await issuedRemoval.keep();

            await invoices.openInvoice(draft.id, draft.invoiceNumber);
            await expect(detail.root.getByText('draft', { exact: true })).toBeVisible();
            await detail.expectDraftActions();
            const draftRemoval = await detail.openRemoveConfirm(draft.invoiceNumber);
            await expect(draftRemoval.reapply).toHaveCount(0);
            await draftRemoval.keep();
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });

    test('@p1 collect-payment prefills balance and exposes only permitted methods', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const permissions = api.session.permissions || [];
            test.skip(
                !COLLECTION_PERMISSIONS.some(permission => permissions.includes(permission)),
                'staging admin has no invoice collection permission',
            );
            const job = await api.createJob({ label: 'Invoice collect Job' });
            cleanup.push(
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
                { type: 'job', id: job.id },
            );
            const invoice = await api.createInvoice(job.id, 'Invoice collect', 188.50);
            cleanup.push({ type: 'invoice', id: invoice.id });
            await api.issueInvoice(invoice.id, job.contact.email);

            const detail = await new InvoicesPage(page).openInvoice(invoice.id, invoice.invoiceNumber);
            const collect = await detail.openCollect();
            await expect(collect.amount).toHaveValue('188.50');
            await expect(collect.methodChooser).toBeVisible();
            await collect.expectPermissionGates(permissions);
            await expect(collect.charge).toBeVisible();
            await expect(collect.charge).toBeEnabled();
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });
});
