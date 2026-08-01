'use strict';

// SARA-BACKUP-HARDEN-001: a crash anywhere in the flow-engine advance path must
// never surface as a webhook 500 — Twilio drops the live caller (observed
// 2026-08-01: pointer moved to the Sara backup node, no TwiML returned, the
// inbound parent finalized no-answer after 2s). The dial-action handler must
// fall back to the answering voicemail branch instead.

process.env.NODE_ENV = 'development';

jest.mock('../backend/src/db/queries', () => ({
    insertInboxEvent: jest.fn().mockResolvedValue({ inserted: true, id: 1 }),
}));
jest.mock('../backend/src/db/connection', () => ({
    query: jest.fn().mockResolvedValue({ rows: [] }),
    getClient: jest.fn(),
}));
jest.mock('../backend/src/services/telephonyTenantService', () => ({
    resolveCompanyForInboundNumber: jest.fn(),
    resolveCompanyIdForPayload: jest.fn().mockResolvedValue('11111111-1111-1111-1111-111111111111'),
}));
jest.mock('../backend/src/services/callMaskingService', () => ({
    CODE_DIGITS: 6,
    getInboundMaskingContext: jest.fn(),
    resolveCustomerForProviderCode: jest.fn(),
    createSession: jest.fn(),
    getSessionForCallEvent: jest.fn(),
}));
jest.mock('../backend/src/services/walletService', () => ({
    isServiceBlocked: jest.fn().mockResolvedValue(false),
}));
jest.mock('../backend/src/services/callBlacklistService', () => ({
    findActiveBlock: jest.fn().mockResolvedValue(null),
    recordBlockedCall: jest.fn(),
}));
jest.mock('../backend/src/services/groupRouting', () => ({
    resolveGroupForNumber: jest.fn(),
}));
const mockGetExecution = jest.fn();
const mockAdvance = jest.fn();
jest.mock('../backend/src/services/callFlowRuntime', () => ({
    buildVoicemailTwiml: jest.fn(() => '<Response><Say>vm</Say></Response>'),
    startExecution: jest.fn(),
    getExecution: (...a) => mockGetExecution(...a),
    advance: (...a) => mockAdvance(...a),
    eventFromDialStatus: jest.fn(() => 'dial.no_answer'),
    vapiEventFromDialStatus: jest.fn(() => 'vapi.failed'),
}));
jest.mock('../backend/src/services/realtimeService', () => ({
    publishCallUpdate: jest.fn(),
    broadcast: jest.fn(),
}));

const { handleDialAction } = require('../backend/src/webhooks/twilioWebhooks');

function makeRes() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        type() { return this; },
        send(payload) { this.body = String(payload); return this; },
    };
}

function makeReq() {
    return {
        body: { CallSid: 'CA_test_1', DialCallStatus: 'no-answer', From: '+16175550100', To: '+16174044425' },
        query: {},
        headers: {},
    };
}

afterEach(() => jest.clearAllMocks());

test('flow-engine crash in advance falls back to answering voicemail, not 500', async () => {
    mockGetExecution.mockResolvedValue({ status: 'active' });
    mockAdvance.mockRejectedValue(new Error('render exploded'));
    const res = makeRes();
    await handleDialAction(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<Record');
});

test('healthy flow advance still returns the engine TwiML', async () => {
    mockGetExecution.mockResolvedValue({ status: 'active' });
    mockAdvance.mockResolvedValue('<Response><Dial><Sip>sip:sara@sip.vapi.ai</Sip></Dial></Response>');
    const res = makeRes();
    await handleDialAction(makeReq(), res);
    expect(res.body).toContain('sip:sara@sip.vapi.ai');
});

test('getExecution crash also falls into the voicemail branch', async () => {
    mockGetExecution.mockRejectedValue(new Error('db down'));
    const res = makeRes();
    await handleDialAction(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<Record');
});
