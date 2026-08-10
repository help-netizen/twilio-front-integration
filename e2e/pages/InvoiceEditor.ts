import { expect, type Locator, type Page } from '@playwright/test';

export class InvoiceEditor {
    constructor(private readonly page: Page) {}

    get title(): Locator { return this.page.getByRole('heading', { name: 'New invoice' }); }
    get itemSearch(): Locator {
        return this.page.getByPlaceholder('Search the price book or add a new item…');
    }
    get save(): Locator { return this.page.getByRole('button', { name: 'Create invoice', exact: true }); }

    async addCustomItem(marker: string, unitPrice: string): Promise<void> {
        await this.itemSearch.fill(marker);
        const createNew = this.page.getByRole('button').filter({ hasText: `Create new “${marker}”` });
        await expect(createNew).toBeVisible();
        await createNew.click();
        await expect(this.page.getByRole('heading', { name: 'Add custom item' })).toBeVisible();
        await this.page.locator('#item-title').fill(marker);
        await this.page.locator('#item-description').fill(`${marker} description`);
        await this.page.locator('#item-qty').fill('1');
        await this.page.locator('#item-unit-price').fill(unitPrice);
        await this.page.getByRole('button', { name: 'Save item', exact: true }).click();
        await expect(this.page.getByText(`$${unitPrice}`, { exact: true }).first()).toBeVisible();
    }

    async createInvoice(): Promise<void> {
        await this.save.click();
        await expect(this.title).toBeHidden();
    }

    async expectDraftTotals(amount: string): Promise<void> {
        await expect(this.page.getByText('draft', { exact: true })).toBeVisible();
        await expect(this.page.getByText('Amount paid', { exact: true })).toBeVisible();
        await expect(this.page.getByText('Balance Due', { exact: true }).last()).toBeVisible();
        await expect(this.page.getByText(amount, { exact: true }).last()).toBeVisible();
    }
}
