const mockInsertInboxEvent = jest.fn();
const mockResolveGroupForNumber = jest.fn();
const mockBuildVoicemailTwiml = jest.fn(() => '<?xml version="1.0" encoding="UTF-8"?><Response><Record /></Response>');
const mockAdvance = jest.fn();
const mockDbQuery = jest.fn();
const mockIsServiceBlocked = jest.fn();
const mockIsCallerBlocked = jest.fn();
const mockFindOrCreateTimeline = jest.fn();
const mockUpsertCall = jest.fn();
const mockResolveCompanyByAccountSid = jest.fn();
const mockGetAuthTokenForAccountSid = jest.fn();

jest.mock('../backend/src/db/queries', () => ({
    insertInboxEvent: (...args) => mockInsertInboxEvent(...args),
    findOrCreateTimeline: (...args) => mockFindOrCreateTimeline(...args),
    upsertCall: (...args) => mockUpsertCall(...args),
}));

jest.mock('../backend/src/db/connection', () => ({
    query: (...args) => mockDbQuery(...args),
}));

jest.mock('../backend/src/services/walletService', () => ({
    isServiceBlocked: (...args) => mockIsServiceBlocked(...args),
}));

jest.mock('../backend/src/services/callBlacklistService', () => ({
    isBlocked: (...args) => mockIsCallerBlocked(...args),
}));

jest.mock('../backend/src/services/realtimeService', () => ({
    broadcast: jest.fn(),
    publishCallUpdate: jest.fn(),
}));

jest.mock('../backend/src/services/telephonyTenantService', () => ({
    resolveCompanyByAccountSid: (...args) => mockResolveCompanyByAccountSid(...args),
    getAuthTokenForAccountSid: (...args) => mockGetAuthTokenForAccountSid(...args),
    DEFAULT_COMPANY_ID: '00000000-0000-0000-0000-000000000001',
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
    generateEventKey,
} = require('../backend/src/webhooks/twilioWebhooks');
const { verifyStreamToken } = require('../backend/src/services/mediaStreamTokenService');

function makeReq(body = {}, headers = {}) {
    return {
        headers,
        body: { AccountSid: 'AC-master', ...body },
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
        process.env.TWILIO_ACCOUNT_SID = 'AC-master';
        delete process.env.FEATURE_REALTIME_TRANSCRIPTION;
        delete process.env.TWILIO_MEDIA_STREAM_TOKEN_SECRET;
        mockInsertInboxEvent.mockResolvedValue({ id: 123 });
        // Defaults: number maps to no company / not blocked. NOTE (ONBTEL-001
        // C1): an inbound call whose company cannot be resolved is now
        // fail-closed REJECTED — inbound routing tests must resolve a company.
        mockDbQuery.mockResolvedValue({ rows: [] });
        mockIsCallerBlocked.mockResolvedValue(false);
        mockIsServiceBlocked.mockResolvedValue(false);
        mockFindOrCreateTimeline.mockResolvedValue({ id: 'tl_1', contact_id: 'c_1' });
        mockUpsertCall.mockResolvedValue({ id: 'call_1', status: 'no-answer' });
        mockResolveCompanyByAccountSid.mockResolvedValue('company_1');
        mockGetAuthTokenForAccountSid.mockResolvedValue('test_auth_token');
    });

    describe('validateTwilioSignature', () => {
        test('returns false when signature header is missing', async () => {
            expect(await validateTwilioSignature(makeReq())).toBe(false);
        });

        test('returns false when auth token is missing', async () => {
            mockGetAuthTokenForAccountSid.mockResolvedValue(null);
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
                eventKey: expect.stringMatching(/^twilio:voice:idem:[a-f0-9]{64}$/),
                source: 'voice',
                eventType: 'call.status_changed',
                callSid: 'CA1234567890abcdef',
                companyId: 'company_1',
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

        test('SAB-TW-REPLAY: missing Timestamp still produces one deterministic key', () => {
            const req = makeReq({
                AccountSid: 'AC-sub',
                CallSid: 'CA-replay',
                CallStatus: 'completed',
            });
            const now = jest.spyOn(Date, 'now')
                .mockReturnValueOnce(1000)
                .mockReturnValueOnce(2000);
            const first = generateEventKey('voice', 'call.status_changed', req.body, req);
            const second = generateEventKey('voice', 'call.status_changed', req.body, req);
            const differentEvent = generateEventKey('voice', 'call.dial_completed', req.body, req);
            now.mockRestore();
            expect(second).toBe(first);
            expect(differentEvent).not.toBe(first);
        });

        test.each([
            ['dial', 'dial.action', { CallSid: 'CA-dial', DialCallStatus: 'completed' }],
            ['recording', 'recording.updated', { CallSid: 'CA-rec', RecordingSid: 'RE-replay', RecordingStatus: 'completed' }],
            ['transcription', 'transcript.updated', { CallSid: 'CA-tr', TranscriptionSid: 'TR-replay', TranscriptionStatus: 'completed' }],
        ])('SAB-TW-REPLAY: %s callback without Timestamp is stable', (source, eventType, payload) => {
            const req = makeReq({ AccountSid: 'AC-sub', ...payload });
            const now = jest.spyOn(Date, 'now')
                .mockReturnValueOnce(1000)
                .mockReturnValueOnce(2000);
            const first = generateEventKey(source, eventType, req.body, req);
            const replay = generateEventKey(source, eventType, req.body, req);
            now.mockRestore();
            expect(replay).toBe(first);
        });

        test('SAB-TW-DEFAULT T-foreign: unknown AccountSid is denied with no raw inbox write', async () => {
            mockResolveCompanyByAccountSid.mockResolvedValue(null);
            const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
            const req = makeReq({
                AccountSid: 'AC-foreign',
                CallSid: 'CA-foreign',
                CallStatus: 'completed',
                From: '+15550000001',
                To: '+15550000002',
            });
            const res = makeRes();

            await handleVoiceStatus(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(mockInsertInboxEvent).not.toHaveBeenCalled();
            const securityPayload = warn.mock.calls.find(([first]) => first === '[TwilioSecurity]')?.[1];
            expect(securityPayload).toEqual(expect.objectContaining({
                event: 'twilio.tenant_unresolved',
                metric: 'twilio_tenant_unresolved_total',
                increment: 1,
            }));
            expect(JSON.stringify(securityPayload)).not.toContain('AC-foreign');
            expect(JSON.stringify(securityPayload)).not.toContain('+1555');
            warn.mockRestore();
        });
    });

    describe('handleVoiceInbound F017 no-group guard', () => {
        test('routes inbound calls without an assigned group to voicemail only', async () => {
            // AccountSid resolves to company_1; To is routing data only.
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
            expect(mockBuildVoicemailTwiml).toHaveBeenCalledWith({ baseUrl: 'https://api.albusto.com' });
            expect(res.type).toHaveBeenCalledWith('text/xml');
            expect(res.send.mock.calls[0][0]).toContain('<Record');
            expect(res.send.mock.calls[0][0]).not.toContain('<Client');
            expect(res.send.mock.calls[0][0]).not.toContain('<Sip');
        });

        test('blocks inbound at the wallet grace floor: rejects without answering, logs a missed call', async () => {
            mockIsServiceBlocked.mockResolvedValue(true);
            mockFindOrCreateTimeline.mockResolvedValue({ id: 'tl_9', contact_id: 'contact_9' });
            const req = makeReq({ CallSid: 'CA_blocked', From: '+15551112222', To: '+15553334444' });
            req.originalUrl = '/webhooks/twilio/voice-inbound';
            const res = makeRes();

            await handleVoiceInbound(req, res);

            // Rejected before answering → Twilio never meters the call; no group routing.
            expect(mockIsServiceBlocked).toHaveBeenCalledWith('company_1');
            expect(res.send.mock.calls[0][0]).toContain('<Reject');
            expect(mockResolveGroupForNumber).not.toHaveBeenCalled();
            // Logged as a missed (no-answer) inbound call on the caller's timeline.
            expect(mockFindOrCreateTimeline).toHaveBeenCalledWith('+15551112222', 'company_1');
            expect(mockUpsertCall).toHaveBeenCalledWith(expect.objectContaining({
                callSid: 'CA_blocked', direction: 'inbound', status: 'no-answer', isFinal: true,
            }));
        });

        test('mints a company/call-bound HMAC custom parameter without exposing scope parameters', async () => {
            process.env.FEATURE_REALTIME_TRANSCRIPTION = 'true';
            process.env.TWILIO_MEDIA_STREAM_TOKEN_SECRET = 'test-media-stream-secret-32-bytes';
            const req = makeReq({
                AccountSid: 'AC-sub',
                CallSid: 'CA-stream',
                From: 'sip:agent@example.test',
                To: '+15553334444',
            });
            req.originalUrl = '/webhooks/twilio/voice-inbound';
            const res = makeRes();

            await handleVoiceInbound(req, res);

            const xml = String(res.send.mock.calls[0][0]);
            const token = xml.match(/name="streamToken" value="([^"]+)"/)?.[1];
            expect(token).toBeTruthy();
            expect(xml).not.toContain('name="companyId"');
            expect(xml).not.toContain('name="callSid"');
            expect(verifyStreamToken(token)).toMatchObject({
                company_id: 'company_1',
                call_sid: 'CA-stream',
                account_sid: 'AC-sub',
                direction: 'outbound',
            });
        });

        test('missing media HMAC secret disables only streaming and preserves the live call', async () => {
            process.env.FEATURE_REALTIME_TRANSCRIPTION = 'true';
            delete process.env.TWILIO_MEDIA_STREAM_TOKEN_SECRET;
            const req = makeReq({
                AccountSid: 'AC-master',
                CallSid: 'CA-master-live',
                From: 'sip:agent@example.test',
                To: '+15553334444',
            });
            req.originalUrl = '/webhooks/twilio/voice-inbound';
            const res = makeRes();

            await handleVoiceInbound(req, res);

            const xml = String(res.send.mock.calls[0][0]);
            expect(xml).toContain('<Dial');
            expect(xml).not.toContain('<Stream');
            expect(res.status).not.toHaveBeenCalledWith(500);
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
