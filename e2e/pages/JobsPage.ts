import { expect, type Locator, type Page } from '@playwright/test';
import { NewJobModal } from './NewJobModal';

export class JobsPage {
    readonly newJob: NewJobModal;

    constructor(private readonly page: Page) {
        this.newJob = new NewJobModal(page);
    }

    get search(): Locator { return this.page.getByPlaceholder('type to find anything...'); }
    get newJobButton(): Locator { return this.page.getByRole('button', { name: 'New Job', exact: true }); }

    async goto(): Promise<void> {
        await this.page.goto('/jobs');
        await expect(this.newJobButton).toBeVisible();
    }

    async openNewJob(): Promise<NewJobModal> {
        await this.newJobButton.click();
        await expect(this.newJob.title).toBeVisible();
        return this.newJob;
    }

    async openJob(id: number, marker: string): Promise<void> {
        await this.page.goto(`/jobs/${id}`);
        await expect(this.page.getByRole('heading', { name: marker, exact: true })).toBeVisible();
    }

    jobRow(marker: string): Locator {
        return this.page.getByRole('row').filter({ hasText: marker }).first();
    }

    async searchFor(marker: string): Promise<Locator> {
        await this.search.fill(marker);
        const row = this.jobRow(marker);
        await expect(row).toBeVisible();
        return row;
    }
}
