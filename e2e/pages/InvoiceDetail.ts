import { expect, type Locator, type Page } from '@playwright/test';

export type InvoiceCollectionMethod = 'card' | 'cash' | 'check' | 'link';

function shortInvoiceNumber(value: string): string {
    return value.replace(/^INVOICE\s+/i, '').trim();
}

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

/** Shared OB-70 confirmation used by both the detail card and list-row action. */
export class InvoiceRemoveDialog {
    constructor(private readonly page: Page) {}

    get root(): Locator {
        return this.page.getByRole('dialog').filter({
            has: this.page.getByTestId('invoice-remove-confirm'),
        });
    }
    get confirm(): Locator { return this.root.getByTestId('invoice-remove-confirm'); }
    get reapply(): Locator { return this.root.getByTestId('invoice-remove-reapply'); }

    async expectOpen(invoiceNumber: string): Promise<void> {
        await expect(this.root).toBeVisible();
        await expect(this.root.getByRole('heading', {
            name: `Remove invoice ${shortInvoiceNumber(invoiceNumber)}?`,
            exact: true,
        })).toBeVisible();
        await expect(this.root).not.toContainText('Checking what is paid on it…');
        await expect(this.confirm).toBeEnabled();
    }

    async expectPaidCreditCopy(amount: string): Promise<void> {
        await expect(this.root).toContainText(
            `The ${amount} already paid stays on the job as credit.`,
        );
    }

    async chooseReapply(invoiceNumber: string, amount: string): Promise<void> {
        await expect(this.reapply).toContainText(
            `Put ${amount} on invoice ${shortInvoiceNumber(invoiceNumber)}`,
        );
        await this.reapply.click();
        await expect(this.reapply.getByRole('checkbox')).toBeChecked();
    }

    async submit(): Promise<void> {
        await this.confirm.click();
        await expect(this.root).toBeHidden({ timeout: 30_000 });
    }

    async keep(): Promise<void> {
        await this.root.getByRole('button', { name: 'Keep', exact: true }).click();
        await expect(this.root).toBeHidden();
    }
}

/** Read/action state of the redesigned invoice detail panel. */
export class InvoiceDetail {
    readonly collectSheet: InvoiceCollectSheet;
    readonly removeDialog: InvoiceRemoveDialog;

    constructor(private readonly page: Page) {
        this.collectSheet = new InvoiceCollectSheet(page);
        this.removeDialog = new InvoiceRemoveDialog(page);
    }

    get root(): Locator { return this.page.getByTestId('invoice-detail'); }
    get collect(): Locator { return this.root.getByTestId('collect-open'); }
    get resend(): Locator {
        return this.root.getByTestId('invoice-send').filter({ hasText: 'Resend' });
    }
    /**
     * At most two actions are buttons; the rest live behind "More" (owner,
     * 2026-08-16). The card used to show all of them, with Edit and the
     * destructive one stranded at the very bottom of the scroll.
     */
    get more(): Locator { return this.root.getByTestId('invoice-more'); }
    get preview(): Locator { return this.page.getByRole('menuitem', { name: 'Preview PDF', exact: true }); }
    get edit(): Locator { return this.page.getByRole('menuitem', { name: 'Edit invoice', exact: true }); }
    get removeInvoice(): Locator { return this.page.getByTestId('invoice-remove'); }

    /** Open the menu, and leave it open for whatever the caller asserts next. */
    async openMore(): Promise<void> {
        if (await this.preview.isVisible().catch(() => false)) return;
        await this.more.click();
        await expect(this.preview).toBeVisible();
    }

    async expectInvoiceNumber(invoiceNumber: string): Promise<void> {
        await expect(this.root).toBeVisible();
        await expect(this.root.getByText(invoiceNumber, { exact: true })).toBeVisible();
    }

    async expectIssuedActions(): Promise<void> {
        // Money is owed, so collecting it is the primary and the reminder is next
        // to it. Everything else is one tap away, in one place.
        await expect(this.collect).toBeVisible();
        await expect(this.resend).toBeVisible();
        await this.openMore();
        await expect(this.preview).toBeVisible();
        await expect(this.edit).toBeVisible();
        await expect(this.removeInvoice).toBeVisible();
        await this.page.keyboard.press('Escape');
    }

    async expectDraftActions(): Promise<void> {
        await this.openMore();
        await expect(this.removeInvoice).toBeVisible();
        await this.page.keyboard.press('Escape');
    }

    async openRemoveConfirm(invoiceNumber: string): Promise<InvoiceRemoveDialog> {
        await this.openMore();
        await this.removeInvoice.click();
        await this.removeDialog.expectOpen(invoiceNumber);
        return this.removeDialog;
    }

    async expectPercentageDiscount(rate: string, total: string): Promise<void> {
        await expect(this.root.getByText(`Discount (${rate}%)`, { exact: true })).toBeVisible();
        const totalRow = this.root.getByText('Total', { exact: true }).last().locator('..');
        await expect(totalRow.getByText(total, { exact: true })).toBeVisible();
    }

    async expectPaymentSummary(amountPaid: string, balanceDue: string): Promise<void> {
        const paidRow = this.root.getByText('Amount paid', { exact: true }).locator('..');
        const dueRow = this.root.getByText('Balance due', { exact: true }).last().locator('..');
        await expect(paidRow.getByText(amountPaid, { exact: true })).toBeVisible();
        await expect(dueRow.getByText(balanceDue, { exact: true })).toBeVisible();
    }

    async openCollect(): Promise<InvoiceCollectSheet> {
        await this.collect.click();
        await expect(this.collectSheet.root).toBeVisible();
        return this.collectSheet;
    }
}
