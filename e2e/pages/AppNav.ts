import { expect, type Locator, type Page } from '@playwright/test';

export type PrimaryDestination = 'Pulse' | 'Leads' | 'Jobs' | 'Schedule' | 'Contacts' | 'Tasks';

export class AppNav {
    constructor(private readonly page: Page) {}

    destination(label: PrimaryDestination): Locator {
        return this.page.locator('header').getByRole('tab').filter({ hasText: label });
    }

    async expectPrimaryDestinations(): Promise<void> {
        for (const label of ['Pulse', 'Leads', 'Jobs', 'Schedule', 'Contacts', 'Tasks'] as const) {
            await expect(this.destination(label)).toBeVisible();
        }
    }

    async open(label: PrimaryDestination, path: string): Promise<void> {
        await this.destination(label).click();
        await expect(this.page).toHaveURL(new RegExp(`${path}$`));
    }

    async logout(): Promise<void> {
        const settings = this.page.locator('header').getByRole('button', { name: 'Settings', exact: true });
        const logout = this.page.getByRole('menuitem', { name: 'Log Out', exact: true });
        await expect(async () => {
            if (await logout.isVisible()) return;
            await settings.dispatchEvent('pointerdown', { button: 0, pointerType: 'mouse' });
            await expect(logout).toBeVisible({ timeout: 2000 });
        }).toPass({ timeout: 20_000 });
        await logout.dispatchEvent('click');
        await expect(this.page.locator('#username')).toBeVisible({ timeout: 30_000 });
    }
}
