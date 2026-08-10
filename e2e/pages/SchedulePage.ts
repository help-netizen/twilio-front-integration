import { expect, type Locator, type Page } from '@playwright/test';
import { NewJobModal } from './NewJobModal';

export class SchedulePage {
    readonly newJob: NewJobModal;

    constructor(private readonly page: Page) {
        this.newJob = new NewJobModal(page);
    }

    get search(): Locator { return this.page.getByPlaceholder('type to find anything...'); }
    get viewSelect(): Locator { return this.page.locator('.schedule-calendar-controls select'); }
    get newJobButton(): Locator { return this.page.getByRole('button', { name: 'New job', exact: true }); }

    async goto(): Promise<void> {
        await this.page.goto('/schedule');
        await expect(this.search).toBeVisible();
    }

    async openNewJob(): Promise<NewJobModal> {
        await this.newJobButton.click();
        await expect(this.newJob.title).toBeVisible();
        return this.newJob;
    }

    async showTeamWeek(): Promise<void> {
        await this.viewSelect.selectOption('timeline-week');
    }

    async focusWeekContaining(isoDate: string): Promise<void> {
        const todayButton = this.page.getByRole('button', { name: 'Today', exact: true });
        await todayButton.click();
        const now = new Date();
        const target = new Date(isoDate);
        const currentWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
        const targetWeek = new Date(target.getFullYear(), target.getMonth(), target.getDate() - target.getDay());
        const weeks = Math.round((targetWeek.getTime() - currentWeek.getTime()) / (7 * 24 * 60 * 60 * 1000));
        const navigationButtons = todayButton.locator('..').locator('button');
        const direction = weeks >= 0 ? navigationButtons.nth(2) : navigationButtons.nth(0);
        for (let index = 0; index < Math.abs(weeks); index += 1) await direction.click();
    }

    scheduleCard(marker: string): Locator {
        return this.page.getByRole('button').filter({ hasText: marker }).first();
    }

    async findScheduled(
        marker: string,
        technicianName?: string,
        scheduledAt?: string,
        cardMarker = marker,
    ): Promise<Locator> {
        await this.showTeamWeek();
        if (scheduledAt) await this.focusWeekContaining(scheduledAt);
        await this.search.fill(marker);
        const card = this.scheduleCard(cardMarker);
        await expect(async () => {
            if (await card.isVisible()) return;
            // A just-created job can miss the board's first schedule fetch. Reload
            // the board and rebuild its view/filter state on every bounded retry.
            await this.page.reload();
            await expect(this.search).toBeVisible({ timeout: 5000 });
            await this.showTeamWeek();
            if (scheduledAt) await this.focusWeekContaining(scheduledAt);
            await this.search.fill(marker);
            await expect(card).toBeVisible({ timeout: 5000 });
        }).toPass({ timeout: 30_000 });
        if (technicianName) await expect(card).toContainText(technicianName);
        return card;
    }

    /** P1 helper grounded in TimelineWeekView's data-schedule-item wrapper. */
    async dragJobToProvider(marker: string, targetProvider: string): Promise<void> {
        await this.showTeamWeek();
        const source = this.page.locator('[data-schedule-item]').filter({ hasText: marker }).first();
        const headerCell = this.page.getByText(targetProvider, { exact: true }).first()
            .locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " text-center ")][1]');
        const columnIndex = await headerCell.evaluate((element) => {
            const siblings = element.parentElement ? Array.from(element.parentElement.children) : [];
            return siblings.indexOf(element);
        });
        const dayRow = source.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " grid ")][1]');
        const targetCell = dayRow.locator(':scope > div').nth(columnIndex);
        await source.dragTo(targetCell);
    }
}
