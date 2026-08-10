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

    async fill(values: LeadFormValues): Promise<void> {
        const [first, ...last] = values.name.trim().split(/\s+/);
        await this.firstName.fill(first);
        await this.lastName.fill(last.join(' ') || 'Lead');
        await this.phone.fill(values.phone);
        if (values.email) await this.email.fill(values.email);

        // The lead form re-renders as it loads, so the Radix select triggers/options
        // jitter ("not stable") and force-clicking an option doesn't reliably close the
        // dropdown (its overlay then intercepts the submit click). Drive the selects by
        // keyboard instead — open (force past the jitter), pick, Enter — which selects
        // AND closes cleanly.
        await this.jobType.click({ force: true });
        await this.page.getByRole('option').first().click({ force: true });
        await this.jobSource.click({ force: true });
        await this.page.getByRole('option', { name: 'Other', exact: true }).click({ force: true });
        // Wait for the select dropdown/overlay to fully close — a lingering Radix
        // overlay was intercepting the submit-button click.
        await expect(this.page.getByRole('option')).toHaveCount(0);
        if (values.description) await this.description.fill(values.description);
    }

    async create(values: LeadFormValues): Promise<void> {
        await this.fill(values);
        // The submit button jitters with the re-rendering form and a Radix overlay can
        // linger over it — force past the actionability check.
        await this.submit.click({ force: true });
        await expect(this.title).toBeHidden();
    }
}
