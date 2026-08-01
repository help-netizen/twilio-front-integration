'use strict';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const service = require('../backend/src/services/notificationPolicyService');

const COMPANY_A = '00000000-0000-4000-8000-00000000000a';
const USER_A = '10000000-0000-4000-8000-00000000000a';

describe('notificationPolicyService category settings', () => {
    beforeEach(() => {
        delete process.env.VAPID_PUBLIC_KEY;
    });

    test('returns five ordered categories, default-on absence, and device status', async () => {
        process.env.VAPID_PUBLIC_KEY = 'public-key';
        const client = {
            query: jest.fn().mockResolvedValue({
                rows: [{ preferences: { leads: false }, browser_push_subscribed: true }],
            }),
        };

        const settings = await service.getNotificationSettings(COMPANY_A, USER_A, { client });

        expect(settings.categories.map(category => category.key)).toEqual([
            'job_schedule', 'leads', 'calls_messages', 'finance', 'tasks',
        ]);
        expect(settings.categories.find(category => category.key === 'leads').enabled).toBe(false);
        expect(settings.categories.filter(category => category.key !== 'leads')
            .every(category => category.enabled)).toBe(true);
        expect(settings.device.browser_push).toEqual({
            supported: true,
            permission: 'unknown',
            subscribed: true,
        });
        expect(client.query.mock.calls[0][1]).toEqual([COMPANY_A, USER_A]);
    });

    test('upserts only the current tenant/user/category tuple', async () => {
        const client = { query: jest.fn().mockResolvedValue({ rows: [{ enabled: false }] }) };
        const result = await service.updateCurrentUserCategory(
            COMPANY_A,
            USER_A,
            'finance',
            { enabled: false },
            { client }
        );

        expect(result).toMatchObject({ key: 'finance', enabled: false });
        const [sql, params] = client.query.mock.calls[0];
        expect(sql).toContain('ON CONFLICT (company_id, user_id, category)');
        expect(params).toEqual([COMPANY_A, USER_A, 'finance', false]);
    });

    test.each(['unknown', 'admin_system'])(
        'rejects non-user category %s before SQL',
        async category => {
            const client = { query: jest.fn() };
            await expect(service.updateCurrentUserCategory(
                COMPANY_A,
                USER_A,
                category,
                { enabled: true },
                { client }
            )).rejects.toMatchObject({
                status: 404,
                code: 'NOTIFICATION_CATEGORY_NOT_FOUND',
            });
            expect(client.query).not.toHaveBeenCalled();
        }
    );

    test('rejects identity fields and non-boolean values before SQL', async () => {
        const client = { query: jest.fn() };
        for (const body of [
            { enabled: 'true' },
            { enabled: true, user_id: 'someone-else' },
            {},
        ]) {
            await expect(service.updateCurrentUserCategory(
                COMPANY_A,
                USER_A,
                'leads',
                body,
                { client }
            )).rejects.toMatchObject({
                status: 400,
                code: 'INVALID_NOTIFICATION_PREFERENCE',
            });
        }
        expect(client.query).not.toHaveBeenCalled();
    });

    test('fails closed on missing tenant or CRM user context', async () => {
        const client = { query: jest.fn() };
        await expect(service.getNotificationSettings(null, USER_A, { client }))
            .rejects.toMatchObject({ status: 403, code: 'TENANT_CONTEXT_REQUIRED' });
        await expect(service.getNotificationSettings(COMPANY_A, null, { client }))
            .rejects.toMatchObject({ status: 409, code: 'NO_CRM_USER' });
        expect(client.query).not.toHaveBeenCalled();
    });
});
