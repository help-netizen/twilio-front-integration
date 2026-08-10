import { expect, type Locator, type Page } from '@playwright/test';

export class EstimateItemDialog {
    constructor(private readonly page: Page) {}

    get title(): Locator { return this.page.getByRole('heading', { name: /^(Add|Edit) item$/ }); }
    get name(): Locator { return this.page.locator('#eid-name'); }
    get description(): Locator { return this.page.locator('#eid-description'); }
    get quantity(): Locator { return this.page.locator('#eid-quantity'); }
    get unitPrice(): Locator { return this.page.locator('#eid-unit-price'); }
    get save(): Locator { return this.page.getByRole('button', { name: /^(Add item|Save changes)$/ }); }
}

export class EstimateEditor {
    readonly detailItem: EstimateItemDialog;

    constructor(private readonly page: Page) {
        this.detailItem = new EstimateItemDialog(page);
    }

    get title(): Locator { return this.page.getByRole('heading', { name: 'New estimate' }); }
    get itemSearch(): Locator {
        return this.page.getByPlaceholder('Search the price book or add a new item…');
    }
    get subtotal(): Locator { return this.page.getByText('Subtotal', { exact: true }); }
    get total(): Locator { return this.page.getByText('Total', { exact: true }); }
    get save(): Locator { return this.page.getByRole('button', { name: 'Save estimate', exact: true }); }

    async addSummary(marker: string): Promise<void> {
        await this.page.getByRole('button', { name: 'Add summary', exact: true }).click();
        await this.page.locator('#estimate-summary').fill(marker);
        await this.page.getByRole('button', { name: 'Save summary', exact: true }).click();
    }

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

    async saveEstimate(): Promise<void> {
        await this.save.click();
        await expect(this.title).toBeHidden();
    }

    async addDetailCustomItem(marker: string, unitPrice: string): Promise<void> {
        await this.itemSearch.fill(marker);
        const createNew = this.page.getByRole('button').filter({ hasText: `Create new “${marker}”` });
        await expect(createNew).toBeVisible();
        await createNew.click();
        await expect(this.detailItem.title).toBeVisible();
        await this.detailItem.name.fill(marker);
        await this.detailItem.description.fill(`${marker} description`);
        await this.detailItem.quantity.fill('1');
        await this.detailItem.unitPrice.fill(unitPrice);
        await this.detailItem.save.click();
        await expect(this.detailItem.title).toBeHidden();
        await expect(this.page.getByText(marker, { exact: true })).toBeVisible();
    }

    async approveOpenEstimate(): Promise<void> {
        const more = this.page.getByRole('button', { name: 'More actions' });
        if (await more.isVisible()) {
            await more.click();
            await this.page.getByRole('menuitem', { name: 'Approve', exact: true }).click();
        } else {
            await this.page.getByRole('button', { name: 'Approve', exact: true }).click();
        }
        await expect(this.page.getByText('approved', { exact: true })).toBeVisible();
        await expect(this.page.getByRole('button', { name: 'Create Invoice', exact: true })).toBeVisible();
    }
}
