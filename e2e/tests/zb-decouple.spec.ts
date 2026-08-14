import { expect, test } from '../fixtures/test';
import { ApiClient, type CleanupEntity } from '../fixtures/api';
import { hasAdmin } from '../fixtures/env';

/**
 * ZB-DECOUPLE Phase F regression.
 *
 * Verifies the Zenbooker teardown (a) removed the surfaces it should and (b) left
 * the affected functionality working natively — in particular, that a tenant WITHOUT
 * a Zenbooker integration is no longer blocked by it. Before Phase F, `POST /api/jobs`
 * hard-500'd with "ZENBOOKER_API_KEY is not configured" for such a company; ZBX-04
 * proves that is gone. Auth-gated: needs the admin storageState (E2E_ADMIN_USER/PASS).
 */
test.describe('@suite:zb-decouple', () => {
    test.skip(!hasAdmin(), 'requires E2E_ADMIN_USER / E2E_ADMIN_PASS');

    test('@p0 ZBX-01 Integrations settings no longer has a Zenbooker tab (F2a)', async ({ page }) => {
        await page.goto('/settings/integrations');
        // The two native tabs remain reachable…
        await expect(page.getByRole('tab', { name: 'Marketplace' })).toBeVisible();
        await expect(page.getByRole('tab', { name: 'API access' })).toBeVisible();
        // …and the Zenbooker integration tab (webhook URL + ZB API key) is gone.
        await expect(page.getByRole('tab', { name: 'Zenbooker' })).toHaveCount(0);
    });

    test('@p0 ZBX-02 Payments page has no Zenbooker Sync controls (F3)', async ({ page }) => {
        await page.goto('/payments');
        // Anchor on the app shell rendering rather than 'networkidle' — the Payments
        // page holds SSE/polling connections open, so networkidle never settles.
        await expect(page.locator('button.user-menu')).toBeVisible();
        await expect(page).toHaveURL(/\/payments/);
        // The Zenbooker payment-sync buttons ("Sync" / "Sync full history") are gone;
        // the local Payments data layer (list/detail/export) is untouched.
        await expect(page.getByRole('button', { name: /full history/i })).toHaveCount(0);
        await expect(page.getByRole('button', { name: /^Sync$/ })).toHaveCount(0);
    });

    test('@p0 ZBX-03 dispatch roster serves natively via /api/team (F1/F5)', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        try {
            // fetchTechs() hits the native /api/team/team-members path; a non-empty
            // roster proves the native technician directory answers with zero ZB calls.
            const techs = await api.fetchTechs(1);
            expect(techs.length).toBeGreaterThan(0);
            expect(techs[0]?.name).toBeTruthy();
        } finally {
            await api.dispose();
        }
    });

    test('@p0 ZBX-04 native job creation is not blocked by Zenbooker (F4)', async ({ page }) => {
        // The crux of the ZB teardown: pre-Phase-F, POST /api/jobs 500'd with
        // "ZENBOOKER_API_KEY is not configured" for a company with no Zenbooker.
        // A successful create with a real job_id proves the block is gone.
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];
        try {
            const job = await api.createJob({ label: 'ZBX-04', scheduled: false });
            expect(job.id).toBeGreaterThan(0);
            cleanup.push(
                { type: 'job', id: job.id },
                { type: 'contact', id: job.contact.id },
                { type: 'lead', id: job.contact.leadUuid },
            );
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });
});
