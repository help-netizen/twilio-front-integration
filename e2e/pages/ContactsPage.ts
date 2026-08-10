import { expect, type Locator, type Page } from '@playwright/test';

export class ContactsPage {
    constructor(private readonly page: Page) {}

    get search(): Locator { return this.page.getByPlaceholder('type to find anything...'); }

    async goto(): Promise<void> {
        await this.page.goto('/contacts');
        await expect(this.search).toBeVisible();
    }

    contact(marker: string): Locator {
        return this.page.getByText(marker, { exact: false }).first();
    }

    async searchFor(marker: string): Promise<Locator> {
        await this.search.fill(marker);
        const contact = this.contact(marker);
        await expect(contact).toBeVisible();
        return contact;
    }

    async open(marker: string): Promise<void> {
        await (await this.searchFor(marker)).click();
        await expect(this.page).toHaveURL(/\/contacts\/\d+$/);
        await expect(this.page.getByRole('heading', { name: marker, exact: true })).toBeVisible();
    }

    async editCompanyName(companyName: string): Promise<void> {
        await this.page.getByRole('button', { name: 'Edit contact', exact: true }).click();
        const dialog = this.page.getByRole('dialog').filter({
            has: this.page.getByRole('heading', { name: 'Edit contact', exact: true }),
        });
        await expect(dialog).toBeVisible();
        await dialog.getByLabel('Company name', { exact: true }).fill(companyName);
        await dialog.getByRole('button', { name: 'Save Changes', exact: true }).click();
        await expect(this.page.getByText('Contact updated', { exact: true })).toBeVisible();
        await expect(dialog).toBeHidden();
        await expect(this.page.getByText(companyName, { exact: true })).toBeVisible();
    }

    async addTask(description: string): Promise<void> {
        await this.page.getByRole('button', { name: 'Add task', exact: true }).click();
        const dialog = this.page.getByRole('dialog').filter({
            has: this.page.getByRole('heading', { name: 'New task', exact: true }),
        });
        await expect(dialog).toBeVisible();
        await dialog.getByLabel('Description', { exact: true }).fill(description);
        await dialog.getByRole('button', { name: 'Add task', exact: true }).click();
        await expect(this.page.getByText('Task added', { exact: true })).toBeVisible();
        await expect(dialog).toBeHidden();
    }
}
