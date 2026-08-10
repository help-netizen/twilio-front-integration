import { test, expect } from '../fixtures/test';
import { SignupPage } from '../pages/SignupPage';
import { RUN_ID } from '../fixtures/env';

/**
 * REG-01 · P0 — Public signup reaches the email-verification screen.
 * No pre-existing creds needed: creates a fresh account with a unique email
 * (verification + company creation continue in /onboarding after email-verify = REG-02).
 */
test('@p0 @suite:registration REG-01 public signup reaches email-verification screen', async ({ page }) => {
    const email = `${RUN_ID}-${Date.now()}@e2e.local`;
    const signup = new SignupPage(page);

    await signup.goto();
    await expect(signup.fullName).toBeVisible();

    await signup.fillAndSubmit('E2E Test User', email, 'Test1234!pw');

    await expect(signup.emailSentHeading).toBeVisible();
});
