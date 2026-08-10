import { expect, type Locator, type Page } from '@playwright/test';
import { SlotPicker } from './SlotPicker';

export interface NewJobValues {
    contactMarker: string;
    description: string;
}

/** Requested PO name; the real implementation is components/jobs/NewJobDialog.tsx. */
export class NewJobModal {
    readonly slotPicker: SlotPicker;

    constructor(private readonly page: Page) {
        this.slotPicker = new SlotPicker(page);
    }

    get title(): Locator { return this.page.getByRole('heading', { name: 'New job' }); }
    get contactSearch(): Locator {
        return this.page.getByPlaceholder('Search an existing contact by name or phone…');
    }
    get street(): Locator { return this.page.locator('#njd-street'); }
    get city(): Locator { return this.page.locator('#njd-city'); }
    get zip(): Locator { return this.page.locator('#njd-zip'); }
    get jobType(): Locator { return this.page.locator('#njd-type'); }
    get source(): Locator { return this.page.locator('#njd-source'); }
    get description(): Locator { return this.page.locator('#njd-desc'); }
    get pickTime(): Locator { return this.page.getByRole('button', { name: 'Pick time & provider' }); }
    get create(): Locator { return this.page.getByRole('button', { name: 'Create job', exact: true }); }

    async selectContact(marker: string): Promise<void> {
        await this.contactSearch.fill(marker);
        const candidate = this.page.locator('.cld-candidates__item').filter({ hasText: marker }).first();
        await expect(candidate).toBeVisible();
        await candidate.click();
    }

    async ensureAddress(): Promise<void> {
        if (await this.street.inputValue()) return;
        await this.street.fill('100 Test Street');
        await this.city.fill('New York');
        await this.zip.fill('10001');
    }

    async fillAndSubmit(values: NewJobValues): Promise<void> {
        await this.selectContact(values.contactMarker);
        await this.ensureAddress();
        await this.pickTime.click();
        await this.slotPicker.pickNextDaySlot();

        await this.jobType.click();
        await this.page.getByRole('option').first().click();
        await this.source.click();
        await this.page.getByRole('option', { name: 'Other', exact: true }).click();
        await this.description.fill(values.description);
        await this.create.click();
        await expect(this.title).toBeHidden();
    }
}
