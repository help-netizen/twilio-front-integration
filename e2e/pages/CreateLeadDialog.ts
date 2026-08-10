import { expect, type Locator, type Page } from '@playwright/test';

export interface LeadFormValues {
    name: string;
    phone: string;
    email?: string;
    description?: string;
}

export class CreateLeadDialog {
    constructor(private readonly page: Page) {}

    get title(): Locator { return this.page.getByRole('heading', { name: 'New lead' }); }
    get firstName(): Locator { return this.page.locator('#cld-first'); }
    get lastName(): Locator { return this.page.locator('#cld-last'); }
    get phone(): Locator { return this.page.locator('#cld-phone'); }
    get email(): Locator { return this.page.locator('#cld-email'); }
    get jobType(): Locator { return this.page.locator('#cld-job-type'); }
    get jobSource(): Locator { return this.page.locator('#cld-job-source'); }
    get description(): Locator { return this.page.getByLabel('Description'); }
    get submit(): Locator { return this.page.getByRole('button', { name: 'Create Lead', exact: true }); }

    private async selectOption(trigger: () => Locator, option: () => Locator): Promise<void> {
        await expect(async () => {
            if (await option().count() > 0) return;
            await trigger().dispatchEvent('click');
            await expect(option()).toBeVisible({ timeout: 2000 });
        }).toPass({ timeout: 20_000 });

        const optionLabel = (await option().textContent())?.trim() || '';
        await expect(async () => {
            if (await option().count() === 0) {
                await expect(trigger()).toContainText(optionLabel, { timeout: 2000 });
                return;
            }
            await option().dispatchEvent('click');
            await expect(option()).toHaveCount(0, { timeout: 2000 });
            await expect(trigger()).toContainText(optionLabel, { timeout: 2000 });
        }).toPass({ timeout: 20_000 });
    }

    async fill(values: LeadFormValues): Promise<void> {
        const [first, ...last] = values.name.trim().split(/\s+/);
        await this.firstName.fill(first);
        await this.lastName.fill(last.join(' ') || 'Lead');
        await this.phone.fill(values.phone);
        if (values.email) await this.email.fill(values.email);

        await this.selectOption(
            () => this.jobType,
            () => this.page.getByRole('option').first(),
        );
        await this.selectOption(
            () => this.jobSource,
            () => this.page.getByRole('option', { name: 'Other', exact: true }),
        );
        if (values.description) await this.description.fill(values.description);
    }

    async create(values: LeadFormValues): Promise<void> {
        await this.fill(values);
        await expect(async () => {
            if (await this.title.isHidden()) return;
            await expect(this.submit).toBeEnabled({ timeout: 2000 });
            await this.submit.dispatchEvent('click');
            await expect(this.title).toBeHidden({ timeout: 5000 });
        }).toPass({ timeout: 30_000 });
    }
}
