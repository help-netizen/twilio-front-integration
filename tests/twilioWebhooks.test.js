const mockInsertInboxEvent = jest.fn();
const mockResolveGroupForNumber = jest.fn();
const mockBuildVoicemailTwiml = jest.fn(() => '<?xml version="1.0" encoding="UTF-8"?><Response><Record /></Response>');
const mockAdvance = jest.fn();

jest.mock('../backend/src/db/queries', () => ({
    insertInboxEvent: (...args) => mockInsertInboxEvent(...args),
}));

jest.mock('../backend/src/services/realtimeService', () => ({
    broadcast: jest.fn(),
    publishCallUpdate: jest.fn(),
}));

jest.mock('../backend/src/services/groupRouting', () => ({
    resolveGroupForNumber: (...args) => mockResolveGroupForNumber(...args),
}));

jest.mock('../backend/src/services/callFlowRuntime', () => ({
    buildVoicemailTwiml: (...args) => mockBuildVoicemailTwiml(...args),
    advance: (...args) => mockAdvance(...args),
}));

const {
    handleVoiceInbound,
    handleVoiceStatus,
    handleVoicemailComplete,
    validateTwilioSignature,
} = require('../backend/src/webhooks/twilioWebhooks');

function makeReq(body = {}, headers = {}) {
    return {
        headers,
        body,
        query: {},
        protocol: 'https',
        get: header => header === 'host' ? 'test.example.com' : '',
        originalUrl: '/webhooks/twilio/voice-status',
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

describe('Twilio webhook handlers', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        process.env.NODE_ENV = 'development';
        process.env.TWILIO_AUTH_TOKEN = 'test_auth_token';
        mockInsertInboxEvent.mockResolvedValue({ id: 123 });
    });

    describe('validateTwilioSignature', () => {
        test('returns false when signature header is missing', () => {
            expect(await validateTwilioSignature(makeReq())).toBe(false);
        });

        test('returns false when auth token is missing', () => {
            delete process.env.TWILIO_AUTH_TOKEN;
            expect(await validateTwilioSignature(makeReq({}, { 'x-twilio-signature': 'sig' }))).toBe(false);
        });
    });

    describe('handleVoiceStatus', () => {
        test('returns 400 for missing CallSid', async () => {
            const req = makeReq({ CallStatus: 'completed' });
            const res = makeRes();

            await handleVoiceStatus(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith({ error: 'Missing CallSid or CallStatus' });
            expect(mockInsertInboxEvent).not.toHaveBeenCalled();
        });

        test('inserts a voice status event into webhook inbox and returns 204', async () => {
            const req = makeReq({
                CallSid: 'CA1234567890abcdef',
                CallStatus: 'completed',
                Timestamp: '1234567890',
            }, {
                'x-twilio-signature': 'valid-signature',
                'i-twilio-idempotency-token': 'idem-1',
            });
            const res = makeRes();

            await handleVoiceStatus(req, res);

            expect(mockInsertInboxEvent).toHaveBeenCalledWith(expect.objectContaining({
                eventKey: 'idem-1',
                source: 'voice',
                eventType: 'call.status_changed',
                callSid: 'CA1234567890abcdef',
                payload: expect.objectContaining({ CallStatus: 'completed' }),
            }));
            expect(res.status).toHaveBeenCalledWith(204);
            expect(res.send).toHaveBeenCalled();
        });

        test('returns 500 when inbox insert fails', async () => {
            mockInsertInboxEvent.mockRejectedValue(new Error('Database connection failed'));
            const req = makeReq({ CallSid: 'CA123', CallStatus: 'completed' });
            const res = makeRes();

            await handleVoiceStatus(req, res);

            expect(res.status).toHaveBeenCalledWith(500);
            expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
        });
    });

    describe('handleVoiceInbound F017 no-group guard', () => {
        test('routes inbound calls without an assigned group to voicemail only', async () => {
            mockResolveGroupForNumber.mockResolvedValue(null);
            const req = makeReq({
                CallSid: 'CA_no_group',
                From: '+15551112222',
                To: '+15553334444',
            });
            req.originalUrl = '/webhooks/twilio/voice-inbound';
            const res = makeRes();

            await handleVoiceInbound(req, res);

            expect(mockResolveGroupForNumber).toHaveBeenCalledWith('+15553334444');
            expect(mockBuildVoicemailTwiml).toHaveBeenCalledWith({ baseUrl: 'https://abc-metrics.fly.dev' });
            expect(res.type).toHaveBeenCalledWith('text/xml');
            expect(res.send.mock.calls[0][0]).toContain('<Record');
            expect(res.send.mock.calls[0][0]).not.toContain('<Client');
            expect(res.send.mock.calls[0][0]).not.toContain('<Sip');
        });
    });

    describe('handleVoicemailComplete', () => {
        test('advances the active flow with voicemail.recorded before hanging up', async () => {
            mockAdvance.mockResolvedValue('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup /></Response>');
            const req = makeReq({ CallSid: 'CA_vm', RecordingSid: 'RE_vm' });
            req.originalUrl = '/webhooks/twilio/voicemail-complete?flowEvent=voicemail.recorded';
            req.query = { flowEvent: 'voicemail.recorded' };
            const res = makeRes();

            await handleVoicemailComplete(req, res);

            expect(mockAdvance).toHaveBeenCalledWith('CA_vm', 'voicemail.recorded', expect.stringMatching(/^trace_/));
            expect(res.type).toHaveBeenCalledWith('text/xml');
            expect(res.send.mock.calls[0][0]).toContain('<Hangup');
        });
    });
});
