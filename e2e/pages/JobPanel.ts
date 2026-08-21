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
        await expect(async () => {
            if (await this.estimateEditor.title.isVisible()) return;
            await this.estimateSection.getByRole('button', { name: /^(Create|New estimate)$/ }).dispatchEvent('click');
            await expect(this.estimateEditor.title).toBeVisible({ timeout: 2000 });
        }).toPass({ timeout: 20_000 });
        return this.estimateEditor;
    }

    async openEstimate(marker: string): Promise<void> {
        await expect(async () => {
            if (await this.estimateEditor.detailPanel.isVisible()) return;
            await this.estimateSection.getByRole('button').filter({ hasText: marker }).dispatchEvent('click');
            await expect(this.estimateEditor.detailPanel).toBeVisible({ timeout: 2000 });
        }).toPass({ timeout: 20_000 });
        await expect(this.estimateEditor.detailPanel.getByText(marker, { exact: true }).first()).toBeVisible();
    }

    async createInvoice(): Promise<InvoiceEditor> {
        await expect(async () => {
            if (await this.invoiceEditor.title.isVisible()) return;
            await this.invoiceSection.getByRole('button', { name: /^(Create|New invoice)$/ }).dispatchEvent('click');
            await expect(this.invoiceEditor.title).toBeVisible({ timeout: 2000 });
        }).toPass({ timeout: 20_000 });
        return this.invoiceEditor;
    }

    async openOnlyInvoice(): Promise<void> {
        await expect(async () => {
            if (await this.invoiceEditor.detailPanel.isVisible()) return;
            await this.invoiceSection.locator('button').filter({ hasText: /draft/i }).first().dispatchEvent('click');
            await expect(this.invoiceEditor.detailPanel).toBeVisible({ timeout: 2000 });
        }).toPass({ timeout: 20_000 });
    }

    async replaceTechnicians(currentNames: string[], targetName: string): Promise<void> {
        const search = this.page.getByPlaceholder('Search providers…');
        await expect(async () => {
            if (await search.isVisible()) return;
            await this.page.getByRole('button', { name: /^(Assign|Change)$/ }).dispatchEvent('click');
            await expect(search).toBeVisible({ timeout: 2000 });
        }).toPass({ timeout: 20_000 });
        let selectedCount = currentNames.length;
        for (const name of [...currentNames, targetName]) {
            await search.fill(name);
            selectedCount += currentNames.includes(name) ? -1 : 1;
            const expectedCount = selectedCount;
            await expect(async () => {
                await this.page.getByRole('option', { name, exact: true }).dispatchEvent('click');
                await expect(this.page.getByText(`${expectedCount} selected`, { exact: true })).toBeVisible({ timeout: 2000 });
            }).toPass({ timeout: 20_000 });
        }
        const success = this.page.getByText('Providers updated', { exact: true });
        await expect(async () => {
            if (await success.isVisible()) return;
            await this.page.getByRole('button', { name: 'Save', exact: true }).dispatchEvent('click');
            await expect(success).toBeVisible({ timeout: 5000 });
            await expect(search).toBeHidden({ timeout: 2000 });
        }).toPass({ timeout: 30_000 });
    }

    async expectHistory(description: string): Promise<void> {
        await this.page.getByRole('button', { name: 'History', exact: true })
            .filter({ visible: true }).click();
        await expect(this.page.getByText(description, { exact: true })
            .filter({ visible: true })).toBeVisible({ timeout: 15_000 });
    }

    async expectJobCredit(amount: string): Promise<void> {
        const due = this.page.locator('.blanc-money-cell').filter({
            has: this.page.getByText('Due', { exact: true }),
        }).filter({ visible: true });
        await expect(due.getByText(`−${amount}`, { exact: true })).toBeVisible();
    }

    /**
     * A header/ops button addressed by its visible label. The header status pill and
     * the prominent FSM action buttons are both `button[name]`, so the same label
     * points at the action button before a transition and at the status pill after it
     * (e.g. "On the way" is the ops action while Submitted, and the status pill once
     * the job IS On the way) — which is exactly what the on-the-way flow asserts.
     */
    statusButton(label: string): Locator {
        return this.page.getByRole('button', { name: label, exact: true });
    }

    /** The notify-only "On the way" ETA modal (identified by its Notify client action). */
    get etaModal(): Locator {
        return this.page.getByRole('dialog').filter({
            has: this.page.getByRole('button', { name: 'Notify client' }),
        });
    }

    /**
     * Click the prominent "On the way" FSM action. FSM-SYSTEM-TRANSITIONS-001: the
     * transition applies immediately (plain), then the notify-only ETA modal opens.
     */
    async goOnTheWay(): Promise<void> {
        await this.statusButton('On the way').dispatchEvent('click');
        await expect(this.etaModal).toBeVisible({ timeout: 15_000 });
    }

    /** Dismiss the ETA modal without notifying — must NOT revert the status change. */
    async closeEtaModal(): Promise<void> {
        await this.etaModal.getByRole('button', { name: 'Cancel', exact: true }).dispatchEvent('click');
        await expect(this.etaModal).toBeHidden({ timeout: 10_000 });
    }

    async rescheduleToNextDay(technicianName?: string): Promise<void> {
        await expect(async () => {
            if (await this.slotPicker.title.isVisible()) return;
            await this.page.getByRole('button', { name: 'Reschedule', exact: true }).dispatchEvent('click');
            await expect(this.slotPicker.title).toBeVisible({ timeout: 2000 });
        }).toPass({ timeout: 20_000 });
        await this.slotPicker.pickNextDaySlot(technicianName);
        const warning = this.page.getByRole('dialog').filter({ hasText: 'Blocked by time off' });
        const success = this.page.getByText('Job rescheduled', { exact: true });
        const outcome = await Promise.race([
            warning.waitFor({ state: 'visible' }).then(() => 'warning' as const),
            success.waitFor({ state: 'visible' }).then(() => 'success' as const),
        ]);
        if (outcome === 'warning') {
            await expect(async () => {
                if (await success.isVisible()) return;
                await warning.getByRole('button', { name: 'Reschedule', exact: true }).dispatchEvent('click');
                await expect(success).toBeVisible({ timeout: 5000 });
            }).toPass({ timeout: 30_000 });
        }
        await expect(success).toBeVisible();
    }

    /** Reschedule to a PAST day — the slot picker's confirm step must be accepted. */
    async rescheduleToPast(technicianName?: string): Promise<void> {
        await expect(async () => {
            if (await this.slotPicker.title.isVisible()) return;
            await this.page.getByRole('button', { name: 'Reschedule', exact: true }).dispatchEvent('click');
            await expect(this.slotPicker.title).toBeVisible({ timeout: 2000 });
        }).toPass({ timeout: 20_000 });
        await this.slotPicker.pickPastDaySlot(technicianName);
        const warning = this.page.getByRole('dialog').filter({ hasText: 'Blocked by time off' });
        const success = this.page.getByText('Job rescheduled', { exact: true });
        const outcome = await Promise.race([
            warning.waitFor({ state: 'visible' }).then(() => 'warning' as const),
            success.waitFor({ state: 'visible' }).then(() => 'success' as const),
        ]);
        if (outcome === 'warning') {
            await expect(async () => {
                if (await success.isVisible()) return;
                await warning.getByRole('button', { name: 'Reschedule', exact: true }).dispatchEvent('click');
                await expect(success).toBeVisible({ timeout: 5000 });
            }).toPass({ timeout: 30_000 });
        }
        await expect(success).toBeVisible();
    }
}
