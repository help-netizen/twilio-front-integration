import { Page, Locator, expect } from '@playwright/test';

/**
 * Public self-registration page (/signup → SignupPage.tsx, POST /api/public/signup).
 * account step: full name + work email + password → "Create account" → email-sent step.
 */
export class SignupPage {
    constructor(private page: Page) {}

    async goto(): Promise<void> {
        await this.page.goto('/signup');
    }

    get fullName(): Locator { return this.page.locator('#fullName'); }
    get email(): Locator { return this.page.locator('#email'); }
    get password(): Locator { return this.page.locator('#password'); }
    get submit(): Locator { return this.page.getByRole('button', { name: /create account/i }); }
    get emailSentHeading(): Locator { return this.page.getByText(/check your email/i); }

    async fillAndSubmit(fullName: string, email: string, password: string): Promise<void> {
        await this.fullName.fill(fullName);
        await this.email.fill(email);
        await this.password.fill(password);
        await this.submit.click();
    }
}
