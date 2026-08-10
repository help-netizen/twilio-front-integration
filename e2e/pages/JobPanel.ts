import { expect, type Locator, type Page } from '@playwright/test';
import { EstimateEditor } from './EstimateEditor';
import { InvoiceEditor } from './InvoiceEditor';
import { SlotPicker } from './SlotPicker';

export class JobPanel {
    readonly estimateEditor: EstimateEditor;
    readonly invoiceEditor: InvoiceEditor;
    readonly slotPicker: SlotPicker;

    constructor(private readonly page: Page) {
        this.estimateEditor = new EstimateEditor(page);
        this.invoiceEditor = new InvoiceEditor(page);
        this.slotPicker = new SlotPicker(page);
    }

    get finance(): Locator { return this.page.getByRole('heading', { name: 'Finance', exact: true }); }
    get estimateSection(): Locator {
        return this.page.locator('section').filter({
            has: this.page.getByRole('heading', { name: 'Estimate', exact: true }),
        });
    }
    get invoiceSection(): Locator {
        return this.page.locator('section').filter({
            has: this.page.getByRole('heading', { name: 'Invoices', exact: true }),
        });
    }

    async expectLoaded(marker: string): Promise<void> {
        await expect(this.page.getByRole('heading', { name: marker, exact: true })).toBeVisible();
        await expect(this.finance).toBeVisible();
    }

    async createEstimate(): Promise<EstimateEditor> {
        const button = this.estimateSection.getByRole('button', { name: /^(Create|New estimate)$/ });
        await button.click();
        await expect(this.estimateEditor.title).toBeVisible();
        return this.estimateEditor;
    }

    async openEstimate(marker: string): Promise<void> {
        await this.estimateSection.getByRole('button').filter({ hasText: marker }).click();
        await expect(this.page.getByText(marker, { exact: true })).toBeVisible();
    }

    async createInvoice(): Promise<InvoiceEditor> {
        const button = this.invoiceSection.getByRole('button', { name: /^(Create|New invoice)$/ });
        await button.click();
        await expect(this.invoiceEditor.title).toBeVisible();
        return this.invoiceEditor;
    }

    async openOnlyInvoice(): Promise<void> {
        await this.invoiceSection.locator('button').filter({ hasText: /draft/i }).first().click();
        await expect(this.page.getByText('Balance Due', { exact: true }).first()).toBeVisible();
    }

    async replaceTechnicians(currentNames: string[], targetName: string): Promise<void> {
        await this.page.getByRole('button', { name: /^(Assign|Change)$/ }).click();
        const search = this.page.getByPlaceholder('Search providers…');
        for (const name of [...currentNames, targetName]) {
            await search.fill(name);
            await this.page.getByRole('option', { name, exact: true }).click();
        }
        await this.page.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(this.page.getByText('Providers updated', { exact: true })).toBeVisible();
    }

    async rescheduleToNextDay(technicianName?: string): Promise<void> {
        await this.page.getByRole('button', { name: 'Reschedule', exact: true }).click();
        await this.slotPicker.pickNextDaySlot(technicianName);
        const warning = this.page.getByRole('dialog').filter({ hasText: 'Blocked by time off' });
        const success = this.page.getByText('Job rescheduled', { exact: true });
        const outcome = await Promise.race([
            warning.waitFor({ state: 'visible' }).then(() => 'warning' as const),
            success.waitFor({ state: 'visible' }).then(() => 'success' as const),
        ]);
        if (outcome === 'warning') {
            await warning.getByRole('button', { name: 'Reschedule', exact: true }).click();
        }
        await expect(success).toBeVisible();
    }
}
