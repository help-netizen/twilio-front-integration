'use strict';

const mockDbQuery = jest.fn();
const mockGetCustomers = jest.fn();
const mockUpsertFromZenbooker = jest.fn();
const mockLogZenbookerBatch = jest.fn();

jest.mock('../backend/src/db/connection', () => ({ query: mockDbQuery }));
jest.mock('../backend/src/services/zenbookerClient', () => ({
    getCustomers: (...args) => mockGetCustomers(...args),
}));
jest.mock('../backend/src/services/contactsService', () => ({
    upsertFromZenbooker: (...args) => mockUpsertFromZenbooker(...args),
}));
jest.mock('../backend/src/services/zenbookerActivityService', () => ({
    logZenbookerBatch: (...args) => mockLogZenbookerBatch(...args),
}));

const { runSync } = require('../backend/src/services/contactsSyncService');

describe('Zenbooker contact bulk sync activity', () => {
    const companyId = '00000000-0000-0000-0000-0000000000aa';

    beforeEach(() => {
        jest.clearAllMocks();
        mockDbQuery
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValue({ rows: [], rowCount: 1 });
        mockGetCustomers.mockResolvedValue([{ id: 'zb-1' }, { id: 'zb-2' }]);
        mockUpsertFromZenbooker.mockResolvedValue({});
        mockLogZenbookerBatch.mockResolvedValue({ ok: true });
    });

    test('requires explicit tenant context', async () => {
        await expect(runSync()).rejects.toThrow('[ContactsSync] companyId is required');
        expect(mockGetCustomers).not.toHaveBeenCalled();
        expect(mockDbQuery).not.toHaveBeenCalled();
    });

    test('emits one Zenbooker integration event for the whole run', async () => {
        await expect(runSync(companyId)).resolves.toMatchObject({
            upserted: 2,
            errors: 0,
        });

        expect(mockGetCustomers).toHaveBeenCalledWith(
            { created_after: '2026-02-01' },
            companyId
        );
        expect(mockUpsertFromZenbooker).toHaveBeenCalledTimes(2);
        expect(mockUpsertFromZenbooker).toHaveBeenNthCalledWith(
            1,
            { id: 'zb-1' },
            companyId
        );
        expect(mockLogZenbookerBatch).toHaveBeenCalledTimes(1);
        expect(mockLogZenbookerBatch).toHaveBeenCalledWith({
            companyId,
            entityType: 'contact',
            summary: {
                count: 2,
                error_count: 0,
            },
        });
    });
});

