import { defineConfig, devices } from '@playwright/test';
import { ADMIN_STORAGE_STATE, BASE_URL } from './fixtures/env';

/**
 * Albusto pre-deploy E2E regression — target = staging on mini (Tailscale).
 * Spec: docs/specs/E2E-REGRESSION-001.md
 */
export default defineConfig({
    testDir: './tests',
    timeout: 60_000,
    expect: { timeout: 15_000 },
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 1,
    // One shared staging test user → run serially so parallel authed sessions
    // (and the logout test) don't contend over the same Keycloak session/token.
    workers: 1,
    reporter: [['list'], ['html', { open: 'never' }]],
    globalSetup: require.resolve('./global-setup'),
    use: {
        baseURL: BASE_URL,
        ignoreHTTPSErrors: true,
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
        actionTimeout: 15_000,
        navigationTimeout: 30_000,
    },
    projects: [
        {
            name: 'chromium-credless',
            testMatch: /(?:smoke|auth|registration)\.spec\.ts/,
            use: { ...devices['Desktop Chrome'] },
        },
        {
            name: 'chromium-authed',
            testIgnore: /(?:smoke|auth|registration)\.spec\.ts/,
            use: {
                ...devices['Desktop Chrome'],
                storageState: ADMIN_STORAGE_STATE,
            },
        },
    ],
});
