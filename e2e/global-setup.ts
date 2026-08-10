import { mkdir } from 'node:fs/promises';
import { chromium, type FullConfig } from '@playwright/test';
import { LoginPage } from './pages/LoginPage';
import {
    ADMIN_PASS,
    ADMIN_STORAGE_STATE,
    ADMIN_USER,
    AUTH_DIR,
    BASE_URL,
    hasAdmin,
} from './fixtures/env';

export default async function globalSetup(_config: FullConfig): Promise<void> {
    if (!hasAdmin()) return;

    await mkdir(AUTH_DIR, { recursive: true });
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext({
            baseURL: BASE_URL,
            ignoreHTTPSErrors: true,
        });
        const page = await context.newPage();
        await page.goto('/');

        const login = new LoginPage(page);
        await login.expectVisible();
        await login.login(ADMIN_USER, ADMIN_PASS);
        await page.locator('button.user-menu').waitFor({ state: 'visible', timeout: 30_000 });

        await context.storageState({ path: ADMIN_STORAGE_STATE });
        await context.close();
    } finally {
        await browser.close();
    }
}
