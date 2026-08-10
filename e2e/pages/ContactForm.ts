import type { Page } from '@playwright/test';
import { LeadsPage } from './LeadsPage';
import type { LeadFormValues } from './CreateLeadDialog';

/**
 * ContactsPage has no standalone create affordance. E2E-REGRESSION-001 permits
 * this source-grounded fallback through CreateLeadDialog, which creates the
 * contact as part of lead/contact resolution.
 */
export class ContactForm {
    private readonly leads: LeadsPage;

    constructor(page: Page) {
        this.leads = new LeadsPage(page);
    }

    async create(values: LeadFormValues): Promise<void> {
        await this.leads.goto();
        const dialog = await this.leads.openCreate();
        await dialog.create(values);
    }
}
