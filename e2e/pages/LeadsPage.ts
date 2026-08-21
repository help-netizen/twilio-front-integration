import { expect, type Locator, type Page } from '@playwright/test';
import { CreateLeadDialog } from './CreateLeadDialog';

export class LeadsPage {
    readonly createDialog: CreateLeadDialog;

    constructor(private readonly page: Page) {
        this.createDialog = new CreateLeadDialog(page);
    }

    get search(): Locator { return this.page.getByPlaceholder('type to find anything...'); }
    get createButton(): Locator { return this.page.getByRole('button', { name: 'Create Lead', exact: true }); }

    async goto(): Promise<void> {
        await this.page.goto('/leads');
        await expect(this.createButton).toBeVisible();
    }

    async openCreate(): Promise<CreateLeadDialog> {
        await this.createButton.click();
        await expect(this.createDialog.title).toBeVisible();
        return this.createDialog;
    }

    lead(marker: string): Locator {
        return this.page.getByRole('row').filter({ hasText: marker }).first();
    }

    async searchFor(marker: string): Promise<Locator> {
        await this.search.fill(marker);
        const lead = this.lead(marker);
        await expect(lead).toBeVisible();
        return lead;
    }

    async open(marker: string): Promise<void> {
        await (await this.searchFor(marker)).click();
        await expect(this.page).toHaveURL(/\/leads\/\d+$/);
        // The detail title is assembled from FirstName/LastName; the list search
        // marker is not a stable title contract. The status control is the stable
        // signal that the selected lead detail has finished rendering.
        await expect(this.page.getByRole('button', { name: /^Lead status: .+$/ })
            .filter({ visible: true })).toBeVisible();
    }

    async changeStatus(from: string, to: string): Promise<void> {
        await this.page.getByRole('button', { name: `Lead status: ${from}`, exact: true }).click();
        await this.page.getByRole('menuitem', { name: to, exact: true }).click();
        await expect(this.page.getByText('Status updated', { exact: true })).toBeVisible();
        await expect(this.page.getByRole('button', {
            name: `Lead status: ${to}`,
            exact: true,
        })).toBeVisible();
    }

    async expectHistory(description: string): Promise<void> {
        await this.page.getByRole('button', { name: 'History', exact: true })
            .filter({ visible: true }).click();
        await expect(this.page.getByText(description, { exact: true })
            .filter({ visible: true })).toBeVisible({ timeout: 15_000 });
    }

    linkedContact(marker: string): Locator {
        return this.page.getByRole('button').filter({ hasText: marker }).first();
    }
}
