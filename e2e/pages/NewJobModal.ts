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
        // The candidate dropdown renders inside the panel dialog and its click point is
        // intermittently covered by the Radix scrim (fixed inset-0 z-[140]) — the element
        // is visible+stable, but BOTH a normal click and force:true route to the topmost
        // element (the scrim), so pickContact never fires. dispatchEvent fires React's
        // onClick directly on the candidate regardless of coverage. Re-query per retry in
        // case an SSE tick re-mounts it; stop once the dropdown closed (candidate → picked).
        const candidate = () => this.page.locator('.cld-candidates__item').filter({ hasText: marker }).first();
        await expect(candidate()).toBeVisible();
        await expect(async () => {
            if (await candidate().count() === 0) return; // already picked
            await candidate().dispatchEvent('click');
            await expect(candidate()).toHaveCount(0, { timeout: 2000 });
        }).toPass({ timeout: 20_000 });
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
