import { expect, test } from '../fixtures/test';
import { ApiClient, type CleanupEntity } from '../fixtures/api';
import { hasAdmin } from '../fixtures/env';
import { AppNav } from '../pages/AppNav';
import { LeadsPage } from '../pages/LeadsPage';

test.describe('@suite:nav', () => {
    test.skip(!hasAdmin(), 'requires E2E_ADMIN_USER / E2E_ADMIN_PASS');

    test('@p1 X-01 admin nav renders the primary destinations', async ({ page }) => {
        await page.goto('/contacts');
        await expect(page.getByRole('heading', { name: 'Contacts', exact: true })).toBeVisible();
        await new AppNav(page).expectPrimaryDestinations();
    });

    test('@p1 X-02 global search finds an API-seeded lead', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const lead = await api.createLead('X-02 Search Lead');
            cleanup.push({ type: 'contact', id: lead.contactId }, { type: 'lead', id: lead.uuid });

            await page.goto('/contacts');
            await expect(page.getByRole('heading', { name: 'Contacts', exact: true })).toBeVisible();
            await new AppNav(page).open('Leads', '/leads');

            const result = await new LeadsPage(page).searchFor(lead.marker);
            await expect(result).toContainText(lead.marker);
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });
});
