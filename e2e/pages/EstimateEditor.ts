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
    get discountToggle(): Locator { return this.page.getByTestId('discount-type-toggle').filter({ visible: true }); }
    get discountValue(): Locator { return this.page.getByTestId('discount-value').filter({ visible: true }); }
    get addDiscount(): Locator {
        // Estimate create/detail use the same reveal, but its shipped label is
        // "Add Discount" (without the invoice surface's leading plus).
        return this.page.getByRole('button', { name: 'Add Discount', exact: true })
            .filter({ visible: true });
    }
    /**
     * Anchored on the amount, which is the one thing an estimate card always
     * has. It used to be anchored on the "More actions" kebab — so when
     * ESTIMATE-REDESIGN-001 removed the kebab (every action is visible now) this
     * locator silently matched nothing and every test that opened a card failed
     * somewhere else entirely.
     */
    get detailPanel(): Locator {
        return this.page.getByRole('dialog').filter({
            has: this.page.getByTestId('estimate-total'),
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
        // One shared item sheet since P3 — the editor's inline twin is gone.
        const itemTitle = this.page.getByRole('heading', { name: /^(Add item|Edit item)$/ });
        await expect(async () => {
            if (await itemTitle.isVisible()) return;
            const createNew = this.page.getByRole('button').filter({ hasText: `Use custom item “${marker}”` });
            await expect(createNew).toBeVisible({ timeout: 2000 });
            // ItemPresetSearchCombobox selects rows from onMouseDown, not onClick.
            await createNew.dispatchEvent('mousedown', { button: 0 });
            await expect(itemTitle).toBeVisible({ timeout: 2000 });
        }).toPass({ timeout: 20_000 });
        await this.page.locator('#eid-name').fill(marker);
        await this.page.locator('#eid-description').fill(`${marker} description`);
        await this.page.locator('#eid-quantity').fill('1');
        await this.page.locator('#eid-unit-price').fill(unitPrice);
        const amount = this.page.getByText(`$${unitPrice}`, { exact: true }).first();
        await expect(async () => {
            if (await amount.isVisible()) return;
            await this.page.getByRole('button', { name: /^(Add item|Save changes)$/ }).dispatchEvent('click');
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

    async setPercentageDiscount(value: string): Promise<void> {
        if (!(await this.discountToggle.isVisible())) {
            await expect(this.addDiscount).toBeVisible();
            await this.addDiscount.click();
            await expect(this.discountToggle).toBeVisible();
        }
        await this.discountToggle.getByRole('button', {
            name: 'Discount as a percentage',
            exact: true,
        }).click();
        await this.discountValue.fill(value);
        await this.expectPercentageDiscount(value);
        // Estimate detail edits persist discount_value on blur. The create dialog
        // has no onCommit handler, so the same blur is harmless on that surface.
        await this.discountValue.blur();
    }

    async expectPercentageDiscount(value: string): Promise<void> {
        await expect(this.discountToggle.getByRole('button', {
            name: 'Discount as a percentage',
            exact: true,
        })).toHaveAttribute('aria-pressed', 'true');
        const escaped = String(Number(value)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        await expect(this.discountValue).toHaveValue(new RegExp(`^${escaped}(?:\\.0+)?$`));
    }

    async expectEditorTotal(amount: string): Promise<void> {
        await expect(this.page.getByRole('dialog').filter({ has: this.save })
            .getByText(amount, { exact: true }).first()).toBeVisible();
    }

    async editOpenEstimate(): Promise<void> {
        const edit = this.page.getByTestId('estimate-edit');
        if (!(await edit.isVisible().catch(() => false))) {
            await this.detailPanel.getByTestId('estimate-more').click();
            await expect(edit).toBeVisible();
        }
        await edit.click();
        await expect(this.detailPanel.getByTestId('estimate-save')).toBeVisible();
    }

    async saveDetailChanges(): Promise<void> {
        await this.detailPanel.getByTestId('estimate-save').click();
        await expect(this.detailPanel.getByTestId('estimate-save')).toBeHidden({ timeout: 30_000 });
    }

    async expectDetailTotal(total: string): Promise<void> {
        await expect(this.detailPanel.getByTestId('estimate-total')).toHaveText(total);
    }

    async expectDetailPercentageDiscount(rate: string, total: string): Promise<void> {
        await expect(this.detailPanel.getByText(`Discount (${rate}%)`, { exact: true })).toBeVisible();
        await expect(this.detailPanel.getByTestId('estimate-total')).toHaveText(total);
    }

    async addDetailCustomItem(marker: string, unitPrice: string): Promise<void> {
        // ESTIMATE-FOOTER-001 (2026-08-16): a draft shows one primary CTA (Send) plus
        // Create invoice; every other action, Edit included, moved into the "More
        // actions" menu. So open that menu, then pick Edit (testid estimate-edit) —
        // the old top-level `button name="Edit"` no longer exists. The menu content is
        // portaled to <body> (outside the dialog), so the item is page-scoped; only the
        // trigger button lives inside detailPanel.
        const editItem = this.page.getByTestId('estimate-edit');
        await expect(async () => {
            if (await this.itemSearch.isVisible()) return;
            if (!(await editItem.isVisible())) {
                await this.detailPanel.getByRole('button', { name: 'More actions' }).click();
                await expect(editItem).toBeVisible({ timeout: 2000 });
            }
            await editItem.click();
            await expect(this.itemSearch).toBeVisible({ timeout: 2000 });
        }).toPass({ timeout: 20_000 });
        await this.itemSearch.fill(marker);
        await expect(async () => {
            if (await this.detailItem.title.isVisible()) return;
            const createNew = this.page.getByRole('button').filter({ hasText: `Use custom item “${marker}”` });
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
        // No kebab any more: the primary action for a sent estimate IS approving
        // it, and for an approved one it becomes the invoice.
        const approve = this.detailPanel.getByTestId('estimate-approve');
        const approved = this.detailPanel.getByTestId('estimate-status');
        await expect(async () => {
            if ((await approved.textContent())?.includes('Approved')) return;
            await approve.dispatchEvent('click');
            await expect(approved).toContainText('Approved', { timeout: 5000 });
        }).toPass({ timeout: 30_000 });
        // …and the way to bill it is right there, not behind a menu.
        await expect(this.detailPanel.getByTestId('estimate-create-invoice')).toBeVisible();
    }
}
