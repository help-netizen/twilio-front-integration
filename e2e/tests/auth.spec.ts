import { test, expect } from '../fixtures/test';
import { LoginPage } from '../pages/LoginPage';
import {
    ADMIN_PASS,
    ADMIN_USER,
    BASE_URL,
    hasAdmin,
} from '../fixtures/env';

test.describe('@suite:auth', () => {
    test.skip(!hasAdmin(), 'requires E2E_ADMIN_USER / E2E_ADMIN_PASS');

    /** AUTH-01 · P0 — Login with valid credentials → lands back in the app. */
    test('@p0 AUTH-01 login with valid credentials', async ({ page }) => {
        await page.goto('/');
        const login = new LoginPage(page);
        await login.expectVisible();
        await login.login(ADMIN_USER, ADMIN_PASS);

        // Left the Keycloak form → we're authenticated in the app again.
        await expect(login.username).toBeHidden({ timeout: 30_000 });
        await expect(page).not.toHaveURL(/\/realms\//, { timeout: 30_000 });
        await expect(page.locator('button.user-menu')).toBeVisible();
    });

    /** AUTH-02 · P0 — Invalid password → Keycloak error, no session. */
    test('@p0 AUTH-02 invalid password shows error, no session', async ({ page }) => {
        await page.goto('/');
        const login = new LoginPage(page);
        await login.expectVisible();
        await login.login(ADMIN_USER, `wrong-${Date.now()}`);

        await expect(login.error.first()).toBeVisible();
        await expect(page).toHaveURL(/\/realms\//);
    });

    /** AUTH-03 · P0 — Logout clears the Keycloak session and protected access. */
    test('@p0 AUTH-03 logout clears session', async ({ browser }) => {
        // ISOLATED session: a fresh login, NOT the shared storageState. Logging out of the
        // shared SSO session would invalidate it server-side and break every authed test.
        const context = await browser.newContext({ baseURL: BASE_URL, ignoreHTTPSErrors: true });
        const page = await context.newPage();
        try {
            await page.goto('/');
            const login = new LoginPage(page);
            await login.expectVisible();
            await login.login(ADMIN_USER, ADMIN_PASS);
            await page.locator('button.user-menu').waitFor({ state: 'visible', timeout: 30_000 });

            await page.locator('button.user-menu').click();
            await page.getByRole('menuitem', { name: 'Log Out', exact: true }).click();

            await login.expectVisible();
            await page.goto('/jobs');
            await login.expectVisible();
        } finally {
            await context.close();
        }
    });

    /** AUTH-04 · P1 — Session survives a reload (PWA no-eject). */
    test('@p1 AUTH-04 session persists across reload', async ({ browser }) => {
        const context = await browser.newContext({ baseURL: BASE_URL, ignoreHTTPSErrors: true });
        const page = await context.newPage();
        try {
            await page.goto('/');
            const login = new LoginPage(page);
            await login.expectVisible();
            await login.login(ADMIN_USER, ADMIN_PASS);
            await page.locator('button.user-menu').waitFor({ state: 'visible', timeout: 30_000 });

            await page.reload();
            await expect(page.locator('button.user-menu')).toBeVisible();
            await expect(page).not.toHaveURL(/\/realms\//);
        } finally {
            await context.close();
        }
    });

    /** AUTH-05 · P1 — Unauthenticated deep-link bounces to login, then lands back in the app. */
    test('@p1 AUTH-05 unauthenticated deep-link routes through login', async ({ browser }) => {
        const context = await browser.newContext({ baseURL: BASE_URL, ignoreHTTPSErrors: true });
        const page = await context.newPage();
        try {
            await page.goto('/jobs');
            const login = new LoginPage(page);
            await login.expectVisible();
            await login.login(ADMIN_USER, ADMIN_PASS);
            await expect(login.username).toBeHidden({ timeout: 30_000 });
            await expect(page).not.toHaveURL(/\/realms\//);
        } finally {
            await context.close();
        }
    });
});
