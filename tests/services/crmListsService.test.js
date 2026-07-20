jest.mock('../../backend/src/services/crmAccountsService', () => ({
    getTopAccountsByPipeline: jest.fn(),
    getStaleAccounts: jest.fn(),
}));
jest.mock('../../backend/src/services/crmContactsService', () => ({
    getContactsMissingFields: jest.fn(),
}));
jest.mock('../../backend/src/services/crmDealsService', () => ({
    getOpenDeals: jest.fn(),
    getDealsClosingBetween: jest.fn(),
    getDealsWithoutActivity: jest.fn(),
    getDealsWithoutNextStep: jest.fn(),
}));
jest.mock('../../backend/src/services/crmTasksService', () => ({
    listTasks: jest.fn(),
}));

const dealsService = require('../../backend/src/services/crmDealsService');
const accountsService = require('../../backend/src/services/crmAccountsService');
const contactsService = require('../../backend/src/services/crmContactsService');
const tasksService = require('../../backend/src/services/crmTasksService');
const listsService = require('../../backend/src/services/crmListsService');

describe('crmListsService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-06-03T12:00:00.000Z'));
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('lists predefined Sales workflow definitions', () => {
        const workflows = listsService.listWorkflows();

        expect(workflows.map(item => item.key)).toEqual([
            'my_open_deals',
            'deals_closing_this_month',
            'deals_closing_this_quarter',
            'deals_without_activity',
            'deals_without_next_step',
            'risky_deals',
            'top_accounts_by_pipeline',
            'accounts_needing_follow_up',
            'contacts_missing_role_title_email',
            'tasks_due_this_week',
        ]);
        expect(workflows).toEqual(expect.arrayContaining([
            expect.objectContaining({
                key: 'deals_without_activity',
                tool: 'crm.find_deals_without_activity',
                default_args: { days: 14 },
            }),
        ]));
    });

    test('my_open_deals uses current actor as default owner', async () => {
        dealsService.getOpenDeals.mockResolvedValue([{ id: 1 }]);

        const result = await listsService.getList('company-1', 'my_open_deals', {}, { actorId: 'user-1' });

        expect(result).toEqual([{ id: 1 }]);
        expect(dealsService.getOpenDeals).toHaveBeenCalledWith('company-1', {
            owner_user_id: 'user-1',
            limit: 100,
        });
    });

    test('my_open_deals supports explicit matching owner and limit override', async () => {
        dealsService.getOpenDeals.mockResolvedValue([{ id: 2 }]);

        await listsService.getList('company-1', 'my_open_deals', { owner_user_id: 'user-1', limit: 25 }, { actorId: 'user-1' });

        expect(dealsService.getOpenDeals).toHaveBeenCalledWith('company-1', {
            owner_user_id: 'user-1',
            limit: 25,
        });
    });

    test('my_open_deals rejects missing actor and cross-owner scope', async () => {
        await expect(listsService.getList('company-1', 'my_open_deals'))
            .rejects.toMatchObject({ code: 'BAD_REQUEST', details: { field: 'owner_user_id' } });

        await expect(listsService.getList(
            'company-1',
            'my_open_deals',
            { owner_user_id: 'user-2' },
            { actorId: null },
        )).rejects.toMatchObject({ code: 'BAD_REQUEST', details: { field: 'owner_user_id' } });

        await expect(listsService.getList('company-1', 'my_open_deals', { owner_user_id: 'user-2' }, { actorId: 'user-1' }))
            .rejects.toMatchObject({ code: 'BAD_REQUEST', details: { field: 'owner_user_id' } });

        expect(dealsService.getOpenDeals).not.toHaveBeenCalled();
    });

    test('closing month and quarter workflows use company timezone calendar windows', async () => {
        dealsService.getDealsClosingBetween.mockResolvedValue([]);

        await listsService.getList('company-1', 'deals_closing_this_month', {}, { companyTimezone: 'America/New_York' });
        expect(dealsService.getDealsClosingBetween).toHaveBeenLastCalledWith('company-1', '2026-06-01', '2026-06-30');

        await listsService.getList('company-1', 'deals_closing_this_quarter', {}, { companyTimezone: 'America/New_York' });
        expect(dealsService.getDealsClosingBetween).toHaveBeenLastCalledWith('company-1', '2026-04-01', '2026-06-30');
    });

    test('closing windows follow local company date near UTC midnight', async () => {
        jest.setSystemTime(new Date('2026-07-01T03:30:00.000Z'));
        dealsService.getDealsClosingBetween.mockResolvedValue([]);

        await listsService.getList('company-1', 'deals_closing_this_month', {}, { companyTimezone: 'America/New_York' });
        expect(dealsService.getDealsClosingBetween).toHaveBeenLastCalledWith('company-1', '2026-06-01', '2026-06-30');

        await listsService.getList('company-1', 'deals_closing_this_quarter', {}, { companyTimezone: 'America/New_York' });
        expect(dealsService.getDealsClosingBetween).toHaveBeenLastCalledWith('company-1', '2026-04-01', '2026-06-30');
    });

    test('deal hygiene workflows dispatch to deal services with workflow defaults', async () => {
        dealsService.getDealsWithoutActivity.mockResolvedValue([{ id: 3 }]);
        dealsService.getDealsWithoutNextStep.mockResolvedValue([{ id: 4 }]);

        await expect(listsService.getList('company-1', 'deals_without_activity')).resolves.toEqual([{ id: 3 }]);
        expect(dealsService.getDealsWithoutActivity).toHaveBeenCalledWith('company-1', 14);

        await expect(listsService.getList('company-1', 'deals_without_activity', { days: 21 })).resolves.toEqual([{ id: 3 }]);
        expect(dealsService.getDealsWithoutActivity).toHaveBeenLastCalledWith('company-1', 21);

        await expect(listsService.getList('company-1', 'deals_without_next_step')).resolves.toEqual([{ id: 4 }]);
        expect(dealsService.getDealsWithoutNextStep).toHaveBeenCalledWith('company-1');
    });

    test('deals_without_activity does not mask invalid days with the default', async () => {
        dealsService.getDealsWithoutActivity.mockRejectedValue(Object.assign(new Error('days must be a positive integer'), { code: 'BAD_REQUEST' }));

        await expect(listsService.getList('company-1', 'deals_without_activity', { days: 0 }))
            .rejects.toMatchObject({ code: 'BAD_REQUEST' });

        expect(dealsService.getDealsWithoutActivity).toHaveBeenCalledWith('company-1', 0);
    });

    test('risky_deals honors requested limit before filtering open deals', async () => {
        dealsService.getOpenDeals.mockResolvedValue([
            { id: 1, risk_summary: 'Budget risk' },
            { id: 2, blocker_summary: 'Legal' },
            { id: 3 },
        ]);

        const result = await listsService.getList('company-1', 'risky_deals', { limit: 25 });

        expect(dealsService.getOpenDeals).toHaveBeenCalledWith('company-1', { limit: 25 });
        expect(result).toEqual([
            { id: 1, risk_summary: 'Budget risk' },
            { id: 2, blocker_summary: 'Legal' },
        ]);
    });

    test('risky_deals defaults to a bounded open-deal lookup', async () => {
        dealsService.getOpenDeals.mockResolvedValue([]);

        await listsService.getList('company-1', 'risky_deals');

        expect(dealsService.getOpenDeals).toHaveBeenCalledWith('company-1', { limit: 100 });
    });

    test('account, contact, and task workflows dispatch to their services', async () => {
        accountsService.getTopAccountsByPipeline.mockResolvedValue([{ id: 1, pipeline_amount: 1000 }]);
        accountsService.getStaleAccounts.mockResolvedValue([{ id: 2 }]);
        contactsService.getContactsMissingFields.mockResolvedValue([{ id: 3 }]);
        tasksService.listTasks.mockResolvedValue([{ id: 4 }]);

        await expect(listsService.getList('company-1', 'top_accounts_by_pipeline', { limit: 5 })).resolves.toEqual([{ id: 1, pipeline_amount: 1000 }]);
        expect(accountsService.getTopAccountsByPipeline).toHaveBeenCalledWith('company-1', { limit: 5 });

        await expect(listsService.getList('company-1', 'accounts_needing_follow_up', { days: 21, owner_user_id: 'user-2', limit: 10 })).resolves.toEqual([{ id: 2 }]);
        expect(accountsService.getStaleAccounts).toHaveBeenCalledWith('company-1', 21, {
            days: 21,
            owner_user_id: 'user-2',
            limit: 10,
        });

        accountsService.getStaleAccounts.mockRejectedValueOnce(Object.assign(new Error('days must be a positive integer'), { code: 'BAD_REQUEST' }));
        await expect(listsService.getList('company-1', 'accounts_needing_follow_up', { days: 0 }))
            .rejects.toMatchObject({ code: 'BAD_REQUEST' });
        expect(accountsService.getStaleAccounts).toHaveBeenLastCalledWith('company-1', 0, { days: 0 });

        await expect(listsService.getList('company-1', 'contacts_missing_role_title_email')).resolves.toEqual([{ id: 3 }]);
        expect(contactsService.getContactsMissingFields).toHaveBeenCalledWith('company-1');

        await expect(listsService.getList('company-1', 'tasks_due_this_week', {}, { companyTimezone: 'America/New_York' })).resolves.toEqual([{ id: 4 }]);
        expect(tasksService.listTasks).toHaveBeenCalledWith('company-1', {
            status: 'open',
            due_from: '2026-06-01T04:00:00.000Z',
            due_to: '2026-06-08T03:59:59.999Z',
            limit: 100,
        });
    });

    test('unsupported workflow list returns allowed values', async () => {
        await expect(listsService.getList('company-1', 'unknown_workflow'))
            .rejects.toMatchObject({
                code: 'BAD_REQUEST',
                details: {
                    allowed_values: expect.arrayContaining(['my_open_deals', 'tasks_due_this_week']),
                },
            });
    });
});
