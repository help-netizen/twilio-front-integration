const mockClient = {
    query: jest.fn(),
    release: jest.fn(),
};

jest.mock('../../backend/src/db/connection', () => ({
    pool: {
        connect: jest.fn(() => Promise.resolve(mockClient)),
    },
}));

jest.mock('../../backend/src/db/crmTasksQueries', () => ({
    listTasks: jest.fn(),
    createTask: jest.fn(),
    updateTaskStatus: jest.fn(),
}));
jest.mock('../../backend/src/db/crmAccountsQueries', () => ({
    getAccountById: jest.fn(),
}));
jest.mock('../../backend/src/db/crmDealsQueries', () => ({
    getDealById: jest.fn(),
}));
jest.mock('../../backend/src/db/crmContactsQueries', () => ({
    getContactById: jest.fn(),
}));
jest.mock('../../backend/src/services/crmMetadataService', () => ({
    getMetadata: jest.fn(),
}));
jest.mock('../../backend/src/services/crmWriteAuditService', () => ({
    logWriteAction: jest.fn(),
    logFieldUpdate: jest.fn(),
}));

const tasksQueries = require('../../backend/src/db/crmTasksQueries');
const dealsQueries = require('../../backend/src/db/crmDealsQueries');
const metadataService = require('../../backend/src/services/crmMetadataService');
const writeAuditService = require('../../backend/src/services/crmWriteAuditService');
const tasksService = require('../../backend/src/services/crmTasksService');

describe('crmTasksService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockClient.query.mockResolvedValue({ rows: [] });
        mockClient.release.mockReset();
        dealsQueries.getDealById.mockResolvedValue({ id: 9 });
        metadataService.getMetadata.mockResolvedValue({
            task_statuses: [{ status_key: 'open' }, { status_key: 'done' }],
        });
    });

    test('createTask writes audit with confirmation metadata', async () => {
        tasksQueries.createTask.mockResolvedValue({ id: 7, title: 'Call buyer', deal_id: 9 });

        const result = await tasksService.createTask(
            'company-1',
            { title: 'Call buyer', deal_id: 9 },
            {
                actorId: 'user-1',
                actorEmail: 'seller@test.local',
                requestId: 'req-1',
                confirmation: { confirmationId: 'confirm-task', reason: 'Sales follow-up' },
            }
        );

        expect(result).toMatchObject({
            task: { id: 7, title: 'Call buyer', deal_id: 9 },
            field: 'task',
            before: null,
            after: { id: 7, title: 'Call buyer', deal_id: 9 },
        });
        expect(writeAuditService.logWriteAction).toHaveBeenCalledWith(expect.objectContaining({
            companyId: 'company-1',
            action: 'crm_task_created',
            entityType: 'task',
            entityId: 7,
            confirmation: { confirmationId: 'confirm-task', reason: 'Sales follow-up' },
        }));
    });

    test('updateTaskStatus writes field audit with confirmation metadata', async () => {
        tasksQueries.updateTaskStatus.mockResolvedValue({
            row: { id: 7, status: 'done' },
            before: 'open',
            after: 'done',
        });

        const result = await tasksService.updateTaskStatus(
            'company-1',
            7,
            'done',
            {
                actorId: 'user-1',
                requestId: 'req-2',
                confirmation: { confirmationId: 'confirm-status', reason: null },
            }
        );

        expect(result).toMatchObject({ before: 'open', after: 'done' });
        expect(writeAuditService.logFieldUpdate).toHaveBeenCalledWith(expect.objectContaining({
            entityType: 'task',
            entityId: 7,
            field: 'task.status',
            confirmation: { confirmationId: 'confirm-status', reason: null },
            client: mockClient,
        }));
    });
});
