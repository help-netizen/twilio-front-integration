import { expect, type Locator, type Page } from '@playwright/test';

export class PulsePage {
    constructor(private readonly page: Page) {}

    get search(): Locator { return this.page.getByPlaceholder('type to find anything...'); }

    async goto(): Promise<void> {
        await this.page.goto('/pulse');
        await expect(this.page.getByRole('heading', { name: 'Pulse', exact: true })).toBeVisible();
        await expect(this.search).toBeVisible();
    }

    timeline(marker: string): Locator {
        return this.page.getByRole('button').filter({ hasText: marker }).first();
    }

    async searchFor(marker: string): Promise<Locator> {
        await this.search.fill(marker);
        const timeline = this.timeline(marker);
        await expect(timeline).toBeVisible();
        return timeline;
    }

    async open(marker: string, timelineId: number, taskMarker: string): Promise<void> {
        await (await this.searchFor(marker)).click();
        // TIMELINE-NUMBERING: the URL is now the durable public_code (or the legacy numeric id).
        await expect(this.page).toHaveURL(new RegExp(`/pulse/timeline/(${timelineId}|[0-9A-Za-z]+)$`));
        const actionRequired = this.page.getByRole('region', { name: 'Action Required', exact: true });
        await expect(actionRequired.getByText(taskMarker, { exact: true })).toBeVisible();
    }
}
