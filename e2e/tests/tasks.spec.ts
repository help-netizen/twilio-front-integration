import { expect, test } from '../fixtures/test';
import { ApiClient, type CleanupEntity } from '../fixtures/api';
import { hasAdmin } from '../fixtures/env';
import { ContactsPage } from '../pages/ContactsPage';
import { TasksPage } from '../pages/TasksPage';

test.describe('@suite:tasks', () => {
    test.skip(!hasAdmin(), 'requires E2E_ADMIN_USER / E2E_ADMIN_PASS');

    test.fixme('@p1 X-04 create a cross-entity task in the UI and show it in the list', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];
        const marker = ApiClient.runName('X-04 Contact Task');
        let taskId: number | undefined;

        try {
            const contact = await api.createContact('X-04 Task Contact');
            cleanup.push({ type: 'contact', id: contact.id }, { type: 'lead', id: contact.leadUuid });

            const contacts = new ContactsPage(page);
            await contacts.goto();
            await contacts.open(contact.name);
            await contacts.addTask(marker);

            await expect.poll(async () => (await api.findTask(marker))?.id).toBeTruthy();
            taskId = (await api.findTask(marker))?.id;
            expect(taskId, 'UI-created task was not returned by the tenant-scoped API').toBeDefined();
            cleanup.push({ type: 'task', id: taskId! });

            const tasks = new TasksPage(page);
            await tasks.goto();
            const row = await tasks.searchFor(marker);
            await expect(row).toContainText(marker);
            await expect(row).toContainText(contact.name);
            await expect(row).toContainText('Contact');
        } finally {
            if (!taskId) {
                const residual = await api.findTask(marker).catch(() => undefined);
                if (residual) cleanup.push({ type: 'task', id: residual.id });
            }
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });
});
