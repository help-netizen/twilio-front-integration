'use strict';

const mockPurgeStaleSegments = jest.fn();
const mockPruneRouteCache = jest.fn();
const mockListCompaniesWithExpiredMessages = jest.fn();
const mockDeleteExpiredMessages = jest.fn();

jest.mock('../backend/src/db/routeQueries', () => ({
    purgeStaleSegments: mockPurgeStaleSegments,
    pruneRouteCache: mockPruneRouteCache,
}));
jest.mock('../backend/src/services/appBuilderRepository', () => ({
    listCompaniesWithExpiredMessages: mockListCompaniesWithExpiredMessages,
    deleteExpiredMessages: mockDeleteExpiredMessages,
}));

const scheduler = require('../backend/src/services/routeRetentionScheduler');

describe('APP-BUILD-001 operational message retention', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        scheduler.stop();
        mockPurgeStaleSegments.mockResolvedValue(0);
        mockPruneRouteCache.mockResolvedValue(0);
        mockListCompaniesWithExpiredMessages.mockResolvedValue([
            '10000000-0000-4000-8000-000000000001',
            '10000000-0000-4000-8000-000000000002',
        ]);
        mockDeleteExpiredMessages
            .mockResolvedValueOnce(1000)
            .mockResolvedValueOnce(2)
            .mockResolvedValueOnce(1);
    });

    afterAll(() => scheduler.stop());

    test('SAB APP-FINAL-P0 production retention tick drains every expired builder-message batch', async () => {
        await scheduler.tick();
        expect(mockListCompaniesWithExpiredMessages).toHaveBeenCalledWith({
            afterCompanyId: null,
            batchSize: 1000,
        });
        expect(mockDeleteExpiredMessages).toHaveBeenCalledTimes(3);
        expect(mockDeleteExpiredMessages).toHaveBeenNthCalledWith(
            1,
            '10000000-0000-4000-8000-000000000001',
            { batchSize: 1000 }
        );
        expect(mockDeleteExpiredMessages).toHaveBeenNthCalledWith(
            3,
            '10000000-0000-4000-8000-000000000002',
            { batchSize: 1000 }
        );
    });
});
