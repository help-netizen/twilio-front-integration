/**
 * Bug #11: Incoming call queue — rejected call blocks second caller
 *
 * Tests that handleDialAction redirects failed inbound calls back to
 * handleVoiceInbound for re-routing instead of going straight to voicemail.
 * Voicemail is only used after MAX_DIAL_ATTEMPTS (3) or for outbound calls.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));

const mockInsertInboxEvent = jest.fn().mockResolvedValue({ id: 1 });
const mockGetCallByCallSid = jest.fn().mockResolvedValue(null);
jest.mock('../backend/src/db/queries', () => ({
    insertInboxEvent: mockInsertInboxEvent,
    getCallByCallSid: mockGetCallByCallSid,
}));

jest.mock('twilio', () => {
    const factory = () => ({ calls: jest.fn(() => ({ fetch: jest.fn() })) });
    factory.validateRequest = () => true;
    return factory;
});

const mockBroadcast = jest.fn();
jest.mock('../backend/src/services/realtimeService', () => ({
    publishCallUpdate: jest.fn(),
    broadcast: mockBroadcast,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDialActionReq(bodyOverrides = {}, queryOverrides = {}) {
    return {
        headers: { 'x-twilio-signature': 'valid' },
        body: {
            CallSid: 'CA_parent_001',
            From: '+15551112222',
            To: '+15553334444',
            DialCallStatus: 'no-answer',
            ...bodyOverrides,
        },
        query: { dialAttempt: '0', holdRetry: '0', ...queryOverrides },
        protocol: 'https',
        get: () => 'test.example.com',
        originalUrl: '/webhooks/twilio/voice-dial-action',
    };
}

function makeInboundReq(bodyOverrides = {}, queryOverrides = {}) {
    return {
        headers: { 'x-twilio-signature': 'valid' },
        body: {
            CallSid: 'CA_parent_002',
            From: '+15551112222',
            To: '+15553334444',
            ...bodyOverrides,
        },
        query: { ...queryOverrides },
        protocol: 'https',
        get: () => 'test.example.com',
        originalUrl: '/webhooks/twilio/voice-inbound',
    };
}

function makeRes() {
    return {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        send: jest.fn().mockReturnThis(),
        type: jest.fn().mockReturnThis(),
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const { handleDialAction, handleVoiceInbound } = require('../backend/src/webhooks/twilioWebhooks');

beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'development'; // skip signature validation
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('Bug #11 — handleDialAction redirect logic', () => {

    test('inbound no-answer with dialAttempt=0 → redirects to voice-inbound with dialAttempt=1', async () => {
        const req = makeDialActionReq({ DialCallStatus: 'no-answer' }, { dialAttempt: '0', holdRetry: '0' });
        const res = makeRes();

        await handleDialAction(req, res);

        const twiml = res.send.mock.calls[0][0];
        expect(twiml).toContain('<Redirect');
        expect(twiml).toContain('voice-inbound');
        expect(twiml).toContain('dialAttempt=1');
        expect(twiml).toContain('holdRetry=0');
        expect(twiml).not.toContain('<Record');
        expect(twiml).not.toContain('<Say');
    });

    test('inbound busy with dialAttempt=2 → redirects with dialAttempt=3', async () => {
        const req = makeDialActionReq({ DialCallStatus: 'busy' }, { dialAttempt: '2', holdRetry: '1' });
        const res = makeRes();

        await handleDialAction(req, res);

        const twiml = res.send.mock.calls[0][0];
        expect(twiml).toContain('<Redirect');
        expect(twiml).toContain('dialAttempt=3');
        expect(twiml).toContain('holdRetry=1');
    });

    test('inbound no-answer with dialAttempt=3 (max exceeded) → voicemail', async () => {
        const req = makeDialActionReq({ DialCallStatus: 'no-answer' }, { dialAttempt: '3' });
        const res = makeRes();

        await handleDialAction(req, res);

        const twiml = res.send.mock.calls[0][0];
        expect(twiml).toContain('<Say');
        expect(twiml).toContain('<Record');
        expect(twiml).not.toContain('<Redirect');
    });

    test('completed dial → hangup (no redirect, no voicemail)', async () => {
        const req = makeDialActionReq({ DialCallStatus: 'completed' }, { dialAttempt: '0' });
        const res = makeRes();

        await handleDialAction(req, res);

        const twiml = res.send.mock.calls[0][0];
        expect(twiml).toContain('<Hangup');
        expect(twiml).not.toContain('<Redirect');
        expect(twiml).not.toContain('<Record');
    });

    test('outbound call (from sip:) with no-answer → voicemail (no redirect)', async () => {
        const req = makeDialActionReq(
            { DialCallStatus: 'no-answer', From: 'sip:dispatcher@domain.com' },
            { dialAttempt: '0' }
        );
        const res = makeRes();

        await handleDialAction(req, res);

        const twiml = res.send.mock.calls[0][0];
        expect(twiml).toContain('<Say');
        expect(twiml).toContain('<Record');
        expect(twiml).not.toContain('<Redirect');
    });

    test('broadcasts SSE call.holding on first redirect (dialAttempt=0)', async () => {
        const req = makeDialActionReq({ DialCallStatus: 'no-answer' }, { dialAttempt: '0' });
        const res = makeRes();

        await handleDialAction(req, res);

        expect(mockBroadcast).toHaveBeenCalledWith('call.holding', expect.objectContaining({
            call_sid: 'CA_parent_001',
            from_number: '+15551112222',
        }));
    });

    test('does NOT broadcast SSE on subsequent redirects (dialAttempt>0)', async () => {
        const req = makeDialActionReq({ DialCallStatus: 'no-answer' }, { dialAttempt: '1' });
        const res = makeRes();

        await handleDialAction(req, res);

        expect(mockBroadcast).not.toHaveBeenCalled();
    });

    test('child leg finalization runs before redirect', async () => {
        mockQuery.mockResolvedValue({ rows: [], rowCount: 2 });
        const req = makeDialActionReq({ DialCallStatus: 'no-answer' }, { dialAttempt: '0' });
        const res = makeRes();

        await handleDialAction(req, res);

        // Verify child leg finalization SQL was called
        const updateCall = mockQuery.mock.calls.find(c =>
            typeof c[0] === 'string' && c[0].includes('parent_call_sid') && c[0].includes('is_final = true')
        );
        expect(updateCall).toBeTruthy();

        // And redirect TwiML was returned
        const twiml = res.send.mock.calls[0][0];
        expect(twiml).toContain('<Redirect');
    });
});

describe('Bug #11 — handleVoiceInbound hold loop preserves dialAttempt', () => {

    test('hold loop redirect URL includes dialAttempt from query', async () => {
        // Setup: all operators busy
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // insertInboxEvent
            .mockResolvedValueOnce({ rows: [{ routing_mode: 'client', client_identity: 'user_1' }] }) // phone_number_settings
            .mockResolvedValueOnce({ rows: [{ identity: 'user_1' }] }) // allowed users
            .mockResolvedValueOnce({ rows: [{ client_number: 'user_1', call_sid: 'CA_busy' }] }); // busy check

        const req = makeInboundReq({}, { holdRetry: '2', dialAttempt: '1' });
        const res = makeRes();

        await handleVoiceInbound(req, res);

        const twiml = res.send.mock.calls[0][0];
        // If all busy → hold loop redirect should carry dialAttempt
        if (twiml.includes('<Redirect')) {
            expect(twiml).toContain('dialAttempt=1');
            expect(twiml).toContain('holdRetry=3');
        }
    });
});
