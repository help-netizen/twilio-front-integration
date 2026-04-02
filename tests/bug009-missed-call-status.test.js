/**
 * Bug #9: Missed calls change from red (no-answer) to green (completed)
 *
 * Root cause: Twilio sends "completed" status for parent calls when TwiML
 * execution finishes, even if nobody answered. This overwrites the meaningful
 * "no-answer" status, causing the frontend to show green instead of red.
 *
 * Fix: Guard in processVoiceEvent + enrichFromTwilioApi to preserve
 * no-answer/voicemail_recording/voicemail_left statuses.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));

const mockInsertInboxEvent = jest.fn().mockResolvedValue({ id: 1 });
const mockGetCallByCallSid = jest.fn();
const mockUpsertCall = jest.fn();
const mockAppendCallEvent = jest.fn().mockResolvedValue({});
const mockClaimInboxEvents = jest.fn().mockResolvedValue([]);
jest.mock('../backend/src/db/queries', () => ({
    insertInboxEvent: mockInsertInboxEvent,
    getCallByCallSid: mockGetCallByCallSid,
    upsertCall: mockUpsertCall,
    appendCallEvent: mockAppendCallEvent,
    claimInboxEvents: mockClaimInboxEvents,
    findOrCreateTimeline: jest.fn().mockResolvedValue({ id: 1, contact_id: null }),
    markInboxEventProcessed: jest.fn(),
    markInboxEventFailed: jest.fn(),
}));

const mockTwilioFetch = jest.fn();
const mockTwilioCallsFn = jest.fn(() => ({ fetch: mockTwilioFetch }));
jest.mock('twilio', () => {
    const factory = () => ({ calls: mockTwilioCallsFn });
    factory.validateRequest = () => true;
    return factory;
});

jest.mock('../backend/src/services/realtimeService', () => ({
    publishCallUpdate: jest.fn(),
    broadcast: jest.fn(),
}));

jest.mock('../backend/src/services/reconcileStale', () => ({
    reconcileStaleCalls: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const { processEvent } = require('../backend/src/services/inboxWorker');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVoiceEvent(overrides = {}) {
    return {
        id: 1,
        source: 'voice',
        event_type: 'call.status_changed',
        call_sid: 'CA_parent_missed_001',
        payload: {
            CallSid: 'CA_parent_missed_001',
            CallStatus: 'completed',
            From: '+15551112222',
            To: '+15553334444',
            Direction: 'inbound',
            Timestamp: new Date().toISOString(),
            ...overrides,
        },
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Bug #9 — Missed call status preservation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        process.env.TWILIO_ACCOUNT_SID = 'ACtest';
        process.env.TWILIO_AUTH_TOKEN = 'test_token';
    });

    it('should NOT overwrite no-answer with completed from Twilio voice-status', async () => {
        // Existing call is no-answer (set by handleDialAction)
        mockGetCallByCallSid.mockResolvedValue({
            call_sid: 'CA_parent_missed_001',
            status: 'no-answer',
            is_final: true,
            direction: 'inbound',
        });
        mockUpsertCall.mockResolvedValue(null);

        const event = makeVoiceEvent({ CallStatus: 'completed' });
        await processEvent(event);

        // upsertCall should NOT have been called (skipUpsert = true)
        expect(mockUpsertCall).not.toHaveBeenCalled();
    });

    it('should NOT overwrite voicemail_recording with completed', async () => {
        mockGetCallByCallSid.mockResolvedValue({
            call_sid: 'CA_parent_missed_001',
            status: 'voicemail_recording',
            is_final: false,
            direction: 'inbound',
        });

        const event = makeVoiceEvent({ CallStatus: 'completed' });
        await processEvent(event);

        expect(mockUpsertCall).not.toHaveBeenCalled();
    });

    it('should NOT overwrite voicemail_left with completed', async () => {
        mockGetCallByCallSid.mockResolvedValue({
            call_sid: 'CA_parent_missed_001',
            status: 'voicemail_left',
            is_final: true,
            direction: 'inbound',
        });

        const event = makeVoiceEvent({ CallStatus: 'completed' });
        await processEvent(event);

        expect(mockUpsertCall).not.toHaveBeenCalled();
    });

    it('should allow ringing → completed transition (normal answered call)', async () => {
        mockGetCallByCallSid.mockResolvedValue({
            call_sid: 'CA_parent_missed_001',
            status: 'ringing',
            is_final: false,
            direction: 'inbound',
        });
        mockUpsertCall.mockResolvedValue({
            call_sid: 'CA_parent_missed_001',
            status: 'completed',
        });
        // Twilio API enrichment
        mockTwilioFetch.mockResolvedValue({
            status: 'completed',
            startTime: new Date().toISOString(),
            endTime: new Date().toISOString(),
            duration: '30',
            price: '-0.01',
            priceUnit: 'USD',
            parentCallSid: null,
            direction: 'inbound',
        });

        const event = makeVoiceEvent({ CallStatus: 'completed' });
        await processEvent(event);

        // Should have been upserted (ringing → completed is valid)
        expect(mockUpsertCall).toHaveBeenCalled();
    });

    it('should allow in-progress → completed transition', async () => {
        mockGetCallByCallSid
            .mockResolvedValueOnce({
                call_sid: 'CA_parent_missed_001',
                status: 'in-progress',
                is_final: false,
                direction: 'inbound',
            })
            // Second call after enrichment re-read
            .mockResolvedValueOnce({
                call_sid: 'CA_parent_missed_001',
                status: 'completed',
                is_final: true,
                direction: 'inbound',
            });
        mockUpsertCall.mockResolvedValue({
            call_sid: 'CA_parent_missed_001',
            status: 'completed',
        });
        mockTwilioFetch.mockResolvedValue({
            status: 'completed',
            startTime: new Date().toISOString(),
            endTime: new Date().toISOString(),
            duration: '120',
            price: '-0.02',
            priceUnit: 'USD',
            parentCallSid: null,
            direction: 'inbound',
        });

        const event = makeVoiceEvent({ CallStatus: 'completed' });
        await processEvent(event);

        expect(mockUpsertCall).toHaveBeenCalled();
    });

    it('should NOT overwrite no-answer with completed on CHILD call legs', async () => {
        // Child leg was set to no-answer by handleDialAction, then Twilio sends
        // voice-status "completed" for the same child SID.
        // Previously the guard only ran for parent calls (!parentCallSid),
        // leaving child legs unprotected.
        mockGetCallByCallSid.mockResolvedValue({
            call_sid: 'CA_child_missed_001',
            status: 'no-answer',
            is_final: true,
            direction: 'inbound',
        });

        const event = {
            id: 2,
            source: 'voice',
            event_type: 'call.status_changed',
            call_sid: 'CA_child_missed_001',
            payload: {
                CallSid: 'CA_child_missed_001',
                CallStatus: 'completed',
                ParentCallSid: 'CA_parent_missed_001',
                From: '+15551112222',
                To: 'sip:agent@sip.twilio.com',
                Direction: 'inbound',
                Timestamp: new Date().toISOString(),
            },
        };
        await processEvent(event);

        // upsertCall should NOT have been called — child's no-answer must be preserved
        expect(mockUpsertCall).not.toHaveBeenCalled();
    });
});
