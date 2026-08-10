import { Page, Locator, expect } from '@playwright/test';

/**
 * Keycloak login page (crm-prod realm). Unauthenticated app visits redirect here.
 * Selectors are the Keycloak base login.ftl ids — stable across themes.
 */
export class LoginPage {
    constructor(private page: Page) {}

    get username(): Locator { return this.page.locator('#username'); }
    get password(): Locator { return this.page.locator('#password'); }
    get submit(): Locator { return this.page.locator('#kc-login'); }
    /** Theme-resilient error feedback (wrong creds). The custom Albusto KC theme renders
     *  the failure as plain body text, not a standard alert node — so match text too. */
    get error(): Locator {
        return this.page
            .locator('#input-error, .kc-feedback-text, .pf-c-alert__title, [role="alert"]')
            .or(this.page.getByText(/invalid username or password/i));
    }

    async expectVisible(): Promise<void> {
        await expect(this.username).toBeVisible({ timeout: 30_000 });
        await expect(this.password).toBeVisible({ timeout: 30_000 });
    }

    async login(user: string, pass: string): Promise<void> {
        await this.username.fill(user);
        await this.password.fill(pass);
        await this.submit.click();
    }

    async expectSessionCleared(protectedPath = '/jobs'): Promise<void> {
        await this.expectVisible();
        await this.page.goto(protectedPath);
        await this.expectVisible();
        await expect(this.page).toHaveURL(/\/realms\//);
    }
}
