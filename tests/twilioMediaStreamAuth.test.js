const { EventEmitter } = require('events');

const mockCreateSession = jest.fn();
const mockRouteAudio = jest.fn();
const mockTerminateSession = jest.fn().mockResolvedValue(undefined);
const mockResolveCompanyByAccountSid = jest.fn();
const mockValidateTwilioSignature = jest.fn();
const mockDbQuery = jest.fn();
const claimedJtis = new Set();

jest.mock('../backend/src/db/connection', () => ({
    query: (...args) => mockDbQuery(...args),
}));

jest.mock('../backend/src/services/realtimeTranscriptService', () => ({
    createSession: (...args) => mockCreateSession(...args),
    routeAudio: (...args) => mockRouteAudio(...args),
    terminateSession: (...args) => mockTerminateSession(...args),
    getActiveSessions: jest.fn(() => []),
}));

jest.mock('../backend/src/services/telephonyTenantService', () => ({
    resolveCompanyByAccountSid: (...args) => mockResolveCompanyByAccountSid(...args),
}));

jest.mock('../backend/src/webhooks/twilioWebhooks', () => ({
    validateTwilioSignature: (...args) => mockValidateTwilioSignature(...args),
    mediaStreamUrl: () => 'wss://api.example.test/ws/twilio-media',
}));

const { mintStreamToken, verifyStreamToken } = require('../backend/src/services/mediaStreamTokenService');
const { handleConnection } = require('../backend/src/services/mediaStreamServer');

const MASTER_COMPANY = '00000000-0000-0000-0000-000000000001';
const COMPANY_B = '22222222-2222-2222-2222-222222222222';
const MASTER_SID = 'AC-master';
const SUB_SID = 'AC-sub-b';
const SHARED_CALL_SID = 'CA-shared';

class FakeWebSocket extends EventEmitter {
    constructor() {
        super();
        this.close = jest.fn();
    }

    sendEvent(event) {
        this.emit('message', Buffer.from(JSON.stringify(event)));
    }
}

function request() {
    return {
        headers: {
            host: 'api.example.test',
            'x-forwarded-proto': 'https',
            'x-twilio-signature': 'twilio-signature',
        },
        url: '/ws/twilio-media',
    };
}

function startEvent(token, { accountSid = MASTER_SID, callSid = SHARED_CALL_SID, custom = {} } = {}) {
    return {
        event: 'start',
        streamSid: 'MZ-stream',
        start: {
            accountSid,
            callSid,
            tracks: ['inbound', 'outbound'],
            customParameters: { streamToken: token, ...custom },
        },
    };
}

async function flushEvents() {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
}

beforeEach(() => {
    jest.clearAllMocks();
    claimedJtis.clear();
    process.env.TWILIO_MEDIA_STREAM_TOKEN_SECRET = 'media-test-secret-at-least-32-bytes';
    mockResolveCompanyByAccountSid.mockImplementation(async accountSid => (
        accountSid === MASTER_SID ? MASTER_COMPANY
            : accountSid === SUB_SID ? COMPANY_B
                : null
    ));
    mockValidateTwilioSignature.mockResolvedValue(true);
    mockDbQuery.mockImplementation(async (sql, params = []) => {
        if (String(sql).includes('INSERT INTO twilio_media_stream_token_claims')) {
            if (claimedJtis.has(params[0])) return { rows: [] };
            claimedJtis.add(params[0]);
            return { rows: [{ jti: params[0] }] };
        }
        return { rows: [] };
    });
    mockTerminateSession.mockResolvedValue(undefined);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    jest.useRealTimers();
    console.log.mockRestore();
    console.warn.mockRestore();
});

test('SAB-TW-WS-HMAC: forged token is closed before session creation or audio', async () => {
    const token = mintStreamToken({
        companyId: MASTER_COMPANY,
        callSid: SHARED_CALL_SID,
        accountSid: MASTER_SID,
    });
    const forged = `${token.slice(0, -1)}${token.endsWith('x') ? 'y' : 'x'}`;
    const ws = new FakeWebSocket();
    handleConnection(ws, request());

    ws.sendEvent(startEvent(forged));
    await flushEvents();

    expect(ws.close).toHaveBeenCalledWith(1008, 'Unauthorized media stream');
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockRouteAudio).not.toHaveBeenCalled();
});

test('expired token fails verification', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const token = mintStreamToken({
        companyId: MASTER_COMPANY,
        callSid: SHARED_CALL_SID,
        accountSid: MASTER_SID,
    });
    now.mockReturnValue(1_061_000);
    expect(verifyStreamToken(token)).toBeNull();
    now.mockRestore();
});

test('T-foreign: a token claiming another company cannot bind the AccountSid', async () => {
    const crossCompanyToken = mintStreamToken({
        companyId: MASTER_COMPANY,
        callSid: SHARED_CALL_SID,
        accountSid: SUB_SID,
    });
    const ws = new FakeWebSocket();
    handleConnection(ws, request());

    ws.sendEvent(startEvent(crossCompanyToken, { accountSid: SUB_SID }));
    await flushEvents();

    expect(mockResolveCompanyByAccountSid).toHaveBeenCalledWith(SUB_SID);
    expect(ws.close).toHaveBeenCalledWith(1008, 'Unauthorized media stream');
    expect(mockCreateSession).not.toHaveBeenCalled();
});

test('unverified Twilio upgrade is closed before session creation', async () => {
    mockValidateTwilioSignature.mockResolvedValue(false);
    const token = mintStreamToken({
        companyId: MASTER_COMPANY,
        callSid: SHARED_CALL_SID,
        accountSid: MASTER_SID,
    });
    const ws = new FakeWebSocket();
    handleConnection(ws, request());

    ws.sendEvent(startEvent(token));
    await flushEvents();

    expect(mockValidateTwilioSignature).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
            accountSid: MASTER_SID,
            url: 'wss://api.example.test/ws/twilio-media',
        })
    );
    expect(ws.close).toHaveBeenCalledWith(1008, 'Unauthorized media stream');
    expect(mockCreateSession).not.toHaveBeenCalled();
});

test('T-blast: same CallSid in master and subaccount routes by verified company tuple', async () => {
    const masterToken = mintStreamToken({
        companyId: MASTER_COMPANY,
        callSid: SHARED_CALL_SID,
        accountSid: MASTER_SID,
        direction: 'outbound',
    });
    const subToken = mintStreamToken({
        companyId: COMPANY_B,
        callSid: SHARED_CALL_SID,
        accountSid: SUB_SID,
        direction: 'outbound',
    });
    const masterWs = new FakeWebSocket();
    const subWs = new FakeWebSocket();
    handleConnection(masterWs, request());
    handleConnection(subWs, request());

    masterWs.sendEvent(startEvent(masterToken, {
        custom: { companyId: COMPANY_B, callSid: 'CA-forged' },
    }));
    subWs.sendEvent(startEvent(subToken, { accountSid: SUB_SID }));
    await flushEvents();

    expect(mockCreateSession).toHaveBeenCalledWith(
        MASTER_COMPANY,
        SHARED_CALL_SID,
        expect.objectContaining({ direction: 'outbound' })
    );
    expect(mockCreateSession).toHaveBeenCalledWith(
        COMPANY_B,
        SHARED_CALL_SID,
        expect.objectContaining({ direction: 'outbound' })
    );

    masterWs.sendEvent({
        event: 'media',
        media: { track: 'inbound', payload: Buffer.from('master-audio').toString('base64') },
    });
    subWs.sendEvent({
        event: 'media',
        media: { track: 'inbound', payload: Buffer.from('sub-audio').toString('base64') },
    });
    await flushEvents();

    expect(mockRouteAudio).toHaveBeenCalledWith(
        MASTER_COMPANY, SHARED_CALL_SID, 'inbound', Buffer.from('master-audio')
    );
    expect(mockRouteAudio).toHaveBeenCalledWith(
        COMPANY_B, SHARED_CALL_SID, 'inbound', Buffer.from('sub-audio')
    );
    expect(mockValidateTwilioSignature).toHaveBeenCalledTimes(2);
});

test('SAB-TW-WS-REPLAY: a captured valid stream token is single-use', async () => {
    const token = mintStreamToken({
        companyId: MASTER_COMPANY,
        callSid: SHARED_CALL_SID,
        accountSid: MASTER_SID,
    });
    const firstWs = new FakeWebSocket();
    const replayWs = new FakeWebSocket();
    handleConnection(firstWs, request());
    handleConnection(replayWs, request());

    firstWs.sendEvent(startEvent(token));
    await flushEvents();
    replayWs.sendEvent(startEvent(token));
    await flushEvents();

    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    expect(mockCreateSession).toHaveBeenCalledWith(
        MASTER_COMPANY,
        SHARED_CALL_SID,
        expect.any(Object)
    );
    expect(replayWs.close).toHaveBeenCalledWith(1008, 'Unauthorized media stream');
});

test('SAB-TW-WS-TIMEOUT: validation completing after auth timeout cannot create a session', async () => {
    jest.useFakeTimers();
    let resolveCompany;
    mockResolveCompanyByAccountSid.mockReturnValue(new Promise(resolve => { resolveCompany = resolve; }));
    const token = mintStreamToken({
        companyId: MASTER_COMPANY,
        callSid: SHARED_CALL_SID,
        accountSid: MASTER_SID,
    });
    const ws = new FakeWebSocket();
    handleConnection(ws, request());
    ws.sendEvent(startEvent(token));

    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(5000);
    resolveCompany(MASTER_COMPANY);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(ws.close).toHaveBeenCalledWith(1008, 'Unauthorized media stream');
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockRouteAudio).not.toHaveBeenCalled();
    jest.useRealTimers();
});
