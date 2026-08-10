import { expect, type Locator, type Page } from '@playwright/test';

export class SlotPicker {
    constructor(private readonly page: Page) {}

    get title(): Locator { return this.page.getByRole('heading', { name: 'Pick a time' }); }
    get nextDate(): Locator { return this.page.locator('.ctm-date-nav__arrow').nth(1); }
    get timelines(): Locator { return this.page.locator('.tech-timeline__grid'); }
    get confirm(): Locator { return this.page.getByRole('button', { name: /^Confirm / }); }

    private async timelineFor(technicianName?: string): Promise<Locator> {
        if (!technicianName) return this.timelines.first();

        await expect(this.page.locator('.ctm-tech-bar__name').first()).toBeVisible();
        for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
            const visibleNames = await this.page.locator('.ctm-tech-bar__name').allTextContents();
            const technicianIndex = visibleNames.findIndex((name) => name.trim() === technicianName);
            if (technicianIndex >= 0) return this.timelines.nth(technicianIndex);
            const nextTechPage = this.page.locator('.ctm-tech-bar-spacer--right .ctm-tech-bar__arrow');
            if (await nextTechPage.count() === 0 || !await nextTechPage.isEnabled()) break;
            await nextTechPage.click();
        }
        throw new Error(`Technician ${technicianName} was not present in the slot picker`);
    }

    async chooseNextDaySlot(technicianName?: string): Promise<void> {
        await expect(this.title).toBeVisible();
        await this.nextDate.click();
        const timeline = await this.timelineFor(technicianName);
        await expect(timeline).toBeVisible();
        await timeline.click({ position: { x: 24, y: 120 } });
        await expect(this.confirm).toBeEnabled();
    }

    async confirmSelection(): Promise<void> {
        await this.confirm.click();
        await expect(this.title).toBeHidden();
    }

    async pickNextDaySlot(technicianName?: string): Promise<void> {
        await this.chooseNextDaySlot(technicianName);
        await this.confirmSelection();
    }
}
