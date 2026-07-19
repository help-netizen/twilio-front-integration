const mockListCalls = jest.fn();
const mockReconcileCall = jest.fn();
const mockGetClientForCompany = jest.fn();

jest.mock('../backend/src/services/twilioClient', () => ({
    getTwilioClient: jest.fn(() => ({ calls: { list: mockListCalls } })),
}));
jest.mock('../backend/src/services/telephonyTenantService', () => ({
    getClientForCompany: mockGetClientForCompany,
}));
jest.mock('../backend/src/services/reconcileService', () => ({
    reconcileCall: mockReconcileCall,
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
    jest.spyOn(global, 'setTimeout').mockImplementation(callback => {
        callback();
        return 0;
    });
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('manual Twilio sync tenant isolation', () => {
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
});
