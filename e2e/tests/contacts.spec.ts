import { expect, test } from '../fixtures/test';
import { ApiClient, type CleanupEntity } from '../fixtures/api';
import { hasAdmin, RUN_ID } from '../fixtures/env';
import { ContactForm } from '../pages/ContactForm';
import { ContactsPage } from '../pages/ContactsPage';

test.describe('@suite:contacts', () => {
    test.skip(!hasAdmin(), 'requires E2E_ADMIN_USER / E2E_ADMIN_PASS');

    test.fixme('@p0 CONT-01 create contact through the lead form fallback', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];
        const marker = `${RUN_ID} Contact`;
        const phone = `+1202${`${Date.now()}`.slice(-7)}`;
        const email = `${RUN_ID}-${Date.now()}@e2e.local`;

        try {
            await new ContactForm(page).create({ name: marker, phone, email, description: `${marker} created by CONT-01` });

            const contact = await api.findContact(marker);
            expect(contact, 'created contact was not returned by the tenant-scoped API').toBeDefined();
            cleanup.push({ type: 'contact', id: Number(contact!.id) });
            const lead = await api.findLead(marker);
            const leadUuid = String(lead?.UUID ?? lead?.uuid ?? '');
            if (leadUuid) cleanup.push({ type: 'lead', id: leadUuid });

            const contacts = new ContactsPage(page);
            await contacts.goto();
            await contacts.open(marker);
            await expect(page.locator(`a[href="tel:${phone}"]`)).toBeVisible();
            await expect(page.getByText(email, { exact: true })).toBeVisible();
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });

    test('@p1 CONT-02 search finds an API-seeded contact by RUN_ID', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const contact = await api.createContact('CONT-02 Contact');
            cleanup.push({ type: 'contact', id: contact.id }, { type: 'lead', id: contact.leadUuid });

            const contacts = new ContactsPage(page);
            await contacts.goto();
            const result = await contacts.searchFor(contact.name);
            await expect(result).toHaveText(contact.name);
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });

    test('@p1 CONT-03 open an API-seeded contact and show its details', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const contact = await api.createContact('CONT-03 Contact');
            cleanup.push({ type: 'contact', id: contact.id }, { type: 'lead', id: contact.leadUuid });

            const contacts = new ContactsPage(page);
            await contacts.goto();
            await contacts.open(contact.name);
            await expect(page.getByRole('heading', { name: contact.name, exact: true })).toBeVisible();
            await expect(page.locator(`a[href="tel:${contact.phone}"]`)).toBeVisible();
            await expect(page.locator(`a[href="mailto:${contact.email}"]`)).toBeVisible();
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });

    test.fixme('@p1 CONT-04 edit a contact field and confirm it persists', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const contact = await api.createContact('CONT-04 Contact');
            cleanup.push({ type: 'contact', id: contact.id }, { type: 'lead', id: contact.leadUuid });
            const companyName = ApiClient.runName('CONT-04 Updated Company');

            const contacts = new ContactsPage(page);
            await contacts.goto();
            await contacts.open(contact.name);
            await contacts.editCompanyName(companyName);

            await page.reload();
            await expect(page.getByRole('heading', { name: contact.name, exact: true })).toBeVisible();
            await expect(page.getByText(companyName, { exact: true })).toBeVisible();
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });
});
