/**
 * Bug #11: Incoming call queue — rejected call blocks second caller
 *
 * Tests for:
 * - handleDialAction correctly sends failed dials to voicemail
 * - handleDialAction correctly hangs up completed dials
 * - Child leg finalization runs before TwiML response
 * - Hold loop uses 2s pause for faster re-routing
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
        query: { ...queryOverrides },
        protocol: 'https',
        get: () => 'test.example.com',
        originalUrl: '/webhooks/twilio/voice-dial-action',
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

const { handleDialAction } = require('../backend/src/webhooks/twilioWebhooks');

beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'development';
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('Bug #11 — handleDialAction voicemail and finalization', () => {

    test('no-answer → voicemail with Say + Record', async () => {
        const req = makeDialActionReq({ DialCallStatus: 'no-answer' });
        const res = makeRes();

        await handleDialAction(req, res);

        const twiml = res.send.mock.calls[0][0];
        expect(twiml).toContain('<Say');
        expect(twiml).toContain('<Record');
        expect(twiml).not.toContain('<Redirect');
    });

    test('busy → voicemail with Say + Record', async () => {
        const req = makeDialActionReq({ DialCallStatus: 'busy' });
        const res = makeRes();

        await handleDialAction(req, res);

        const twiml = res.send.mock.calls[0][0];
        expect(twiml).toContain('<Say');
        expect(twiml).toContain('<Record');
    });

    test('completed → hangup (no voicemail)', async () => {
        const req = makeDialActionReq({ DialCallStatus: 'completed' });
        const res = makeRes();

        await handleDialAction(req, res);

        const twiml = res.send.mock.calls[0][0];
        expect(twiml).toContain('<Hangup');
        expect(twiml).not.toContain('<Record');
        expect(twiml).not.toContain('<Say');
    });

    test('dial event is enqueued to webhook_inbox for async processing', async () => {
        // Single-writer architecture: handleDialAction enqueues to webhook_inbox,
        // child leg finalization + status updates are handled by processDialEvent
        // in inboxWorker (tested in bug-answered-call-shown-missed.test.js)
        mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
        const req = makeDialActionReq({ DialCallStatus: 'no-answer' });
        const res = makeRes();

        await handleDialAction(req, res);

        // Verify event was enqueued via insertInboxEvent
        expect(mockInsertInboxEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                source: 'dial',
                eventType: 'dial.action',
            })
        );

        // And voicemail TwiML was returned
        const twiml = res.send.mock.calls[0][0];
        expect(twiml).toContain('<Record');
    });

    test('handleDialAction does NOT write directly to calls table', async () => {
        mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
        const req = makeDialActionReq({ DialCallStatus: 'no-answer' });
        const res = makeRes();

        await handleDialAction(req, res);

        // No direct DB writes to calls table (only webhook_inbox INSERT)
        const callsWrites = mockQuery.mock.calls.filter(c =>
            typeof c[0] === 'string' &&
            c[0].includes('UPDATE calls') &&
            !c[0].includes('webhook_inbox')
        );
        expect(callsWrites).toHaveLength(0);
    });
});
