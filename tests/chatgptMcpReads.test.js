'use strict';

jest.mock('../backend/src/services/jobsService', () => ({
    listJobs: jest.fn(async () => ({ results: [] })),
    getJobById: jest.fn(async () => ({
        id: 11,
        blanc_status: 'Submitted',
        zb_raw: { hidden: true },
        metadata: { apiKey: 'hidden', safe: 'visible' },
    })),
}));
jest.mock('../backend/src/services/leadsService', () => ({ listLeads: jest.fn(async () => ({ leads: [] })) }));
jest.mock('../backend/src/services/contactsService', () => ({
    listContacts: jest.fn(async () => ({ results: [] })),
    getById: jest.fn(async () => ({ id: 21 })),
}));
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
    jobParentVisible: jest.fn(async () => true),
    listEntityTasks: jest.fn(async () => []),
}));
jest.mock('../backend/src/db/chatgptMcpQueries', () => ({
    getLead: jest.fn(async () => ({ uuid: 'LEAD-A', status: 'Submitted' })),
    getContact: jest.fn(async () => ({ id: 21, public_token: 'hidden' })),
    getContactHistory: jest.fn(async () => ({ contact: { id: 21 }, events: [] })),
    listAssignees: jest.fn(async () => ({ users: [] })),
    listCalls: jest.fn(async () => ({
        rows: [{
            id: 51,
            direction: 'inbound',
            status: 'completed',
            started_at: '2026-07-22T14:00:00.000Z',
            answered_at: '2026-07-22T14:00:03.000Z',
            ended_at: '2026-07-22T14:05:00.000Z',
            duration_sec: 297,
            from_number: '+16175550101',
            to_number: '+16175550202',
            contact_id: 21,
            contact_name: 'Caller A',
            answered_by: 'ai',
            call_sid: 'CA-secret',
            parent_call_sid: 'CA-parent-secret',
            price: '1.25',
            price_unit: 'USD',
            raw_last_payload: { secret: true },
            recording_url: 'https://media.example.test/private',
        }],
        total: 1,
    })),
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
const OWNER = 'owner-a';
const AUTHORITY = Object.freeze({
    companyId: COMPANY,
    ownerUserId: OWNER,
    ownerRoleKey: 'manager',
    ownerPermissions: ['tasks.view', 'tasks.manage'],
    ownerScopes: { job_visibility: 'all' },
});

const CASES = [
    ['listJobs', {}, jobsService.listJobs],
    ['getJob', { job_id: 11 }, jobsService.getJobById],
    ['getJobTransitions', { job_id: 11 }, jobsService.getJobById],
    ['listLeads', {}, leadsService.listLeads],
    ['getLead', { lead_uuid: 'LEAD-A' }, queries.getLead],
    ['getLeadTransitions', { lead_uuid: 'LEAD-A' }, queries.getLead],
    ['searchContacts', {}, contactsService.listContacts],
    ['getContact', { contact_id: 21 }, contactsService.getById],
    ['getContactHistory', { contact_id: 21 }, contactsService.getById],
    ['listSchedule', {}, scheduleService.getScheduleItems],
    ['getScheduleItem', { entity_type: 'job', entity_id: 11 }, scheduleService.getScheduleItemDetail],
    ['listTasks', {}, tasksQueries.listTasksPage],
    ['listEntityTasks', { parent_type: 'job', parent_id: '11' }, tasksQueries.jobParentVisible],
    ['listTaskAssignees', {}, queries.listAssignees],
    ['listCalls', {}, queries.listCalls],
    ['listEstimates', {}, queries.listEstimates],
    ['getEstimate', { estimate_id: 31 }, queries.getEstimate],
    ['listInvoices', {}, queries.listInvoices],
    ['getInvoice', { invoice_id: 41 }, queries.getInvoice],
];

beforeEach(() => jest.clearAllMocks());

describe('CHATGPT-CRM-MCP S1 read handlers', () => {
    test.each(CASES)('%s threads the binding company into the real read seam', async (handler, args, dependency) => {
        await expect(readService.execute(handler, AUTHORITY, args)).resolves.toBeDefined();
        expect(dependency).toHaveBeenCalled();
        expect(JSON.stringify(dependency.mock.calls[0])).toContain(COMPANY);
    });

    test('published FSM absence is reported without using the hardcoded fallback', async () => {
        fsmService.getAvailableActions.mockResolvedValueOnce({ fallback: true, actions: [{ event: 'unsafe' }] });
        await expect(readService.execute('getJobTransitions', AUTHORITY, { job_id: 11 }))
            .resolves.toEqual({ workflow_available: false, actions: [] });
        expect(fsmService.getAvailableActions).toHaveBeenCalledWith(
            COMPANY,
            'job',
            'Submitted',
            ['manager']
        );
    });

    test('SAB-AVATAR-RECORD-SCOPE: every scoped read receives the human owner ID', async () => {
        const provider = {
            ...AUTHORITY,
            ownerRoleKey: 'provider',
            ownerPermissions: ['tasks.view'],
            ownerScopes: { job_visibility: 'assigned_only' },
        };
        const scope = { assignedOnly: true, userId: OWNER };

        await readService.execute('listJobs', provider, {});
        expect(jobsService.listJobs).toHaveBeenCalledWith(
            expect.objectContaining({ companyId: COMPANY, providerScope: scope })
        );
        await readService.execute('getJob', provider, { job_id: 11 });
        expect(jobsService.getJobById).toHaveBeenCalledWith(11, COMPANY, scope);
        await readService.execute('searchContacts', provider, {});
        expect(contactsService.listContacts).toHaveBeenCalledWith(
            expect.objectContaining({ companyId: COMPANY, providerScope: scope })
        );
        await readService.execute('getContact', provider, { contact_id: 21 });
        expect(contactsService.getById).toHaveBeenCalledWith(21, COMPANY, scope);
        await readService.execute('listSchedule', provider, {});
        expect(scheduleService.getScheduleItems).toHaveBeenCalledWith(
            COMPANY,
            expect.any(Object),
            scope
        );
        await readService.execute('getScheduleItem', provider, {
            entity_type: 'job',
            entity_id: 11,
        });
        expect(scheduleService.getScheduleItemDetail).toHaveBeenCalledWith(
            COMPANY,
            'job',
            11,
            scope
        );
        await readService.execute('listCalls', provider, {});
        expect(queries.listCalls).toHaveBeenCalledWith(COMPANY, {}, scope);
        await readService.execute('listTasks', provider, {});
        expect(tasksQueries.listTasksPage).toHaveBeenCalledWith(
            COMPANY,
            expect.objectContaining({ scopeOwnerId: OWNER })
        );
        await readService.execute('listEntityTasks', provider, {
            parent_type: 'job',
            parent_id: '11',
        });
        expect(tasksQueries.jobParentVisible).toHaveBeenCalledWith(
            COMPANY,
            '11',
            scope
        );
        expect(JSON.stringify([
            jobsService.listJobs.mock.calls,
            jobsService.getJobById.mock.calls,
            contactsService.getById.mock.calls,
            scheduleService.getScheduleItems.mock.calls,
            queries.listCalls.mock.calls,
        ])).not.toContain('agent-');
    });

    test('lead FSM actions use the live owner role too', async () => {
        await readService.execute('getLeadTransitions', AUTHORITY, { lead_uuid: 'LEAD-A' });
        expect(fsmService.getAvailableActions).toHaveBeenCalledWith(
            COMPANY,
            'lead',
            'Submitted',
            ['manager']
        );
    });

    test.each([
        ['getJob', 'getJobById', { job_id: 999 }],
        ['getLead', 'getLead', { lead_uuid: 'FOREIGN' }],
        ['getContact', 'getById', { contact_id: 999 }],
        ['getEstimate', 'getEstimate', { estimate_id: 999 }],
        ['getInvoice', 'getInvoice', { invoice_id: 999 }],
    ])('foreign %s is indistinguishable from missing', async (handler, dependencyName, args) => {
        const dependency = handler === 'getJob'
            ? jobsService[dependencyName]
            : (handler === 'getContact' ? contactsService[dependencyName] : queries[dependencyName]);
        dependency.mockResolvedValueOnce(null);
        await expect(readService.execute(handler, AUTHORITY, args))
            .rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    });

    test('results strip provider blobs and capability tokens', async () => {
        await expect(readService.execute('getJob', AUTHORITY, { job_id: 11 }))
            .resolves.not.toHaveProperty('zb_raw');
        await expect(readService.execute('getJob', AUTHORITY, { job_id: 11 }))
            .resolves.toEqual(expect.objectContaining({ metadata: { safe: 'visible' } }));
        await expect(readService.execute('getEstimate', AUTHORITY, { estimate_id: 31 }))
            .resolves.not.toHaveProperty('public_token');
    });

    test('listCalls forwards filters and returns only the approved call projection', async () => {
        const args = {
            limit: 17,
            direction: 'inbound',
            contact_id: 21,
            date_from: '2026-07-10',
            date_to: '2026-07-22',
        };
        const result = await readService.execute('listCalls', AUTHORITY, args);

        expect(queries.listCalls).toHaveBeenCalledWith(
            COMPANY,
            args,
            { assignedOnly: false, userId: null }
        );
        expect(result).toEqual({
            rows: [{
                id: 51,
                direction: 'inbound',
                status: 'completed',
                started_at: '2026-07-22T14:00:00.000Z',
                answered_at: '2026-07-22T14:00:03.000Z',
                ended_at: '2026-07-22T14:05:00.000Z',
                duration_sec: 297,
                from_number: '+16175550101',
                to_number: '+16175550202',
                contact_id: 21,
                contact_name: 'Caller A',
                answered_by: 'ai',
            }],
            total: 1,
        });
        for (const forbidden of [
            'call_sid',
            'parent_call_sid',
            'price',
            'price_unit',
            'raw_last_payload',
            'recording_url',
        ]) {
            expect(result.rows[0]).not.toHaveProperty(forbidden);
        }
    });

    test('no company context fails before every service/query call', async () => {
        await expect(readService.execute('getJob', {}, { job_id: 11 }))
            .rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
        expect(jobsService.getJobById).not.toHaveBeenCalled();
    });
});
