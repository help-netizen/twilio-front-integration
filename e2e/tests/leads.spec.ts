import { expect, test } from '../fixtures/test';
import { ApiClient, type CleanupEntity } from '../fixtures/api';
import { hasAdmin, RUN_ID } from '../fixtures/env';
import { LeadsPage } from '../pages/LeadsPage';

test.describe('@suite:leads', () => {
    test.skip(!hasAdmin(), 'requires E2E_ADMIN_USER / E2E_ADMIN_PASS');

    test('@p0 LEAD-01 create lead', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];
        const marker = `${RUN_ID} Lead`;
        const phone = `+1646${`${Date.now()}`.slice(-7)}`;
        const email = `${RUN_ID}-lead-${Date.now()}@e2e.local`;

        try {
            const leads = new LeadsPage(page);
            await leads.goto();
            const dialog = await leads.openCreate();
            await dialog.create({ name: marker, phone, email, description: `${marker} description` });

            const apiLead = await api.findLead(marker);
            expect(apiLead, 'created lead was not returned by the tenant-scoped API').toBeDefined();
            const uuid = String(apiLead?.UUID ?? apiLead?.uuid ?? '');
            if (uuid) cleanup.push({ type: 'lead', id: uuid });
            const apiContact = await api.findContact(marker);
            const contactId = Number(apiContact?.id ?? apiLead?.contact_id ?? apiLead?.ContactId ?? 0);
            if (contactId) cleanup.push({ type: 'contact', id: contactId });

            const row = await leads.searchFor(marker);
            await row.click();
            await expect(page.getByText(marker, { exact: false }).first()).toBeVisible();
            await expect(page.locator(`a[href="tel:${phone}"]`)).toBeVisible();
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });

    test.fixme('@p1 LEAD-02 open an API-seeded lead and verify its details', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const lead = await api.createContact('LEAD-02 Lead');
            cleanup.push({ type: 'contact', id: lead.id }, { type: 'lead', id: lead.leadUuid });

            const leads = new LeadsPage(page);
            await leads.goto();
            await leads.open(lead.name);
            await expect(page.getByRole('heading', { name: lead.name, exact: true })).toBeVisible();
            await expect(page.locator(`a[href="tel:${lead.phone}"]`)).toBeVisible();
            await expect(page.locator(`a[href="mailto:${lead.email}"]`)).toBeVisible();
            await expect(page.getByText('100 Test Street', { exact: true })).toBeVisible();
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });

    test.fixme('@p1 LEAD-03 show the linked contact on an API-seeded lead', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const lead = await api.createContact('LEAD-03 Lead');
            cleanup.push({ type: 'contact', id: lead.id }, { type: 'lead', id: lead.leadUuid });

            const leads = new LeadsPage(page);
            await leads.goto();
            await leads.open(lead.name);
            const linkedContact = leads.linkedContact(lead.name);
            await expect(linkedContact).toBeVisible();
            await linkedContact.click();
            await expect(page).toHaveURL(new RegExp(`/contacts/(${lead.id}|[0-9A-Za-z]+)$`));
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });
});
