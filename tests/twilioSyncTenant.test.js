const mockListCalls = jest.fn();
const mockReconcileCall = jest.fn();
const mockColdReconcile = jest.fn();
const mockGetClientForCompany = jest.fn();

jest.mock('../backend/src/services/twilioClient', () => ({
    getTwilioClient: jest.fn(() => ({ calls: { list: mockListCalls } })),
}));
jest.mock('../backend/src/services/telephonyTenantService', () => ({
    getClientForCompany: mockGetClientForCompany,
}));
jest.mock('../backend/src/services/reconcileService', () => ({
    reconcileCall: mockReconcileCall,
    coldReconcile: mockColdReconcile,
    RECONCILE_CONFIG: {},
}));

const twilioSync = require('../backend/src/services/twilioSync');

const COMPANY_A = 'company-a';
const ACCOUNT_A = 'AC-company-a';

function remoteCall() {
    return {
        sid: 'CA-company-a',
        status: 'completed',
        dateCreated: new Date('2026-07-18T12:00:00Z'),
        from: '+15550000001',
        to: '+15550000002',
        direction: 'inbound',
        duration: 30,
        parentCallSid: null,
        price: '-0.10',
        priceUnit: 'USD',
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetClientForCompany.mockResolvedValue({
        client: { calls: { list: mockListCalls } },
        accountSid: ACCOUNT_A,
        mode: 'subaccount',
    });
    mockListCalls.mockResolvedValue([remoteCall()]);
    mockReconcileCall.mockResolvedValue(undefined);
    mockColdReconcile.mockResolvedValue({ processed: 0 });
    jest.spyOn(global, 'setTimeout').mockImplementation(callback => {
        callback();
        return 0;
    });
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('manual Twilio sync tenant isolation', () => {
    test('historical sync threads a non-default company into cold reconcile', async () => {
        await twilioSync.syncHistoricalCalls(7, COMPANY_A);

        expect(mockGetClientForCompany).toHaveBeenCalledWith(COMPANY_A);
        expect(mockColdReconcile).toHaveBeenCalledWith(
            COMPANY_A,
            expect.any(Date),
            expect.any(Date)
        );
    });

    test.each([
        ['today', 'syncTodayCalls', 'sync_today'],
        ['recent', 'syncRecentCalls', 'sync_recent'],
    ])('%s selects the company client and binds reconciliation to that company', async (_label, method, source) => {
        await twilioSync[method](COMPANY_A);

        expect(mockGetClientForCompany).toHaveBeenCalledWith(COMPANY_A);
        expect(mockReconcileCall).toHaveBeenCalledWith(
            expect.objectContaining({
                CallSid: 'CA-company-a',
                AccountSid: ACCOUNT_A,
            }),
            source,
            COMPANY_A
        );
    });

    test.each(['syncTodayCalls', 'syncRecentCalls'])(
        'SAB-TW-SYNC-CONTEXT: %s fails closed when company context is absent',
        async method => {
            await expect(twilioSync[method]()).rejects.toMatchObject({
                code: 'TENANT_CONTEXT_REQUIRED',
            });
            expect(mockGetClientForCompany).not.toHaveBeenCalled();
            expect(mockListCalls).not.toHaveBeenCalled();
            expect(mockReconcileCall).not.toHaveBeenCalled();
        }
    );

    test('historical sync fails closed before client selection without company context', async () => {
        await expect(twilioSync.syncHistoricalCalls(7))
            .rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED', httpStatus: 403 });
        expect(mockGetClientForCompany).not.toHaveBeenCalled();
        expect(mockColdReconcile).not.toHaveBeenCalled();
    });
});
