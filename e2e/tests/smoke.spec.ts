import { test, expect } from '../fixtures/test';
import { LoginPage } from '../pages/LoginPage';

/**
 * SMOKE-01 · P0 — App boots and the auth gate renders (fail-fast health check).
 * No creds needed: unauthenticated visit → SPA redirects to the Keycloak login form.
 */
test('@p0 @suite:smoke SMOKE-01 app loads and login page renders', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    const resp = await page.goto('/');
    expect(resp, 'no response for initial document').not.toBeNull();
    expect(resp!.status(), `initial document HTTP ${resp!.status()}`).toBeLessThan(400);

    await new LoginPage(page).expectVisible();

    if (pageErrors.length) {
        // Non-fatal for now; tighten to an assertion once the app is known clean on load.
        console.warn('SMOKE-01 pageerrors (non-fatal):', pageErrors);
    }
});
