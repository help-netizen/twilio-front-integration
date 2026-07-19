const express = require('express');
const request = require('supertest');

jest.mock('../../backend/src/services/auditService', () => ({
    log: jest.fn(() => Promise.resolve()),
}));

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
    updateDeal: jest.fn(),
    getAttentionDeals: jest.fn(),
}));
jest.mock('../../backend/src/services/crmPipelineService', () => ({
    getPipeline: jest.fn(),
}));
jest.mock('../../backend/src/services/crmActivitiesService', () => ({
    listActivities: jest.fn(),
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
    getList: jest.fn(),
}));

const accountsService = require('../../backend/src/services/crmAccountsService');
const contactsService = require('../../backend/src/services/crmContactsService');
const dealsService = require('../../backend/src/services/crmDealsService');
const pipelineService = require('../../backend/src/services/crmPipelineService');
const activitiesService = require('../../backend/src/services/crmActivitiesService');
const tasksService = require('../../backend/src/services/crmTasksService');
const notesService = require('../../backend/src/services/crmNotesService');
const metadataService = require('../../backend/src/services/crmMetadataService');
const listsService = require('../../backend/src/services/crmListsService');
const { CrmServiceError } = require('../../backend/src/services/crmErrors');
const crmRouter = require('../../backend/src/routes/crm');

function makeApp({
    companyId = 'company-1',
    permissions = ['sales.crm.write', 'contacts.view', 'leads.view', 'tasks.view'],
} = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.requestId = 'req-test';
        req.companyFilter = companyId ? { company_id: companyId } : undefined;
        req.user = {
            sub: 'sub-1',
            email: 'seller@test.local',
            crmUser: { id: 'user-1' },
        };
        req.authz = { permissions, company: companyId ? { id: companyId, status: 'active' } : null };
        next();
    });
    app.use('/api/crm', crmRouter);
    return app;
}

describe('/api/crm routes', () => {
    beforeEach(() => jest.clearAllMocks());

    test('GET /accounts passes companyId and query filters to service', async () => {
        accountsService.listAccounts.mockResolvedValue([{ id: 1, name: 'Acme' }]);

        const res = await request(makeApp()).get('/api/crm/accounts?q=acme&limit=10');

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data).toEqual([{ id: 1, name: 'Acme' }]);
        expect(accountsService.listAccounts).toHaveBeenCalledWith(
            'company-1',
            expect.objectContaining({ q: 'acme', limit: '10' })
        );
    });

    test('GET /accounts/:id maps service not-found to 404', async () => {
        accountsService.getAccountCard.mockRejectedValue(new CrmServiceError('NOT_FOUND', 'Account not found', 404));

        const res = await request(makeApp()).get('/api/crm/accounts/42');

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
        expect(accountsService.getAccountCard).toHaveBeenCalledWith('company-1', 42);
    });

    test('PATCH /deals/:id passes actor context and returns before/after update data', async () => {
        dealsService.updateDeal.mockResolvedValue({
            field: 'next_step',
            before: 'Old',
            after: 'New',
            deal: { id: 9, next_step: 'New' },
        });

        const res = await request(makeApp())
            .patch('/api/crm/deals/9')
            .send({ next_step: 'New', source: 'client-spoof' });

        expect(res.status).toBe(200);
        expect(res.body.data.before).toBe('Old');
        expect(res.body.data.after).toBe('New');
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

    test('PATCH /deals/:id requires CRM write permission', async () => {
        const res = await request(makeApp({ permissions: [] }))
            .patch('/api/crm/deals/9')
            .send({ next_step: 'New' });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ACCESS_DENIED');
        expect(dealsService.updateDeal).not.toHaveBeenCalled();
    });

    test('all CRM write routes require CRM write permission', async () => {
        const app = makeApp({ permissions: [] });
        const cases = [
            ['patch', '/api/crm/deals/9', { next_step: 'New' }],
            ['patch', '/api/crm/tasks/5', { status: 'done' }],
            ['post', '/api/crm/tasks', { title: 'Follow up', deal_id: 9 }],
            ['post', '/api/crm/notes', { entity_type: 'deal', entity_id: 9, text: 'Note', source: 'manual' }],
        ];

        for (const [method, path, body] of cases) {
            const res = await request(app)[method](path).send(body);
            expect(res.status).toBe(403);
            expect(res.body.code).toBe('ACCESS_DENIED');
        }
        expect(dealsService.updateDeal).not.toHaveBeenCalled();
        expect(tasksService.updateTaskStatus).not.toHaveBeenCalled();
        expect(tasksService.createTask).not.toHaveBeenCalled();
    });

    test('PATCH /tasks/:id calls task status service only with parsed id', async () => {
        tasksService.updateTaskStatus.mockResolvedValue({ task: { id: 5, status: 'done' }, before: 'open', after: 'done' });

        const res = await request(makeApp()).patch('/api/crm/tasks/5').send({ status: 'done' });

        expect(res.status).toBe(200);
        expect(tasksService.updateTaskStatus).toHaveBeenCalledWith(
            'company-1',
            5,
            'done',
            expect.objectContaining({ actorId: 'user-1' })
        );
    });

    test('GET /metadata returns tenant metadata', async () => {
        metadataService.getMetadata.mockResolvedValue({ pipeline_stages: [], forecast_categories: [] });

        const res = await request(makeApp()).get('/api/crm/metadata');

        expect(res.status).toBe(200);
        expect(metadataService.getMetadata).toHaveBeenCalledWith('company-1');
    });

    test.each([
        ['/api/crm/accounts', accountsService.listAccounts],
        ['/api/crm/accounts/stale?days=14', accountsService.getStaleAccounts],
        ['/api/crm/accounts/1', accountsService.getAccountCard],
        ['/api/crm/accounts/1/key-contacts', contactsService.getKeyContactsByAccount],
        ['/api/crm/contacts', contactsService.listContacts],
        ['/api/crm/contacts/1', contactsService.getContactCard],
        ['/api/crm/activities', activitiesService.listActivities],
        ['/api/crm/notes?entity_type=deal&entity_id=1', notesService.listNotes],
        ['/api/crm/metadata', metadataService.getMetadata],
        ['/api/crm/lists/my_open_deals', listsService.getList],
    ])('R-matrix: provider is denied contacts.view read %s', async (path, serviceFn) => {
        const res = await request(makeApp({ permissions: ['tasks.view'] })).get(path);

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ACCESS_DENIED');
        expect(serviceFn).not.toHaveBeenCalled();
    });

    test.each([
        ['/api/crm/deals', dealsService.listDeals],
        ['/api/crm/deals/attention', dealsService.getAttentionDeals],
        ['/api/crm/deals/1', dealsService.getDealCard],
        ['/api/crm/pipeline', pipelineService.getPipeline],
    ])('R-matrix: provider is denied leads.view read %s', async (path, serviceFn) => {
        const res = await request(makeApp({ permissions: ['tasks.view'] })).get(path);

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ACCESS_DENIED');
        expect(serviceFn).not.toHaveBeenCalled();
    });

    test('effective-permission deny blocks tasks read before the service', async () => {
        const res = await request(makeApp({ permissions: [] })).get('/api/crm/tasks');

        expect(res.status).toBe(403);
        expect(tasksService.listTasks).not.toHaveBeenCalled();
    });

    test('allow paths cover every CRM read handler with the selected permission', async () => {
        const contactCases = [
            '/api/crm/accounts',
            '/api/crm/accounts/stale?days=14',
            '/api/crm/accounts/1',
            '/api/crm/accounts/1/key-contacts',
            '/api/crm/contacts',
            '/api/crm/contacts/1',
            '/api/crm/activities',
            '/api/crm/notes?entity_type=deal&entity_id=1',
            '/api/crm/metadata',
            '/api/crm/lists/my_open_deals',
        ];
        const leadCases = [
            '/api/crm/deals',
            '/api/crm/deals/attention',
            '/api/crm/deals/1',
            '/api/crm/pipeline',
        ];
        for (const mock of [
            accountsService.listAccounts, accountsService.getStaleAccounts,
            accountsService.getAccountCard, contactsService.getKeyContactsByAccount,
            contactsService.listContacts, contactsService.getContactCard,
            activitiesService.listActivities, notesService.listNotes,
            metadataService.getMetadata, listsService.getList,
            dealsService.listDeals, dealsService.getAttentionDeals,
            dealsService.getDealCard, pipelineService.getPipeline, tasksService.listTasks,
        ]) mock.mockResolvedValue([]);

        for (const path of contactCases) {
            const res = await request(makeApp({ permissions: ['contacts.view'] })).get(path);
            expect(res.status).toBe(200);
        }
        for (const path of leadCases) {
            const res = await request(makeApp({ permissions: ['leads.view'] })).get(path);
            expect(res.status).toBe(200);
        }
        const tasks = await request(makeApp({ permissions: ['tasks.view'] })).get('/api/crm/tasks');
        expect(tasks.status).toBe(200);
    });

    test.each([
        ['/api/crm/accounts/42', accountsService.getAccountCard],
        ['/api/crm/accounts/42/key-contacts', contactsService.getKeyContactsByAccount],
        ['/api/crm/contacts/42', contactsService.getContactCard],
        ['/api/crm/deals/42', dealsService.getDealCard],
    ])('T-foreign: foreign id is 404 on %s', async (path, serviceFn) => {
        serviceFn.mockRejectedValue(new CrmServiceError('NOT_FOUND', 'Not found', 404));
        const permission = path.includes('/deals/') ? 'leads.view' : 'contacts.view';

        const res = await request(makeApp({ permissions: [permission] })).get(path);

        expect(res.status).toBe(404);
        expect(serviceFn.mock.calls[0][0]).toBe('company-1');
    });

    test('all CRM read/list endpoints require company context', async () => {
        const app = makeApp({ companyId: null });
        const paths = [
            '/api/crm/accounts',
            '/api/crm/accounts/stale?days=14',
            '/api/crm/accounts/1',
            '/api/crm/accounts/1/key-contacts',
            '/api/crm/contacts',
            '/api/crm/contacts/1',
            '/api/crm/deals',
            '/api/crm/deals/attention',
            '/api/crm/deals/1',
            '/api/crm/pipeline',
            '/api/crm/activities',
            '/api/crm/tasks',
            '/api/crm/notes?entity_type=deal&entity_id=1',
            '/api/crm/metadata',
            '/api/crm/lists/my_open_deals',
        ];

        for (const path of paths) {
            const res = await request(app).get(path);
            expect(res.status).toBe(403);
            expect(res.body.error.code).toBe('TENANT_CONTEXT_REQUIRED');
        }
        expect(accountsService.listAccounts).not.toHaveBeenCalled();
    });
});
