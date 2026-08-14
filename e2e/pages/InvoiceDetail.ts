import { expect, type Locator, type Page } from '@playwright/test';

export type InvoiceCollectionMethod = 'card' | 'cash' | 'check' | 'link';

const METHOD_PERMISSIONS: Record<InvoiceCollectionMethod, string> = {
    card: 'payments.collect_keyed',
    cash: 'payments.collect_offline',
    check: 'payments.collect_offline',
    link: 'payments.collect_online',
};

/** Invoice-bound collection overlay; tests stop before a charge is submitted. */
export class InvoiceCollectSheet {
    constructor(private readonly page: Page) {}

    get root(): Locator { return this.page.getByTestId('invoice-collect-dialog'); }
    get amount(): Locator { return this.root.getByTestId('collect-amount'); }
    get methodChooser(): Locator { return this.root.getByTestId('collect-method'); }
    get charge(): Locator { return this.root.getByTestId('collect-charge'); }

    method(method: InvoiceCollectionMethod): Locator {
        return this.root.getByTestId(`collect-method-${method}`);
    }

    async expectPermissionGates(permissions: string[]): Promise<void> {
        for (const method of Object.keys(METHOD_PERMISSIONS) as InvoiceCollectionMethod[]) {
            const allowed = permissions.includes(METHOD_PERMISSIONS[method]);
            await expect(this.method(method)).toHaveCount(allowed ? 1 : 0);
        }
    }
}

/** Read/action state of the redesigned invoice detail panel. */
export class InvoiceDetail {
    readonly collectSheet: InvoiceCollectSheet;

    constructor(private readonly page: Page) {
        this.collectSheet = new InvoiceCollectSheet(page);
    }

    get root(): Locator { return this.page.getByTestId('invoice-detail'); }
    get collect(): Locator { return this.root.getByTestId('collect-open'); }
    get resend(): Locator {
        return this.root.getByTestId('invoice-send').filter({ hasText: 'Resend' });
    }
    get preview(): Locator { return this.root.getByRole('button', { name: 'Preview PDF', exact: true }); }
    get edit(): Locator { return this.root.getByRole('button', { name: 'Edit invoice', exact: true }); }
    get voidInvoice(): Locator { return this.root.getByRole('button', { name: 'Void invoice', exact: true }); }
    get deleteDraft(): Locator { return this.root.getByRole('button', { name: 'Delete draft', exact: true }); }
    get voidConfirm(): Locator { return this.page.getByTestId('invoice-void-confirm'); }
    get deleteConfirm(): Locator { return this.page.getByTestId('invoice-delete-confirm'); }

    async expectInvoiceNumber(invoiceNumber: string): Promise<void> {
        await expect(this.root).toBeVisible();
        await expect(this.root.getByText(invoiceNumber, { exact: true })).toBeVisible();
    }

    async expectIssuedActions(): Promise<void> {
        await expect(this.collect).toBeVisible();
        await expect(this.resend).toBeVisible();
        await expect(this.preview).toBeVisible();
        await expect(this.edit).toBeVisible();
        await expect(this.voidInvoice).toBeVisible();
        await expect(this.deleteDraft).toHaveCount(0);
        await expect(this.root.locator('button[aria-haspopup="menu"]')).toHaveCount(0);
    }

    async expectDraftActions(): Promise<void> {
        await expect(this.deleteDraft).toBeVisible();
        await expect(this.voidInvoice).toHaveCount(0);
    }

    async openVoidConfirm(invoiceNumber: string, balance: string): Promise<void> {
        await this.voidInvoice.click();
        const dialog = this.page.getByRole('dialog').filter({
            has: this.page.getByRole('heading', { name: `Void ${invoiceNumber}?`, exact: true }),
        });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText(balance, { exact: true })).toBeVisible();
        await expect(this.voidConfirm).toBeVisible();
    }

    async openCollect(): Promise<InvoiceCollectSheet> {
        await this.collect.click();
        await expect(this.collectSheet.root).toBeVisible();
        return this.collectSheet;
    }
}
