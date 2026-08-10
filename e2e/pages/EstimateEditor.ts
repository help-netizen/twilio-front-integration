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
    get detailPanel(): Locator {
        return this.page.getByRole('dialog').filter({
            has: this.page.getByRole('button', { name: 'More actions' }),
        }).last();
    }

    async addSummary(marker: string): Promise<void> {
        const summaryInput = this.page.locator('#estimate-summary');
        await expect(async () => {
            if (await summaryInput.isVisible()) return;
            await this.page.getByRole('button', { name: 'Add summary', exact: true }).dispatchEvent('click');
            await expect(summaryInput).toBeVisible({ timeout: 2000 });
        }).toPass({ timeout: 20_000 });
        await this.page.locator('#estimate-summary').fill(marker);
        await expect(async () => {
            if (await summaryInput.isHidden()) return;
            await this.page.getByRole('button', { name: 'Save summary', exact: true }).dispatchEvent('click');
            await expect(summaryInput).toBeHidden({ timeout: 2000 });
            await expect(this.page.getByText(marker, { exact: true })).toBeVisible({ timeout: 2000 });
        }).toPass({ timeout: 20_000 });
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

    async saveEstimate(): Promise<void> {
        await expect(async () => {
            if (await this.title.isHidden()) return;
            await this.save.dispatchEvent('click');
            await expect(this.title).toBeHidden({ timeout: 5000 });
        }).toPass({ timeout: 30_000 });
    }

    async addDetailCustomItem(marker: string, unitPrice: string): Promise<void> {
        await expect(async () => {
            if (await this.itemSearch.isVisible()) return;
            await this.detailPanel.getByRole('button', { name: 'Edit', exact: true }).dispatchEvent('click');
            await expect(this.itemSearch).toBeVisible({ timeout: 2000 });
        }).toPass({ timeout: 20_000 });
        await this.itemSearch.fill(marker);
        await expect(async () => {
            if (await this.detailItem.title.isVisible()) return;
            const createNew = this.page.getByRole('button').filter({ hasText: `Create new “${marker}”` });
            await expect(createNew).toBeVisible({ timeout: 2000 });
            await createNew.dispatchEvent('mousedown', { button: 0 });
            await expect(this.detailItem.title).toBeVisible({ timeout: 2000 });
        }).toPass({ timeout: 20_000 });
        await this.detailItem.name.fill(marker);
        await this.detailItem.description.fill(`${marker} description`);
        await this.detailItem.quantity.fill('1');
        await this.detailItem.unitPrice.fill(unitPrice);
        await expect(async () => {
            if (await this.detailItem.title.isHidden()) return;
            await this.detailItem.save.dispatchEvent('click');
            await expect(this.detailItem.title).toBeHidden({ timeout: 2000 });
            await expect(this.page.getByText(marker, { exact: true })).toBeVisible({ timeout: 2000 });
        }).toPass({ timeout: 20_000 });
    }

    async approveOpenEstimate(): Promise<void> {
        const more = this.detailPanel.getByRole('button', { name: 'More actions' });
        const approved = this.detailPanel.getByText('approved', { exact: true });
        await expect(async () => {
            if (await approved.isVisible()) return;
            if (await more.isVisible()) {
                const menuApprove = this.page.getByRole('menuitem', { name: 'Approve', exact: true });
                if (await menuApprove.count() === 0) {
                    await more.dispatchEvent('pointerdown', { button: 0, pointerType: 'mouse' });
                    await expect(menuApprove).toBeVisible({ timeout: 2000 });
                }
                await menuApprove.dispatchEvent('click');
            } else {
                await this.detailPanel.getByRole('button', { name: 'Approve', exact: true }).dispatchEvent('click');
            }
            await expect(approved).toBeVisible({ timeout: 5000 });
        }).toPass({ timeout: 30_000 });
        await expect(this.detailPanel.getByRole('button', { name: 'Create Invoice', exact: true })).toBeVisible();
    }
}
