'use strict';

const mockLogActivity = jest.fn();
jest.mock('../backend/src/services/activityLogService', () => ({
    logActivity: (...args) => mockLogActivity(...args),
}));

const {
    integrationActor,
    logZenbookerBatch,
    logZenbookerEntity,
} = require('../backend/src/services/zenbookerActivityService');

describe('zenbookerActivityService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockLogActivity.mockResolvedValue({ ok: true, id: 1 });
    });

    test('uses the canonical Zenbooker integration actor', () => {
        expect(integrationActor('webhook')).toEqual({
            id: null,
            type: 'integration',
            label: 'Zenbooker',
            source: 'webhook',
        });
    });

    test('a batch is one company-targeted event with safe counts', async () => {
        await logZenbookerBatch({
            companyId: 'company-1',
            entityType: 'payment',
            summary: { count: 9, imported_count: 3 },
        });

        expect(mockLogActivity).toHaveBeenCalledTimes(1);
        expect(mockLogActivity).toHaveBeenCalledWith({
            action: 'payment.sync_completed',
            target_type: 'company',
            target_id: 'company-1',
            company_id: 'company-1',
            actor_id: null,
            details: {
                actor_type: 'integration',
                actor_label: 'Zenbooker',
                source: 'sync',
                parent_type: null,
                parent_id: null,
                summary: { count: 9, imported_count: 3 },
            },
        });
    });

    test('a webhook emits one entity event with integration attribution', async () => {
        await logZenbookerEntity({
            companyId: 'company-1',
            entityType: 'job',
            entityId: 42,
            summary: { status: 'Scheduled' },
        });

        expect(mockLogActivity).toHaveBeenCalledTimes(1);
        expect(mockLogActivity).toHaveBeenCalledWith(expect.objectContaining({
            action: 'job.synced',
            target_type: 'job',
            target_id: '42',
            company_id: 'company-1',
            details: expect.objectContaining({
                actor_type: 'integration',
                actor_label: 'Zenbooker',
                source: 'webhook',
            }),
        }));
    });
});

