import { expect, type Locator, type Page } from '@playwright/test';

export class InvoiceEditor {
    constructor(private readonly page: Page) {}

    get title(): Locator { return this.page.getByRole('heading', { name: 'New invoice' }); }
    get itemSearch(): Locator {
        return this.page.getByPlaceholder('Search the price book or add a new item…');
    }
    get save(): Locator { return this.page.getByRole('button', { name: 'Create invoice', exact: true }); }
    get detailPanel(): Locator {
        return this.page.getByRole('dialog').filter({
            has: this.page.getByText('Balance Due', { exact: true }),
        }).last();
    }

    async addCustomItem(marker: string, unitPrice: string): Promise<void> {
        await this.itemSearch.fill(marker);
        const itemTitle = this.page.getByRole('heading', { name: 'Add custom item' });
        await expect(async () => {
            if (await itemTitle.isVisible()) return;
            const createNew = this.page.getByRole('button').filter({ hasText: `Create new “${marker}”` });
            await expect(createNew).toBeVisible({ timeout: 2000 });
            // ItemPresetSearchCombobox selects rows from onMouseDown, not onClick.
            await createNew.dispatchEvent('mousedown', { button: 0 });
            await expect(itemTitle).toBeVisible({ timeout: 2000 });
        }).toPass({ timeout: 20_000 });
        await this.page.locator('#item-title').fill(marker);
        await this.page.locator('#item-description').fill(`${marker} description`);
        await this.page.locator('#item-qty').fill('1');
        await this.page.locator('#item-unit-price').fill(unitPrice);
        const amount = this.page.getByText(`$${unitPrice}`, { exact: true }).first();
        await expect(async () => {
            if (await amount.isVisible()) return;
            await this.page.getByRole('button', { name: 'Save item', exact: true }).dispatchEvent('click');
            await expect(itemTitle).toBeHidden({ timeout: 2000 });
            await expect(amount).toBeVisible({ timeout: 2000 });
        }).toPass({ timeout: 20_000 });
    }

    async createInvoice(): Promise<void> {
        await expect(async () => {
            if (await this.title.isHidden()) return;
            await this.save.dispatchEvent('click');
            await expect(this.title).toBeHidden({ timeout: 5000 });
        }).toPass({ timeout: 30_000 });
    }

    async expectDraftTotals(amount: string): Promise<void> {
        await expect(this.detailPanel.getByText('draft', { exact: true })).toBeVisible();
        await expect(this.detailPanel.getByText('Amount paid', { exact: true })).toBeVisible();
        await expect(this.detailPanel.getByText('Balance Due', { exact: true })).toBeVisible();
        await expect(this.detailPanel.getByText(amount, { exact: true }).last()).toBeVisible();
    }
}
