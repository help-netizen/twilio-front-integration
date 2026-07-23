'use strict';

jest.mock('../backend/src/services/jobsService', () => ({ listJobs: jest.fn(async () => ({ results: [] })) }));
jest.mock('../backend/src/services/leadsService', () => ({ listLeads: jest.fn(async () => ({ leads: [] })) }));
jest.mock('../backend/src/services/contactsService', () => ({ listContacts: jest.fn(async () => ({ results: [] })) }));
jest.mock('../backend/src/services/scheduleService', () => ({
    getScheduleItems: jest.fn(async () => ({ items: [], total: 0 })),
    getScheduleItemDetail: jest.fn(async (_companyId, entityType, entityId) => ({ entity_type: entityType, entity_id: entityId })),
}));
jest.mock('../backend/src/services/fsmService', () => ({
    getAvailableActions: jest.fn(async () => ({ fallback: false, actions: [{ event: 'advance' }] })),
}));
jest.mock('../backend/src/db/tasksQueries', () => ({
    listTasksPage: jest.fn(async () => ({ tasks: [] })),
    parentExists: jest.fn(async () => true),
    listEntityTasks: jest.fn(async () => []),
}));
jest.mock('../backend/src/db/chatgptMcpQueries', () => ({
    getJob: jest.fn(async () => ({
        id: 11,
        blanc_status: 'Submitted',
        zb_raw: { hidden: true },
        metadata: { apiKey: 'hidden', safe: 'visible' },
    })),
    getLead: jest.fn(async () => ({ uuid: 'LEAD-A', status: 'Submitted' })),
    getContact: jest.fn(async () => ({ id: 21, public_token: 'hidden' })),
    getContactHistory: jest.fn(async () => ({ contact: { id: 21 }, events: [] })),
    listAssignees: jest.fn(async () => ({ users: [] })),
    listEstimates: jest.fn(async () => ({ rows: [{ id: 31 }], total: 1 })),
    getEstimate: jest.fn(async () => ({ id: 31, public_token: 'hidden', items: [] })),
    listInvoices: jest.fn(async () => ({ rows: [{ id: 41 }], total: 1 })),
    getInvoice: jest.fn(async () => ({ id: 41, public_token: 'hidden', items: [] })),
}));

const jobsService = require('../backend/src/services/jobsService');
const leadsService = require('../backend/src/services/leadsService');
const contactsService = require('../backend/src/services/contactsService');
const scheduleService = require('../backend/src/services/scheduleService');
const fsmService = require('../backend/src/services/fsmService');
const tasksQueries = require('../backend/src/db/tasksQueries');
const queries = require('../backend/src/db/chatgptMcpQueries');
const readService = require('../backend/src/services/chatgptMcpReadService');

const COMPANY = 'company-a';

const CASES = [
    ['listJobs', {}, jobsService.listJobs],
    ['getJob', { job_id: 11 }, queries.getJob],
    ['getJobTransitions', { job_id: 11 }, queries.getJob],
    ['listLeads', {}, leadsService.listLeads],
    ['getLead', { lead_uuid: 'LEAD-A' }, queries.getLead],
    ['getLeadTransitions', { lead_uuid: 'LEAD-A' }, queries.getLead],
    ['searchContacts', {}, contactsService.listContacts],
    ['getContact', { contact_id: 21 }, queries.getContact],
    ['getContactHistory', { contact_id: 21 }, queries.getContactHistory],
    ['listSchedule', {}, scheduleService.getScheduleItems],
    ['getScheduleItem', { entity_type: 'job', entity_id: 11 }, scheduleService.getScheduleItemDetail],
    ['listTasks', {}, tasksQueries.listTasksPage],
    ['listEntityTasks', { parent_type: 'job', parent_id: '11' }, tasksQueries.parentExists],
    ['listTaskAssignees', {}, queries.listAssignees],
    ['listEstimates', {}, queries.listEstimates],
    ['getEstimate', { estimate_id: 31 }, queries.getEstimate],
    ['listInvoices', {}, queries.listInvoices],
    ['getInvoice', { invoice_id: 41 }, queries.getInvoice],
];

beforeEach(() => jest.clearAllMocks());

describe('CHATGPT-CRM-MCP S1 read handlers', () => {
    test.each(CASES)('%s threads the binding company into the real read seam', async (handler, args, dependency) => {
        await expect(readService.execute(handler, COMPANY, args)).resolves.toBeDefined();
        expect(dependency).toHaveBeenCalled();
        const firstCall = dependency.mock.calls[0];
        if (handler === 'listJobs' || handler === 'listLeads' || handler === 'searchContacts') {
            expect(firstCall[0]).toEqual(expect.objectContaining({ companyId: COMPANY }));
        } else {
            expect(firstCall[0]).toBe(COMPANY);
        }
    });

    test('published FSM absence is reported without using the hardcoded fallback', async () => {
        fsmService.getAvailableActions.mockResolvedValueOnce({ fallback: true, actions: [{ event: 'unsafe' }] });
        await expect(readService.execute('getJobTransitions', COMPANY, { job_id: 11 }))
            .resolves.toEqual({ workflow_available: false, actions: [] });
    });

    test.each([
        ['getJob', 'getJob', { job_id: 999 }],
        ['getLead', 'getLead', { lead_uuid: 'FOREIGN' }],
        ['getContact', 'getContact', { contact_id: 999 }],
        ['getEstimate', 'getEstimate', { estimate_id: 999 }],
        ['getInvoice', 'getInvoice', { invoice_id: 999 }],
    ])('foreign %s is indistinguishable from missing', async (_label, queryName, args) => {
        queries[queryName].mockResolvedValueOnce(null);
        await expect(readService.execute(queryName, COMPANY, args))
            .rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    });

    test('results strip provider blobs and capability tokens', async () => {
        await expect(readService.execute('getJob', COMPANY, { job_id: 11 }))
            .resolves.not.toHaveProperty('zb_raw');
        await expect(readService.execute('getJob', COMPANY, { job_id: 11 }))
            .resolves.toEqual(expect.objectContaining({ metadata: { safe: 'visible' } }));
        await expect(readService.execute('getEstimate', COMPANY, { estimate_id: 31 }))
            .resolves.not.toHaveProperty('public_token');
    });

    test('no company context fails before every service/query call', async () => {
        await expect(readService.execute('getJob', null, { job_id: 11 }))
            .rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
        expect(queries.getJob).not.toHaveBeenCalled();
    });
});
