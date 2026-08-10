import { expect, type Locator, type Page } from '@playwright/test';

export class TasksPage {
    constructor(private readonly page: Page) {}

    get search(): Locator { return this.page.getByPlaceholder('type to find anything...'); }

    async goto(): Promise<void> {
        await this.page.goto('/tasks');
        await expect(this.page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();
        await expect(this.search).toBeVisible();
    }

    taskRow(marker: string): Locator {
        return this.page.getByRole('row').filter({ hasText: marker }).first();
    }

    async searchFor(marker: string): Promise<Locator> {
        await this.search.fill(marker);
        const task = this.taskRow(marker);
        await expect(task).toBeVisible();
        return task;
    }
}
