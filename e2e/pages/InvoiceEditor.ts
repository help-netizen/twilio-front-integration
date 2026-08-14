import { expect, type Locator, type Page } from '@playwright/test';

/** Invoice create/edit surface plus its line-item and discard-confirm overlays. */
export class InvoiceEditor {
    constructor(private readonly page: Page) {}

    get root(): Locator { return this.page.getByTestId('invoice-editor'); }
    get title(): Locator {
        return this.root.getByRole('heading', { name: 'New invoice', exact: true });
    }
    get aiBlock(): Locator {
        return this.root.getByText('Generate from a report', { exact: true });
    }
    get close(): Locator { return this.root.getByTestId('invoice-close'); }
    get save(): Locator { return this.root.getByTestId('invoice-create-save'); }
    get addItemButton(): Locator { return this.root.getByTestId('invoice-add-item'); }
    get itemRows(): Locator { return this.root.getByTestId('invoice-item-row'); }
    get itemSheet(): Locator { return this.page.getByTestId('invoice-item-sheet'); }
    get itemSearch(): Locator { return this.itemSheet.getByLabel('Search Price Book'); }
    get detailPanel(): Locator { return this.page.getByTestId('invoice-detail'); }
    get discardConfirm(): Locator { return this.page.getByTestId('invoice-discard-confirm'); }

    heading(name: string): Locator {
        return this.root.getByRole('heading', { name, exact: true });
    }

    itemRow(marker: string): Locator {
        return this.itemRows.filter({ hasText: marker });
    }

    async expectOpen(title = 'New invoice'): Promise<void> {
        await expect(this.root).toBeVisible();
        await expect(this.heading(title)).toBeVisible();
    }

    async openItemSheet(): Promise<void> {
        await this.addItemButton.click();
        await expect(this.itemSheet).toBeVisible();
    }

    /** A saved Price Book row inserts immediately; the custom-edit sheet never appears. */
    async addPriceBookItem(marker: string): Promise<void> {
        await this.openItemSheet();
        await this.itemSearch.fill(marker);
        const preset = this.itemSheet.getByRole('button').filter({ hasText: marker }).first();
        await expect(preset).toBeVisible();
        // ItemPresetSearchCombobox intentionally chooses rows on mousedown.
        await preset.dispatchEvent('mousedown', { button: 0 });
        await expect(this.itemSheet).toBeHidden();
        await expect(this.itemRow(marker)).toBeVisible();
    }

    async addCustomItem(
        marker: string,
        unitPrice: string,
        quantity = '1',
    ): Promise<void> {
        await this.openItemSheet();
        await this.itemSheet.getByLabel('Title').fill(marker);
        await this.itemSheet.getByLabel('Description').fill(`${marker} description`);
        await this.itemSheet.getByLabel('Qty').fill(quantity);
        await this.itemSheet.getByLabel('Unit price').fill(unitPrice);
        await this.itemSheet.getByTestId('invoice-item-save').click();
        await expect(this.itemSheet).toBeHidden();
        await expect(this.itemRow(marker)).toBeVisible();
    }

    async expectItem(marker: string): Promise<void> {
        await expect(this.itemRow(marker)).toBeVisible();
    }

    async expectTotal(amount: string): Promise<void> {
        const totalsSection = this.root.locator('section').filter({
            has: this.root.getByText('Totals', { exact: true }),
        });
        await expect(totalsSection.getByText(amount, { exact: true }).last()).toBeVisible();
    }

    async createInvoice(): Promise<void> {
        await this.save.click();
        await expect(this.root).toBeHidden({ timeout: 30_000 });
    }

    async saveInvoice(): Promise<void> {
        await expect(this.save).toHaveText('Save invoice');
        await this.save.click();
        await expect(this.root).toBeHidden({ timeout: 30_000 });
    }

    async requestClose(): Promise<void> {
        await this.close.click();
        await expect(this.discardConfirm).toBeVisible();
    }

    async keepEditing(): Promise<void> {
        const confirm = this.page.getByRole('dialog').filter({
            has: this.page.getByRole('heading', { name: 'Discard this invoice?' }),
        });
        await confirm.getByRole('button', { name: 'Keep editing', exact: true }).click();
        await expect(this.root).toBeVisible();
        await expect(this.discardConfirm).toBeHidden();
    }

    async discard(): Promise<void> {
        await this.discardConfirm.click();
        await expect(this.root).toBeHidden();
    }

    async expectDraftTotals(amount: string): Promise<void> {
        await expect(this.detailPanel.getByText('draft', { exact: true })).toBeVisible();
        await expect(this.detailPanel.getByText('Amount paid', { exact: true })).toBeVisible();
        await expect(this.detailPanel.getByText('Balance due', { exact: true })).toBeVisible();
        await expect(this.detailPanel.getByText(amount, { exact: true }).last()).toBeVisible();
    }
}
