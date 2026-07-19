const express = require('express');
const request = require('supertest');

jest.mock('../../backend/src/services/crmAccountsService', () => ({
    listAccounts: jest.fn(),
    getAccountCard: jest.fn(),
    getStaleAccounts: jest.fn(),
}));
jest.mock('../../backend/src/services/crmContactsService', () => ({
    listContacts: jest.fn(),
    getContactCard: jest.fn(),
    getKeyContactsByAccount: jest.fn(),
}));
jest.mock('../../backend/src/services/crmDealsService', () => ({
    listDeals: jest.fn(),
    getDealCard: jest.fn(),
    getDealHistory: jest.fn(),
    getAttentionDeals: jest.fn(),
    getOpenDeals: jest.fn(),
    getDealsWithoutNextStep: jest.fn(),
    getOverdueCloseDateDeals: jest.fn(),
    getDealsWithoutActivity: jest.fn(),
    getDealsClosingBetween: jest.fn(),
    updateDeal: jest.fn(),
}));
jest.mock('../../backend/src/services/crmPipelineService', () => ({
    getPipeline: jest.fn(),
    getPipelineByOwner: jest.fn(),
    getPipelineByTeam: jest.fn(),
    getPipelineByPeriod: jest.fn(),
    getPipelineStageGroups: jest.fn(),
    getPipelineForecastGroups: jest.fn(),
    getForecastTotals: jest.fn(),
    getPipelineChanges: jest.fn(),
    getPipelineRiskyDeals: jest.fn(),
    getPipelineSlippage: jest.fn(),
}));
jest.mock('../../backend/src/services/crmActivitiesService', () => ({
    listActivities: jest.fn(),
    getLastCustomerFacing: jest.fn(),
}));
jest.mock('../../backend/src/services/crmTasksService', () => ({
    listTasks: jest.fn(),
    createTask: jest.fn(),
    updateTaskStatus: jest.fn(),
}));
jest.mock('../../backend/src/services/crmNotesService', () => ({
    listNotes: jest.fn(),
    createNote: jest.fn(),
}));
jest.mock('../../backend/src/services/crmMetadataService', () => ({
    getMetadata: jest.fn(),
}));
jest.mock('../../backend/src/services/crmListsService', () => ({
    listWorkflows: jest.fn(),
    getList: jest.fn(),
}));

const accountsService = require('../../backend/src/services/crmAccountsService');
const dealsService = require('../../backend/src/services/crmDealsService');
const listsService = require('../../backend/src/services/crmListsService');
const pipelineService = require('../../backend/src/services/crmPipelineService');
const tasksService = require('../../backend/src/services/crmTasksService');
const notesService = require('../../backend/src/services/crmNotesService');
const activitiesService = require('../../backend/src/services/crmActivitiesService');
const registry = require('../../backend/src/services/crmMcpToolRegistry');
const crmMcpRouter = require('../../backend/src/routes/crmMcp');

const READ_PERMISSIONS = ['contacts.view', 'leads.view', 'tasks.view'];

function makeApp({ companyId = 'company-1', permissions = READ_PERMISSIONS, requestId = 'req-test' } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        if (requestId) req.requestId = requestId;
        req.companyFilter = companyId ? { company_id: companyId } : undefined;
        req.user = {
            sub: 'sub-1',
            email: 'seller@test.local',
            crmUser: { id: 'user-1' },
        };
        req.authz = {
            permissions,
            company: { id: companyId || 'company-1', status: 'active', timezone: 'America/New_York' },
        };
        next();
    });
    app.use('/api/crm/mcp', crmMcpRouter);
    return app;
}

describe('/api/crm/mcp routes', () => {
    beforeEach(() => jest.clearAllMocks());

    beforeEach(() => {
        listsService.listWorkflows.mockReturnValue([
            { key: 'my_open_deals', tool: 'crm.list_my_open_deals', default_args: { limit: 100 } },
            { key: 'tasks_due_this_week', tool: 'crm.tasks_due_this_week', default_args: {} },
        ]);
    });

    test('GET /tools returns stable tool definitions', async () => {
        const res = await request(makeApp({ permissions: [...READ_PERMISSIONS, 'sales.crm.write'] }))
            .get('/api/crm/mcp/tools');

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data.tools).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'crm.search_accounts', kind: 'read' }),
            expect.objectContaining({ name: 'crm.list_sales_workflows', kind: 'read' }),
            expect.objectContaining({ name: 'crm.update_deal_field', kind: 'write', requiresConfirmation: true }),
            expect.objectContaining({ name: 'crm.update_deal_next_step', kind: 'write', requiresConfirmation: true }),
        ]));
    });

    test('GET /tools can return read-only tool definitions only', async () => {
        const res = await request(makeApp()).get('/api/crm/mcp/tools?kind=read');

        expect(res.status).toBe(200);
        expect(res.body.data.tools.length).toBeGreaterThan(0);
        expect(res.body.data.tools.every(tool => tool.kind === 'read')).toBe(true);
        expect(res.body.data.tools.map(tool => tool.name)).not.toContain('crm.update_deal_field');
    });

    test('GET /tools filters discovery to the caller permissions', async () => {
        const res = await request(makeApp({ permissions: ['contacts.view'] }))
            .get('/api/crm/mcp/tools');
        const names = res.body.data.tools.map(tool => tool.name);

        expect(names).toContain('crm.search_accounts');
        expect(names).not.toContain('crm.search_deals');
        expect(names).not.toContain('crm.list_tasks');
        expect(names).not.toContain('crm.update_deal_field');
    });

    test('GET /tools exposes no delete or bulk mutation tools', async () => {
        const res = await request(makeApp()).get('/api/crm/mcp/tools');
        const names = res.body.data.tools.map(tool => tool.name);

        expect(names).not.toContain('crm.bulk_update_deals');
        expect(names.some(name => /delete|remove|archive|destroy/i.test(name))).toBe(false);
    });

    test('POST /call executes read tool with company scope', async () => {
        accountsService.listAccounts.mockResolvedValue([{ id: 1, name: 'Acme' }]);

        const res = await request(makeApp())
            .post('/api/crm/mcp/call')
            .send({
                tool: 'crm.search_accounts',
                arguments: { q: 'acme', limit: 5, company_id: 'company-foreign' },
            });

        expect(res.status).toBe(200);
        expect(res.body.structuredContent).toEqual([{ id: 1, name: 'Acme' }]);
        expect(res.body.content[0]).toEqual({ type: 'json', json: [{ id: 1, name: 'Acme' }] });
        expect(accountsService.listAccounts).toHaveBeenCalledWith('company-1', { q: 'acme', limit: 5 });
    });

    test('POST /call denies a tool outside the caller permission set', async () => {
        const res = await request(makeApp({ permissions: ['contacts.view'] }))
            .post('/api/crm/mcp/call')
            .send({ tool: 'crm.search_deals', arguments: {} });

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('access_denied');
        expect(dealsService.listDeals).not.toHaveBeenCalled();
    });

    test('POST /call fails closed when a registered tool has no permission mapping', async () => {
        const spy = jest.spyOn(registry, 'getTool').mockReturnValueOnce({
            name: 'crm.unmapped',
            kind: 'read',
            inputSchema: { type: 'object', properties: {}, required: [] },
        });
        try {
            const res = await request(makeApp({ permissions: ['contacts.view'] }))
                .post('/api/crm/mcp/call')
                .send({ tool: 'crm.unmapped', arguments: {} });

            expect(res.status).toBe(403);
            expect(res.body.error.details.reason).toBe('TOOL_PERMISSION_UNMAPPED');
        } finally {
            spy.mockRestore();
        }
    });

    test('POST /call validates tool arguments against runtime schema', async () => {
        const res = await request(makeApp())
            .post('/api/crm/mcp/call')
            .send({ tool: 'crm.get_deal', arguments: {} });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('invalid_request');
        expect(res.body.error.details.field).toBe('deal_id');
        expect(dealsService.getDealCard).not.toHaveBeenCalled();
    });

    test('POST /call rejects invalid CRM date arguments before dispatch', async () => {
        const res = await request(makeApp())
            .post('/api/crm/mcp/call')
            .send({
                tool: 'crm.find_deals_closing_between',
                arguments: { from_date: '2026-02-30', to_date: '2026-06-30' },
            });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('invalid_request');
        expect(res.body.error.details.field).toBe('from_date');
        expect(dealsService.getDealsClosingBetween).not.toHaveBeenCalled();
    });

    test('unsupported bulk tool returns unsupported_tool before service execution', async () => {
        const res = await request(makeApp({ permissions: ['sales.crm.write'] }))
            .post('/api/crm/mcp/call')
            .send({ tool: 'crm.bulk_update_deals', arguments: {} });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('unsupported_tool');
        expect(dealsService.updateDeal).not.toHaveBeenCalled();
    });

    test('caller with read permissions cannot invoke a write tool', async () => {
        const res = await request(makeApp({ permissions: ['leads.view'] }))
            .post('/api/crm/mcp/call')
            .send({
                tool: 'crm.update_deal_field',
                arguments: { deal_id: 9, field: 'next_step', value: 'New' },
                confirmation: { confirmed: true, confirmation_id: 'confirm-1' },
            });

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('access_denied');
        expect(dealsService.updateDeal).not.toHaveBeenCalled();
    });

    test('write tool requires explicit confirmation', async () => {
        const res = await request(makeApp({ permissions: ['sales.crm.write'] }))
            .post('/api/crm/mcp/call')
            .send({
                tool: 'crm.update_deal_field',
                arguments: { deal_id: 9, field: 'next_step', value: 'New' },
            });

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('confirmation_required');
        expect(dealsService.updateDeal).not.toHaveBeenCalled();
    });

    test('confirmed deal write returns before and after values', async () => {
        dealsService.updateDeal.mockResolvedValue({
            field: 'next_step',
            before: 'Old',
            after: 'New',
            deal: { id: 9, next_step: 'New' },
        });

        const res = await request(makeApp({ permissions: ['sales.crm.write'] }))
            .post('/api/crm/mcp/call')
            .send({
                tool: 'crm.update_deal_field',
                arguments: { deal_id: 9, field: 'next_step', value: 'New' },
                confirmation: { confirmed: true, confirmation_id: 'confirm-1' },
            });

        expect(res.status).toBe(200);
        expect(res.body.structuredContent).toMatchObject({ before: 'Old', after: 'New' });
        expect(dealsService.updateDeal).toHaveBeenCalledWith(
            'company-1',
            9,
            { next_step: 'New' },
            expect.objectContaining({
                actorId: 'user-1',
                actorEmail: 'seller@test.local',
                requestId: 'req-test',
                source: 'Codex/Sales MCP',
            })
        );
    });

    test('write tool generates request id when middleware did not provide one', async () => {
        dealsService.updateDeal.mockResolvedValue({
            field: 'next_step',
            before: 'Old',
            after: 'New',
            deal: { id: 9, next_step: 'New' },
        });

        const res = await request(makeApp({ permissions: ['sales.crm.write'], requestId: null }))
            .post('/api/crm/mcp/call')
            .send({
                tool: 'crm.update_deal_next_step',
                arguments: { deal_id: 9, value: 'New' },
                confirmation: { confirmed: true, confirmation_id: 'confirm-request-id' },
            });

        expect(res.status).toBe(200);
        expect(res.body.meta.request_id).toMatch(/^crm-mcp-/);
        expect(dealsService.updateDeal).toHaveBeenCalledWith(
            'company-1',
            9,
            { next_step: 'New' },
            expect.objectContaining({
                requestId: expect.stringMatching(/^crm-mcp-/),
            })
        );
    });

    test('explicit deal write tools dispatch one allowlisted field with actor and confirmation context', async () => {
        dealsService.updateDeal.mockResolvedValue({
            field: 'close_date',
            before: '2026-06-01',
            after: '2026-06-30',
            deal: { id: 9, close_date: '2026-06-30' },
        });

        const res = await request(makeApp({ permissions: ['sales.crm.write'] }))
            .post('/api/crm/mcp/call')
            .send({
                tool: 'crm.update_deal_close_date',
                arguments: { deal_id: 9, value: '2026-06-30' },
                confirmation: { confirmed: true, confirmation_id: 'confirm-close-date', reason: 'Forecast review' },
            });

        expect(res.status).toBe(200);
        expect(res.body.structuredContent).toMatchObject({
            field: 'close_date',
            before: '2026-06-01',
            after: '2026-06-30',
        });
        expect(dealsService.updateDeal).toHaveBeenCalledWith(
            'company-1',
            9,
            { close_date: '2026-06-30' },
            expect.objectContaining({
                actorId: 'user-1',
                actorEmail: 'seller@test.local',
                requestId: 'req-test',
                source: 'Codex/Sales MCP',
                confirmation: { confirmationId: 'confirm-close-date', reason: 'Forecast review' },
            })
        );
    });

    test('explicit deal write tools reject invalid typed values before dispatch', async () => {
        const invalidAmount = await request(makeApp({ permissions: ['sales.crm.write'] }))
            .post('/api/crm/mcp/call')
            .send({
                tool: 'crm.update_deal_amount',
                arguments: { deal_id: 9, value: -1 },
                confirmation: { confirmed: true, confirmation_id: 'confirm-amount' },
            });

        expect(invalidAmount.status).toBe(400);
        expect(invalidAmount.body.error.code).toBe('invalid_request');
        expect(invalidAmount.body.error.details.field).toBe('value');

        const invalidCloseDate = await request(makeApp({ permissions: ['sales.crm.write'] }))
            .post('/api/crm/mcp/call')
            .send({
                tool: 'crm.update_deal_close_date',
                arguments: { deal_id: 9, value: '2026-06-31' },
                confirmation: { confirmed: true, confirmation_id: 'confirm-close-date' },
            });

        expect(invalidCloseDate.status).toBe(400);
        expect(invalidCloseDate.body.error.code).toBe('invalid_request');
        expect(invalidCloseDate.body.error.details.field).toBe('value');
        expect(dealsService.updateDeal).not.toHaveBeenCalled();
    });

    test('generic deal write validates value type for selected allowlisted field', async () => {
        const res = await request(makeApp({ permissions: ['sales.crm.write'] }))
            .post('/api/crm/mcp/call')
            .send({
                tool: 'crm.update_deal_field',
                arguments: { deal_id: 9, field: 'amount', value: '25000' },
                confirmation: { confirmed: true, confirmation_id: 'confirm-generic-amount' },
            });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('invalid_request');
        expect(res.body.error.details.field).toBe('value');
        expect(dealsService.updateDeal).not.toHaveBeenCalled();
    });

    test('sales list uses current user context for my_open_deals', async () => {
        listsService.getList.mockResolvedValue([{ id: 1 }]);

        const res = await request(makeApp())
            .post('/api/crm/mcp/call')
            .send({ tool: 'crm.get_sales_list', arguments: { list_key: 'my_open_deals' } });

        expect(res.status).toBe(200);
        expect(listsService.getList).toHaveBeenCalledWith(
            'company-1',
            'my_open_deals',
            {},
            expect.objectContaining({ actorId: 'user-1' })
        );
    });

    test('sales workflow discovery returns predefined workflow mappings', async () => {
        const res = await request(makeApp())
            .post('/api/crm/mcp/call')
            .send({ tool: 'crm.list_sales_workflows', arguments: {} });

        expect(res.status).toBe(200);
        expect(res.body.structuredContent).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'my_open_deals', tool: 'crm.list_my_open_deals' }),
            expect.objectContaining({ key: 'tasks_due_this_week', tool: 'crm.tasks_due_this_week' }),
        ]));
    });

    test('explicit my open deals tool uses current user context', async () => {
        listsService.getList.mockResolvedValue([{ id: 2 }]);

        const res = await request(makeApp())
            .post('/api/crm/mcp/call')
            .send({ tool: 'crm.list_my_open_deals', arguments: { limit: 10 } });

        expect(res.status).toBe(200);
        expect(listsService.getList).toHaveBeenCalledWith(
            'company-1',
            'my_open_deals',
            { limit: 10 },
            expect.objectContaining({ actorId: 'user-1' })
        );
    });

    test('read-only deal hygiene tools do not require write permission', async () => {
        dealsService.getDealsWithoutNextStep.mockResolvedValue([{ id: 9 }]);
        listsService.getList.mockResolvedValue([{ id: 10 }]);

        const missingNextStep = await request(makeApp())
            .post('/api/crm/mcp/call')
            .send({ tool: 'crm.find_deals_without_next_step', arguments: {} });
        expect(missingNextStep.status).toBe(200);
        expect(missingNextStep.body.structuredContent).toEqual([{ id: 9 }]);
        expect(dealsService.getDealsWithoutNextStep).toHaveBeenCalledWith('company-1');

        const stale = await request(makeApp())
            .post('/api/crm/mcp/call')
            .send({ tool: 'crm.find_deals_without_activity', arguments: { days: 14 } });
        expect(stale.status).toBe(200);
        expect(stale.body.structuredContent).toEqual([{ id: 10 }]);
        expect(listsService.getList).toHaveBeenCalledWith(
            'company-1',
            'deals_without_activity',
            { days: 14 },
            expect.objectContaining({ actorId: 'user-1' })
        );
    });

    test('read-only deal date aliases dispatch to deal service', async () => {
        dealsService.getOverdueCloseDateDeals.mockResolvedValue([{ id: 11 }]);
        dealsService.getDealsClosingBetween.mockResolvedValue([{ id: 12 }]);

        const overdue = await request(makeApp())
            .post('/api/crm/mcp/call')
            .send({ tool: 'crm.find_overdue_close_date_deals', arguments: {} });
        expect(overdue.status).toBe(200);
        expect(dealsService.getOverdueCloseDateDeals).toHaveBeenCalledWith('company-1');

        const closing = await request(makeApp())
            .post('/api/crm/mcp/call')
            .send({
                tool: 'crm.find_deals_closing_between',
                arguments: { from_date: '2026-06-01', to_date: '2026-06-30' },
            });
        expect(closing.status).toBe(200);
        expect(dealsService.getDealsClosingBetween).toHaveBeenCalledWith('company-1', '2026-06-01', '2026-06-30');
    });

    test('last customer-facing activity tool maps entity_type to entity filter', async () => {
        activitiesService.getLastCustomerFacing.mockResolvedValue({ id: 3, summary: 'Customer call' });

        const res = await request(makeApp())
            .post('/api/crm/mcp/call')
            .send({ tool: 'crm.get_last_customer_facing_activity', arguments: { entity_type: 'deal', entity_id: 9 } });

        expect(res.status).toBe(200);
        expect(activitiesService.getLastCustomerFacing).toHaveBeenCalledWith('company-1', { deal_id: 9 });
    });

    test('pipeline analytics tools dispatch to pipeline service with current scope', async () => {
        pipelineService.getPipelineByOwner.mockResolvedValue({ totals: { pipeline: 100 } });
        pipelineService.getPipelineByTeam.mockResolvedValue({ totals: { pipeline: 200 } });
        pipelineService.getPipelineByPeriod.mockResolvedValue({ totals: { pipeline: 300 } });
        pipelineService.getPipelineStageGroups.mockResolvedValue({ by_stage: [] });
        pipelineService.getPipelineForecastGroups.mockResolvedValue({ by_forecast_category: [] });
        pipelineService.getForecastTotals.mockResolvedValue({ totals: {} });
        pipelineService.getPipelineChanges.mockResolvedValue({ changes: [] });
        pipelineService.getPipelineRiskyDeals.mockResolvedValue({ risky_deals: [] });
        pipelineService.getPipelineSlippage.mockResolvedValue({ slippage: [] });

        const cases = [
            ['crm.get_pipeline_by_owner', { owner_user_id: 'user-2', period_start: '2026-06-01' }, pipelineService.getPipelineByOwner],
            ['crm.get_pipeline_by_team', { team_id: 'team-1', period_end: '2026-06-30' }, pipelineService.getPipelineByTeam],
            ['crm.get_pipeline_by_period', { period_start: '2026-06-01', period_end: '2026-06-30' }, pipelineService.getPipelineByPeriod],
            ['crm.group_pipeline_by_stage', { owner_user_id: 'user-2' }, pipelineService.getPipelineStageGroups],
            ['crm.group_pipeline_by_forecast_category', { team_id: 'team-1' }, pipelineService.getPipelineForecastGroups],
            ['crm.get_forecast_totals', { period_start: '2026-06-01', period_end: '2026-06-30' }, pipelineService.getForecastTotals],
            ['crm.get_pipeline_changes', { since: '2026-05-27T00:00:00.000Z' }, pipelineService.getPipelineChanges],
            ['crm.get_pipeline_risky_deals', { owner_user_id: 'user-2' }, pipelineService.getPipelineRiskyDeals],
            ['crm.get_pipeline_slippage', { team_id: 'team-1' }, pipelineService.getPipelineSlippage],
        ];

        for (const [tool, args, serviceFn] of cases) {
            serviceFn.mockClear();
            const res = await request(makeApp())
                .post('/api/crm/mcp/call')
                .send({ tool, arguments: args });

            expect(res.status).toBe(200);
            expect(serviceFn).toHaveBeenCalledWith('company-1', args);
        }
    });

    test('pipeline by period validates date arguments before dispatch', async () => {
        const res = await request(makeApp())
            .post('/api/crm/mcp/call')
            .send({
                tool: 'crm.get_pipeline_by_period',
                arguments: { period_start: '2026-06-01', period_end: '2026-06-31' },
            });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('invalid_request');
        expect(res.body.error.details.field).toBe('period_end');
        expect(pipelineService.getPipelineByPeriod).not.toHaveBeenCalled();
    });

    test('pipeline by owner rejects null required owner before dispatch', async () => {
        const res = await request(makeApp())
            .post('/api/crm/mcp/call')
            .send({
                tool: 'crm.get_pipeline_by_owner',
                arguments: { owner_user_id: null },
            });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('invalid_request');
        expect(res.body.error.details.field).toBe('owner_user_id');
        expect(pipelineService.getPipelineByOwner).not.toHaveBeenCalled();
    });

    test('pipeline changes validates since timestamp before dispatch', async () => {
        const res = await request(makeApp())
            .post('/api/crm/mcp/call')
            .send({
                tool: 'crm.get_pipeline_changes',
                arguments: { since: '2026-05-27' },
            });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('invalid_request');
        expect(res.body.error.details.field).toBe('since');
        expect(pipelineService.getPipelineChanges).not.toHaveBeenCalled();
    });

    test('read-only workflow aliases dispatch through CRM list service', async () => {
        listsService.getList.mockResolvedValue([{ id: 1, name: 'Acme' }]);
        const cases = [
            ['crm.find_deals_closing_this_month', {}, 'deals_closing_this_month', {}],
            ['crm.find_deals_closing_this_quarter', {}, 'deals_closing_this_quarter', {}],
            ['crm.find_deals_without_activity', {}, 'deals_without_activity', {}],
            ['crm.find_risky_deals', { limit: 5 }, 'risky_deals', { limit: 5 }],
            ['crm.top_accounts_by_pipeline', { limit: 5 }, 'top_accounts_by_pipeline', { limit: 5 }],
            ['crm.accounts_needing_follow_up', { days: 21, limit: 10 }, 'accounts_needing_follow_up', { days: 21, limit: 10 }],
            ['crm.contacts_missing_role_title_email', {}, 'contacts_missing_role_title_email', {}],
            ['crm.tasks_due_this_week', {}, 'tasks_due_this_week', {}],
        ];

        for (const [tool, args, listKey, filters] of cases) {
            listsService.getList.mockClear();
            const res = await request(makeApp())
                .post('/api/crm/mcp/call')
                .send({ tool, arguments: args });

            expect(res.status).toBe(200);
            expect(listsService.getList).toHaveBeenCalledWith(
                'company-1',
                listKey,
                filters,
                expect.objectContaining({ actorId: 'user-1', companyTimezone: 'America/New_York' })
            );
        }
    });

    test('overdue tasks read-only tool dispatches to tasks service', async () => {
        tasksService.listTasks.mockResolvedValue([{ id: 8, title: 'Follow up' }]);

        const res = await request(makeApp())
            .post('/api/crm/mcp/call')
            .send({ tool: 'crm.find_overdue_tasks', arguments: { owner_user_id: 'user-1', limit: 20 } });

        expect(res.status).toBe(200);
        expect(tasksService.listTasks).toHaveBeenCalledWith('company-1', {
            owner_user_id: 'user-1',
            limit: 20,
            overdue: true,
        });
    });

    test('deal history read-only tool dispatches to deal history service', async () => {
        dealsService.getDealHistory.mockResolvedValue([{ field_name: 'stage' }]);

        const res = await request(makeApp())
            .post('/api/crm/mcp/call')
            .send({ tool: 'crm.get_deal_history', arguments: { deal_id: 9 } });

        expect(res.status).toBe(200);
        expect(dealsService.getDealHistory).toHaveBeenCalledWith('company-1', 9);
    });

    test('confirmed task status write passes actor and confirmation context', async () => {
        tasksService.updateTaskStatus.mockResolvedValue({ task: { id: 5, status: 'done' }, before: 'open', after: 'done' });

        const res = await request(makeApp({ permissions: ['sales.crm.write'] }))
            .post('/api/crm/mcp/call')
            .send({
                tool: 'crm.update_task_status',
                arguments: { task_id: 5, status: 'done' },
                confirmation: { confirmed: true, confirmation_id: 'confirm-task', reason: 'Follow-up complete' },
            });

        expect(res.status).toBe(200);
        expect(tasksService.updateTaskStatus).toHaveBeenCalledWith(
            'company-1',
            5,
            'done',
            expect.objectContaining({
                actorId: 'user-1',
                confirmation: { confirmationId: 'confirm-task', reason: 'Follow-up complete' },
            })
        );
    });

    test('confirmed create task write passes confirmation context', async () => {
        tasksService.createTask.mockResolvedValue({ id: 7, title: 'Call buyer' });

        const res = await request(makeApp({ permissions: ['sales.crm.write'] }))
            .post('/api/crm/mcp/call')
            .send({
                tool: 'crm.create_task',
                arguments: { title: 'Call buyer', deal_id: 9 },
                confirmation: { confirmed: true, confirmation_id: 'confirm-create-task' },
            });

        expect(res.status).toBe(200);
        expect(tasksService.createTask).toHaveBeenCalledWith(
            'company-1',
            { title: 'Call buyer', deal_id: 9 },
            expect.objectContaining({
                confirmation: { confirmationId: 'confirm-create-task', reason: null },
            })
        );
    });

    test('confirmed create note write passes confirmation context', async () => {
        notesService.createNote.mockResolvedValue({ id: 11, text: 'Strategy note' });

        const res = await request(makeApp({ permissions: ['sales.crm.write'] }))
            .post('/api/crm/mcp/call')
            .send({
                tool: 'crm.create_note',
                arguments: { entity_type: 'deal', entity_id: 9, text: 'Strategy note', source: 'deal_strategy' },
                confirmation: { confirmed: true, confirmation_id: 'confirm-note' },
            });

        expect(res.status).toBe(200);
        expect(notesService.createNote).toHaveBeenCalledWith(
            'company-1',
            { entity_type: 'deal', entity_id: 9, text: 'Strategy note', source: 'deal_strategy' },
            expect.objectContaining({
                confirmation: { confirmationId: 'confirm-note', reason: null },
            })
        );
    });

    test('JSON-RPC tools/list and tools/call aliases work', async () => {
        accountsService.listAccounts.mockResolvedValue([{ id: 3, name: 'Beta' }]);

        const listRes = await request(makeApp())
            .post('/api/crm/mcp/jsonrpc')
            .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { kind: 'read' } });
        expect(listRes.status).toBe(200);
        expect(listRes.body.result.tools).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: 'crm.search_accounts',
                annotations: expect.objectContaining({ readOnlyHint: true }),
            }),
        ]));
        expect(listRes.body.result.tools.map(tool => tool.name)).not.toContain('crm.update_deal_field');

        const callRes = await request(makeApp())
            .post('/api/crm/mcp/jsonrpc')
            .send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'crm.search_accounts', arguments: { q: 'beta' } } });
        expect(callRes.status).toBe(200);
        expect(callRes.body.result.structuredContent).toEqual([{ id: 3, name: 'Beta' }]);
    });

    test('all authenticated CRM MCP endpoints require company context', async () => {
        const tools = await request(makeApp({ companyId: null }))
            .get('/api/crm/mcp/tools');
        expect(tools.status).toBe(403);
        expect(tools.body.error.code).toBe('access_denied');

        const call = await request(makeApp({ companyId: null }))
            .post('/api/crm/mcp/call')
            .send({ tool: 'crm.search_accounts', arguments: { q: 'acme' } });
        expect(call.status).toBe(403);
        expect(call.body.error.code).toBe('access_denied');

        const jsonrpc = await request(makeApp({ companyId: null }))
            .post('/api/crm/mcp/jsonrpc')
            .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        expect(jsonrpc.status).toBe(403);
        expect(jsonrpc.body.error.code).toBe('access_denied');
        expect(accountsService.listAccounts).not.toHaveBeenCalled();
    });
});
