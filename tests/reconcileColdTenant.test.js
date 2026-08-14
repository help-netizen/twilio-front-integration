'use strict';

const mockList = jest.fn();
const mockGetClientForCompany = jest.fn();
const mockUpsertSyncState = jest.fn();

jest.mock('../backend/src/services/telephonyTenantService', () => ({
    getClientForCompany: mockGetClientForCompany,
}));
jest.mock('../backend/src/db/queries', () => ({
    upsertSyncState: mockUpsertSyncState,
}));

const { coldReconcile } = require('../backend/src/services/reconcileService');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';

beforeEach(() => {
    jest.clearAllMocks();
    mockList.mockResolvedValue([]);
    mockGetClientForCompany.mockResolvedValue({ client: { calls: { list: mockList } } });
    mockUpsertSyncState.mockResolvedValue({});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('cold reconcile tenant caller contract', () => {
    it('selects the requested tenant client and tenant-qualifies sync state', async () => {
        const start = new Date('2026-01-01T00:00:00Z');
        const end = new Date('2026-01-02T00:00:00Z');

        await coldReconcile(COMPANY_A, start, end, 25);

        expect(mockGetClientForCompany).toHaveBeenCalledWith(COMPANY_A);
        expect(mockList).toHaveBeenCalledWith(expect.objectContaining({
            startTimeAfter: start,
            startTimeBefore: end,
            pageSize: 25,
        }));
        expect(mockUpsertSyncState).toHaveBeenCalledWith(
            `reconcile_cold:${COMPANY_A}`,
            { last_date: end }
        );
    });

    it('fails with TENANT_CONTEXT_REQUIRED before selecting a client', async () => {
        await expect(coldReconcile(null, new Date(), new Date()))
            .rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED', httpStatus: 403 });
        expect(mockGetClientForCompany).not.toHaveBeenCalled();
        expect(mockList).not.toHaveBeenCalled();
        expect(mockUpsertSyncState).not.toHaveBeenCalled();
    });
});

