jest.mock('../../backend/src/db/connection', () => ({
    query: jest.fn(),
}));

const db = require('../../backend/src/db/connection');
const auditService = require('../../backend/src/services/crmWriteAuditService');

describe('crmWriteAuditService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        db.query.mockResolvedValue({ rows: [] });
    });

    test('logFieldUpdate stores confirmation metadata in details', async () => {
        await auditService.logFieldUpdate({
            companyId: 'company-1',
            actorId: 'user-1',
            entityType: 'deal',
            entityId: 9,
            field: 'deal.next_step',
            before: 'Old',
            after: 'New',
            requestId: 'req-1',
            confirmation: { confirmationId: 'confirm-1', reason: 'Forecast review' },
        });

        const details = JSON.parse(db.query.mock.calls[0][1][7]);
        expect(details).toMatchObject({
            field: 'deal.next_step',
            confirmation_id: 'confirm-1',
            confirmation_reason: 'Forecast review',
        });
    });

    test('logWriteAction stores confirmation metadata in details', async () => {
        await auditService.logWriteAction({
            companyId: 'company-1',
            actorId: 'user-1',
            action: 'crm_task_created',
            entityType: 'task',
            entityId: 7,
            requestId: 'req-2',
            confirmation: { confirmationId: 'confirm-2', reason: null },
        });

        const details = JSON.parse(db.query.mock.calls[0][1][7]);
        expect(details).toMatchObject({
            confirmation_id: 'confirm-2',
            confirmation_reason: null,
        });
    });
});
