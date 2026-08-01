'use strict';

const mockValidateRequest = jest.fn();
jest.mock('twilio', () => {
    const factory = jest.fn(() => ({}));
    factory.validateRequest = (...args) => mockValidateRequest(...args);
    return factory;
});

const mockInsertInboxEvent = jest.fn();
jest.mock('../backend/src/db/queries', () => ({
    insertInboxEvent: (...args) => mockInsertInboxEvent(...args),
    findOrCreateTimeline: jest.fn(),
    upsertCall: jest.fn(),
}));

const mockDbQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({
    query: (...args) => mockDbQuery(...args),
}));

const mockResolveCompany = jest.fn();
const mockGetAuthToken = jest.fn();
jest.mock('../backend/src/services/telephonyTenantService', () => ({
    resolveCompanyByAccountSid: (...args) => mockResolveCompany(...args),
    getAuthTokenForAccountSid: (...args) => mockGetAuthToken(...args),
}));

const mockInboundContext = jest.fn();
const mockResolveCustomer = jest.fn();
const mockCreateSession = jest.fn();
jest.mock('../backend/src/services/callMaskingService', () => ({
    CODE_DIGITS: 6,
    getInboundMaskingContext: (...args) => mockInboundContext(...args),
    resolveCustomerForProviderCode: (...args) => mockResolveCustomer(...args),
    createSession: (...args) => mockCreateSession(...args),
}));

const mockIsServiceBlocked = jest.fn();
jest.mock('../backend/src/services/walletService', () => ({
    isServiceBlocked: (...args) => mockIsServiceBlocked(...args),
}));
jest.mock('../backend/src/services/callBlacklistService', () => ({
    isBlocked: jest.fn(() => Promise.resolve(false)),
}));

const mockResolveGroup = jest.fn();
jest.mock('../backend/src/services/groupRouting', () => ({
    resolveGroupForNumber: (...args) => mockResolveGroup(...args),
}));

const mockVoicemail = jest.fn(() => '<Response><Say>Company voicemail</Say></Response>');
jest.mock('../backend/src/services/callFlowRuntime', () => ({
    buildVoicemailTwiml: (...args) => mockVoicemail(...args),
    startExecution: jest.fn(),
    getExecution: jest.fn(),
    advance: jest.fn(),
    eventFromDialStatus: jest.fn(),
    vapiEventFromDialStatus: jest.fn(),
}));

jest.mock('../backend/src/services/realtimeService', () => ({
    publishCallUpdate: jest.fn(),
}));

const {
    handleVoiceInbound,
    handleMaskingCode,
    handleMaskingConsent,
} = require('../backend/src/webhooks/twilioWebhooks');

const COMPANY_A = '11111111-1111-1111-1111-111111111111';
const PROVIDER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ACCOUNT_SID = 'AC11111111111111111111111111111111';
const MASKING = '+16174044425';
const PROVIDER_PHONE = '+16175550000';
const CUSTOMER_PHONE = '+16175550123';

function makeReq(body, originalUrl, query = {}) {
    return {
        body,
        query,
        headers: { 'x-twilio-signature': 'signed-request' },
        protocol: 'https',
        get: header => header === 'host' ? 'api.example.test' : '',
        originalUrl,
    };
}

function makeRes() {
    const res = {};
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    res.type = jest.fn(() => res);
    res.send = jest.fn(() => res);
    return res;
}

const ORIGINAL_ENV = process.env.NODE_ENV;

beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'production';
    process.env.TWILIO_ACCOUNT_SID = ACCOUNT_SID;
    process.env.TWILIO_AUTH_TOKEN = 'auth-token';
    process.env.WEBHOOK_BASE_URL = 'https://api.example.test';
    mockValidateRequest.mockReturnValue(true);
    mockResolveCompany.mockResolvedValue(COMPANY_A);
    mockGetAuthToken.mockResolvedValue('auth-token');
    mockIsServiceBlocked.mockResolvedValue(false);
    mockInsertInboxEvent.mockResolvedValue({ id: 1 });
    mockResolveGroup.mockResolvedValue(null);
});

afterAll(() => {
    process.env.NODE_ENV = ORIGINAL_ENV;
});

describe('CALL-MASKING Twilio webhook flow', () => {
    test('IVR mode: signed registered-provider inbound returns a six-digit Gather', async () => {
        mockInboundContext.mockResolvedValue({
            company_id: COMPANY_A,
            masking_number: MASKING,
            provider_user_id: PROVIDER,
        });
        const req = makeReq({
            AccountSid: ACCOUNT_SID,
            CallSid: 'CA_parent',
            CallStatus: 'ringing',
            From: PROVIDER_PHONE,
            To: MASKING,
        }, '/webhooks/twilio/voice-inbound');
        const res = makeRes();

        await handleVoiceInbound(req, res);

        expect(mockValidateRequest).toHaveBeenCalled();
        expect(mockInboundContext).toHaveBeenCalledWith(
            COMPANY_A,
            MASKING,
            PROVIDER_PHONE
        );
        const twiml = res.send.mock.calls[0][0];
        expect(twiml).toContain('<Gather');
        expect(twiml).toContain('numDigits="6"');
        expect(twiml).toContain('/voice-mask-code?attempt=1');
        expect(twiml).toContain('Enter the six digit customer code');
        // CALL-MASK-SILENT-001: no recording announcement on either leg.
        expect(twiml).not.toContain('may be recorded');
        expect(twiml).not.toContain(CUSTOMER_PHONE);
        expect(mockInsertInboxEvent).not.toHaveBeenCalled();
    });

    test('DIRECT mode: signed Gather action resolves post-dial digits, maps the call, records, and dials with masked caller ID', async () => {
        const resolved = {
            company_id: COMPANY_A,
            masking_number: MASKING,
            provider_user_id: PROVIDER,
            contact_id: 42,
            customer_phone: CUSTOMER_PHONE,
        };
        mockResolveCustomer.mockResolvedValue(resolved);
        mockCreateSession.mockResolvedValue({
            company_id: COMPANY_A,
            call_sid: 'CA_parent',
            contact_id: 42,
        });
        const req = makeReq({
            AccountSid: ACCOUNT_SID,
            CallSid: 'CA_parent',
            CallStatus: 'in-progress',
            From: PROVIDER_PHONE,
            To: MASKING,
            Digits: '000123',
        }, '/webhooks/twilio/voice-mask-code?attempt=1', { attempt: '1' });
        const res = makeRes();

        await handleMaskingCode(req, res);

        expect(mockResolveCustomer).toHaveBeenCalledWith(COMPANY_A, {
            maskingNumber: MASKING,
            providerPhone: PROVIDER_PHONE,
            code: '000123',
        });
        expect(mockCreateSession).toHaveBeenCalledWith(COMPANY_A, 'CA_parent', resolved);
        expect(mockCreateSession.mock.invocationCallOrder[0])
            .toBeLessThan(mockInsertInboxEvent.mock.invocationCallOrder[0]);
        expect(mockInsertInboxEvent).toHaveBeenCalledWith(expect.objectContaining({
            source: 'voice',
            eventType: 'call.inbound',
            callSid: 'CA_parent',
            payload: expect.not.objectContaining({ Digits: expect.anything() }),
        }));

        const twiml = res.send.mock.calls[0][0];
        expect(twiml).toContain(`callerId="${MASKING}"`);
        expect(twiml).toContain('record="record-from-answer-dual"');
        expect(twiml).toContain('/webhooks/twilio/recording-status');
        expect(twiml).toContain('/webhooks/twilio/voice-mask-consent');
        expect(twiml).toContain(CUSTOMER_PHONE);
        expect(twiml).not.toContain(PROVIDER_PHONE);
    });

    test('customer callback/non-provider on the masking number follows the existing company IVR fallback', async () => {
        mockInboundContext.mockResolvedValue(null);
        const req = makeReq({
            AccountSid: ACCOUNT_SID,
            CallSid: 'CA_customer_callback',
            CallStatus: 'ringing',
            From: CUSTOMER_PHONE,
            To: MASKING,
        }, '/webhooks/twilio/voice-inbound');
        const res = makeRes();

        await handleVoiceInbound(req, res);

        expect(mockResolveGroup).toHaveBeenCalledWith(MASKING);
        expect(mockVoicemail).toHaveBeenCalledWith({ baseUrl: 'https://api.example.test' });
        expect(res.send).toHaveBeenCalledWith('<Response><Say>Company voicemail</Say></Response>');
        expect(mockInsertInboxEvent).toHaveBeenCalledTimes(1);
    });

    test('called-party hook answers with an empty document and stays signature-gated', async () => {
        const req = makeReq({
            AccountSid: ACCOUNT_SID,
            CallSid: 'CA_child',
        }, '/webhooks/twilio/voice-mask-consent');
        const res = makeRes();
        await handleMaskingConsent(req, res);
        // CALL-MASK-SILENT-001: the customer hears a plain call — nothing is said.
        expect(res.send.mock.calls[0][0]).toContain('<Response />');
        expect(res.send.mock.calls[0][0]).not.toContain('<Say');

        mockValidateRequest.mockReturnValue(false);
        const denied = makeRes();
        await handleMaskingConsent(req, denied);
        expect(denied.status).toHaveBeenCalledWith(403);
    });

    test('invalid code never returns a customer number and allows one manual retry', async () => {
        mockResolveCustomer.mockResolvedValue(null);
        const req = makeReq({
            AccountSid: ACCOUNT_SID,
            CallSid: 'CA_bad_code',
            From: PROVIDER_PHONE,
            To: MASKING,
            Digits: '999999',
        }, '/webhooks/twilio/voice-mask-code?attempt=1', { attempt: '1' });
        const res = makeRes();
        await handleMaskingCode(req, res);
        const twiml = res.send.mock.calls[0][0];
        expect(twiml).toContain('not recognized');
        expect(twiml).toContain('attempt=2');
        expect(twiml).not.toContain(CUSTOMER_PHONE);
        expect(mockCreateSession).not.toHaveBeenCalled();
        expect(mockInsertInboxEvent).not.toHaveBeenCalled();
    });

    test('invalid Twilio signature cannot resolve a customer code', async () => {
        mockValidateRequest.mockReturnValue(false);
        const req = makeReq({
            AccountSid: ACCOUNT_SID,
            CallSid: 'CA_unsigned',
            From: PROVIDER_PHONE,
            To: MASKING,
            Digits: '000123',
        }, '/webhooks/twilio/voice-mask-code?attempt=1', { attempt: '1' });
        const res = makeRes();

        await handleMaskingCode(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(mockResolveCustomer).not.toHaveBeenCalled();
        expect(mockCreateSession).not.toHaveBeenCalled();
        expect(mockInsertInboxEvent).not.toHaveBeenCalled();
    });
});
