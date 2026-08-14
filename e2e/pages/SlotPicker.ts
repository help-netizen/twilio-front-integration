import { expect, type Locator, type Page } from '@playwright/test';

export class SlotPicker {
    constructor(private readonly page: Page) {}

    get title(): Locator { return this.page.getByRole('heading', { name: 'Pick a time' }); }
    get nextDate(): Locator { return this.page.locator('.ctm-date-nav__arrow').nth(1); }
    get prevDate(): Locator { return this.page.locator('.ctm-date-nav__arrow').nth(0); }
    get timelines(): Locator { return this.page.locator('.tech-timeline__grid'); }
    // Stable testid so it matches regardless of the button's label / past-confirm flow.
    get confirm(): Locator { return this.page.getByTestId('ctm-confirm'); }
    get pastConfirm(): Locator { return this.page.getByTestId('ctm-past-confirm'); }
    get pastConfirmYes(): Locator { return this.page.getByTestId('ctm-past-yes'); }

    private async timelineFor(technicianName?: string): Promise<Locator> {
        if (!technicianName) return this.timelines.first();

        await expect(this.page.locator('.ctm-tech-bar__name').first()).toBeVisible();
        for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
            const visibleNames = await this.page.locator('.ctm-tech-bar__name').allTextContents();
            const technicianIndex = visibleNames.findIndex((name) => name.trim() === technicianName);
            if (technicianIndex >= 0) return this.timelines.nth(technicianIndex);
            const nextTechPage = this.page.locator('.ctm-tech-bar-spacer--right .ctm-tech-bar__arrow');
            if (await nextTechPage.count() === 0 || !await nextTechPage.isEnabled()) break;
            await expect(async () => {
                const namesBefore = await this.page.locator('.ctm-tech-bar__name').allTextContents();
                if (namesBefore.some((name) => name.trim() === technicianName)) return;
                await this.page.locator('.ctm-tech-bar-spacer--right .ctm-tech-bar__arrow').dispatchEvent('click');
                await expect.poll(
                    () => this.page.locator('.ctm-tech-bar__name').allTextContents(),
                    { timeout: 2000 },
                ).not.toEqual(namesBefore);
            }).toPass({ timeout: 20_000 });
        }
        throw new Error(`Technician ${technicianName} was not present in the slot picker`);
    }

    async chooseNextDaySlot(technicianName?: string): Promise<void> {
        await expect(this.title).toBeVisible();
        const dateLabel = this.page.locator('.ctm-date-nav__text');
        const dateBefore = await dateLabel.textContent();
        await expect(async () => {
            if (await dateLabel.textContent() !== dateBefore) return;
            await this.nextDate.dispatchEvent('click');
            await expect(dateLabel).not.toHaveText(dateBefore || '', { timeout: 2000 });
        }).toPass({ timeout: 20_000 });

        await expect(async () => {
            if (await this.page.locator('.tech-timeline__selected').count() > 0) return;
            const timeline = await this.timelineFor(technicianName);
            await expect(timeline).toBeVisible({ timeout: 2000 });
            const box = await timeline.boundingBox();
            if (!box) throw new Error('Slot timeline had no bounding box');
            const clientX = box.x + 24;
            const clientY = box.y + 120;
            await timeline.dispatchEvent('mousemove', { clientX, clientY });
            await timeline.dispatchEvent('click', { clientX, clientY });
            await expect(this.page.locator('.tech-timeline__selected')).toBeVisible({ timeout: 2000 });
            await expect(this.confirm).toBeEnabled({ timeout: 2000 });
        }).toPass({ timeout: 20_000 });
    }

    async confirmSelection(): Promise<void> {
        await expect(async () => {
            if (await this.title.isHidden()) return;
            await this.confirm.dispatchEvent('click');
            await expect(this.title).toBeHidden({ timeout: 2000 });
        }).toPass({ timeout: 20_000 });
    }

    async pickNextDaySlot(technicianName?: string): Promise<void> {
        await this.chooseNextDaySlot(technicianName);
        await this.confirmSelection();
    }

    /** Navigate BACK to an earlier (past) day and select a slot on the grid. */
    async choosePastDaySlot(technicianName?: string): Promise<void> {
        await expect(this.title).toBeVisible();
        const dateLabel = this.page.locator('.ctm-date-nav__text');
        const dateBefore = await dateLabel.textContent();
        await expect(async () => {
            if (await dateLabel.textContent() !== dateBefore) return;
            await this.prevDate.dispatchEvent('click');
            await expect(dateLabel).not.toHaveText(dateBefore || '', { timeout: 2000 });
        }).toPass({ timeout: 20_000 });

        await expect(async () => {
            if (await this.page.locator('.tech-timeline__selected').count() > 0) return;
            const timeline = await this.timelineFor(technicianName);
            await expect(timeline).toBeVisible({ timeout: 2000 });
            const box = await timeline.boundingBox();
            if (!box) throw new Error('Slot timeline had no bounding box');
            const clientX = box.x + 24;
            const clientY = box.y + 120;
            await timeline.dispatchEvent('mousemove', { clientX, clientY });
            await timeline.dispatchEvent('click', { clientX, clientY });
            await expect(this.page.locator('.tech-timeline__selected')).toBeVisible({ timeout: 2000 });
            await expect(this.confirm).toBeEnabled({ timeout: 2000 });
        }).toPass({ timeout: 20_000 });
    }

    /** Confirm a PAST slot: the picker asks to confirm (dialog/sheet) before it books. */
    async confirmPastSelection(): Promise<void> {
        await expect(async () => {
            if (await this.title.isHidden()) return;
            await this.confirm.dispatchEvent('click');
            await expect(this.pastConfirm).toBeVisible({ timeout: 2000 });
            await this.pastConfirmYes.dispatchEvent('click');
            await expect(this.title).toBeHidden({ timeout: 2000 });
        }).toPass({ timeout: 20_000 });
    }

    async pickPastDaySlot(technicianName?: string): Promise<void> {
        await this.choosePastDaySlot(technicianName);
        await this.confirmPastSelection();
    }
}
