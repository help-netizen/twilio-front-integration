import { expect, test } from '../fixtures/test';
import { ApiClient } from '../fixtures/api';
import { hasAdmin } from '../fixtures/env';

/**
 * ZB-DECOUPLE Phase F regression.
 *
 * Verifies the Zenbooker teardown (a) removed the surfaces it should and (b) left
 * the affected functionality working natively. The broader job/estimate/invoice/
 * schedule lifecycle — which USED to be Zenbooker-coupled and auto-skipped — now
 * runs by default via the P0 suites (JOBS_NATIVE flipped in fixtures/env.ts once
 * Phase F removed the POST /api/jobs → ZB coupling). These tests cover the ZB-
 * specific removals on top of that.
 *
 * Auth-gated: needs the admin storageState (E2E_ADMIN_USER / E2E_ADMIN_PASS).
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

    test('@p0 ZBX-02 Payments page loads with no Zenbooker Sync controls (F3)', async ({ page }) => {
        await page.goto('/payments');
        // The page renders — Export is the remaining toolbar action.
        await expect(page.getByRole('button', { name: /Export/i })).toBeVisible();
        // The Zenbooker payment-sync buttons ("Sync" / "Sync full history") are gone;
        // the local Payments data layer (list/detail/export) is untouched.
        await expect(page.getByRole('button', { name: /^Sync\b/ })).toHaveCount(0);
        await expect(page.getByRole('button', { name: /full history/i })).toHaveCount(0);
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
});
