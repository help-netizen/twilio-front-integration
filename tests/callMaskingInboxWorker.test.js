'use strict';

const mockGetCall = jest.fn();
const mockFindTimeline = jest.fn();
const mockUpsertCall = jest.fn();
const mockAppendCallEvent = jest.fn();
const mockUpsertRecording = jest.fn();

jest.mock('../backend/src/db/queries', () => ({
    getCallByCallSid: (...args) => mockGetCall(...args),
    findOrCreateTimeline: (...args) => mockFindTimeline(...args),
    findOrCreateAnonymousTimeline: jest.fn(),
    upsertCall: (...args) => mockUpsertCall(...args),
    appendCallEvent: (...args) => mockAppendCallEvent(...args),
    upsertRecording: (...args) => mockUpsertRecording(...args),
}));

const mockDbQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({
    query: (...args) => mockDbQuery(...args),
}));

const mockResolveCompany = jest.fn();
jest.mock('../backend/src/services/telephonyTenantService', () => ({
    resolveCompanyByAccountSid: (...args) => mockResolveCompany(...args),
}));

const mockGetSession = jest.fn();
jest.mock('../backend/src/services/callMaskingService', () => ({
    getSessionForCallEvent: (...args) => mockGetSession(...args),
}));

jest.mock('../backend/src/services/twilioClient', () => ({
    getTwilioClient: jest.fn(() => {
        throw new Error('not used by non-final test events');
    }),
}));
jest.mock('../backend/src/services/realtimeService', () => ({
    publishCallUpdate: jest.fn(),
    broadcast: jest.fn(),
}));

const { processEvent } = require('../backend/src/services/inboxWorker');

const COMPANY_A = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
    jest.clearAllMocks();
    mockResolveCompany.mockResolvedValue(COMPANY_A);
    mockGetCall.mockResolvedValue(null);
    mockDbQuery.mockResolvedValue({ rows: [] });
    mockAppendCallEvent.mockResolvedValue({});
});

describe('CALL-MASKING inbox attribution', () => {
    test('parent voice event is logged on the customer timeline with masked endpoints', async () => {
        mockGetSession.mockResolvedValue({
            call_sid: 'CA_parent',
            contact_id: 42,
            provider_user_id: 'provider-a',
            masking_number: '+16174044425',
            customer_phone: '+16175550123',
        });
        mockFindTimeline.mockResolvedValue({ id: 77, contact_id: 42 });
        mockUpsertCall.mockImplementation(async value => ({
            call_sid: value.callSid,
            status: value.status,
        }));

        await processEvent({
            id: 1,
            source: 'voice',
            event_type: 'call.inbound',
            payload: {
                AccountSid: 'AC_A',
                CallSid: 'CA_parent',
                CallStatus: 'ringing',
                Direction: 'inbound',
                From: '+16175550000',
                To: '+16174044425',
            },
        });

        expect(mockGetSession).toHaveBeenCalledWith(COMPANY_A, 'CA_parent', null);
        expect(mockFindTimeline).toHaveBeenCalledWith('+16175550123', COMPANY_A);
        expect(mockUpsertCall).toHaveBeenCalledWith(expect.objectContaining({
            companyId: COMPANY_A,
            contactId: 42,
            timelineId: 77,
            direction: 'outbound',
            fromNumber: '+16174044425',
            toNumber: '+16174044425',
        }));
        expect(mockAppendCallEvent).toHaveBeenCalledWith(
            'CA_parent',
            'call.inbound',
            expect.any(Date),
            expect.any(Object),
            'voice',
            COMPANY_A
        );
    });

    test('recording callback persists on the AccountSid-resolved company', async () => {
        mockUpsertRecording.mockResolvedValue({
            recording_sid: 'RE_masked',
            status: 'in-progress',
        });

        await processEvent({
            id: 2,
            source: 'recording',
            event_type: 'recording.updated',
            payload: {
                AccountSid: 'AC_A',
                CallSid: 'CA_parent',
                RecordingSid: 'RE_masked',
                RecordingStatus: 'in-progress',
                RecordingChannels: '2',
            },
        });

        expect(mockUpsertRecording).toHaveBeenCalledWith(expect.objectContaining({
            recordingSid: 'RE_masked',
            callSid: 'CA_parent',
            channels: 2,
            companyId: COMPANY_A,
        }));
        expect(mockAppendCallEvent).toHaveBeenCalledWith(
            'CA_parent',
            'recording.updated',
            expect.any(Date),
            expect.any(Object),
            'recording',
            COMPANY_A
        );
    });
});
