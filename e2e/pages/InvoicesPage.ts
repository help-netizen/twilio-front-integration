import { expect, type Locator, type Page } from '@playwright/test';
import { InvoiceDetail } from './InvoiceDetail';
import { InvoiceEditor } from './InvoiceEditor';

/** Desktop table and mobile-row variants of /invoices. */
export class InvoicesPage {
    readonly detail: InvoiceDetail;
    readonly editor: InvoiceEditor;

    constructor(private readonly page: Page) {
        this.detail = new InvoiceDetail(page);
        this.editor = new InvoiceEditor(page);
    }

    // Desktop table row and mobile card row both carry this testid; exactly one is
    // visible per viewport, so scope to the visible variant to avoid strict-mode clashes.
    get rows(): Locator { return this.page.getByTestId('invoice-list-row').filter({ visible: true }); }
    get mobileSearch(): Locator { return this.page.getByTestId('invoice-search'); }
    get desktopSearch(): Locator { return this.page.getByPlaceholder('type to find anything...'); }
    get loadMore(): Locator { return this.page.getByTestId('invoice-load-more'); }

    async goto(): Promise<void> {
        await this.page.goto('/invoices');
        await expect(this.page.getByRole('heading', { name: 'Invoices', exact: true }).first()).toBeVisible();
    }

    async openInvoice(id: number, invoiceNumber: string): Promise<InvoiceDetail> {
        await this.page.goto(`/invoices?openId=${id}`);
        await this.detail.expectInvoiceNumber(invoiceNumber);
        return this.detail;
    }

    row(invoiceNumber: string): Locator {
        return this.rows.filter({ hasText: invoiceNumber });
    }

    async searchFor(invoiceNumber: string): Promise<Locator> {
        const search = await this.mobileSearch.isVisible() ? this.mobileSearch : this.desktopSearch;
        await search.fill(invoiceNumber);
        const row = this.row(invoiceNumber);
        await expect(row).toBeVisible();
        return row;
    }

    async editFromListRow(invoiceNumber: string): Promise<InvoiceEditor> {
        const row = await this.searchFor(invoiceNumber);
        // Required Claude handoff: the desktop list action trigger needs this id.
        await row.getByTestId('invoice-row-actions').click();
        await this.page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
        await this.editor.expectOpen(invoiceNumber);
        return this.editor;
    }

    async openMobileRow(invoiceNumber: string): Promise<InvoiceDetail> {
        const row = this.row(invoiceNumber);
        await expect(row).toHaveAttribute('aria-label', `Open ${invoiceNumber}`);
        await row.click();
        await this.detail.expectInvoiceNumber(invoiceNumber);
        return this.detail;
    }
}
