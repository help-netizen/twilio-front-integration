import { test } from '../fixtures/test';
import { ApiClient, type CleanupEntity } from '../fixtures/api';
import { hasAdmin } from '../fixtures/env';
import { PulsePage } from '../pages/PulsePage';

test.describe('@suite:pulse', () => {
    test.skip(!hasAdmin(), 'requires E2E_ADMIN_USER / E2E_ADMIN_PASS');

    test('@p1 X-03 pulse renders the timeline list and opens one timeline', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const contact = await api.createContact('X-03 Pulse Contact');
            cleanup.push({ type: 'contact', id: contact.id }, { type: 'lead', id: contact.leadUuid });
            const timelineId = await api.ensureTimeline(contact);
            const task = await api.createTask('timeline', timelineId, 'X-03 Timeline Task');
            cleanup.push({ type: 'task', id: task.id });

            const pulse = new PulsePage(page);
            await pulse.goto();
            await pulse.open(contact.name, timelineId, task.marker);
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });
});
