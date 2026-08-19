/**
 * The payload below is the body Vapi actually POSTed to
 * /api/vapi/call-status/assistant-request for a real inbound SIP call, copied out
 * of `GET /logs?type=Webhook` on 2026-08-19. Account/carrier identifiers and the
 * one-time correlation token are masked; every KEY, the nesting, and the shape of
 * every value are verbatim — those are what the contract turns on. It is kept whole
 * on purpose: every previous probe of this route was
 * synthetic, and the field that broke production — `call.assistantOverrides` —
 * is one no hand-written fixture ever thought to include.
 *
 * Vapi populates `call.assistantOverrides.variableValues` itself from the INVITE's
 * custom headers. The anti-spoof guard read that as the caller choosing an
 * assistant and answered 400, so every inbound call ended
 * `assistant-request-returned-error` and the caller heard Vapi's error prompt.
 * The same structure is also the ONLY place our correlation token arrives — with
 * the `x-` prefix stripped — so binding (and therefore cost attribution) depends
 * on reading it from there.
 */
'use strict';

const express = require('express');
const request = require('supertest');

const mockResolveCredential = jest.fn();
class MockMachineCredentialError extends Error {
    constructor(code, status = 401) {
        super(code);
        this.code = code;
        this.status = status;
    }
}
jest.mock('../backend/src/services/machineCredentialService', () => ({
    SURFACES: { VAPI_ASSISTANT_REQUEST: 'vapi_assistant_request' },
    ACCESS_SCOPES: { VAPI_ASSISTANT_REQUEST: 'vapi_assistant_request:invoke' },
    MachineCredentialError: MockMachineCredentialError,
    resolveCredential: (...args) => mockResolveCredential(...args),
}));

const mockBindInboundCall = jest.fn();
const mockRecordUnattributedInboundCall = jest.fn();
class MockVapiIdentityError extends Error {
    constructor(code, status = 409) {
        super(code);
        this.code = code;
        this.status = status;
    }
}
jest.mock('../backend/src/services/vapiCallIdentityService', () => ({
    TOKEN_HEADER: 'x-albusto-call-token',
    VapiIdentityError: MockVapiIdentityError,
    bindInboundCall: (...args) => mockBindInboundCall(...args),
    recordUnattributedInboundCall: (...args) => mockRecordUnattributedInboundCall(...args),
}));

const mockResolveInboundAssistant = jest.fn();
class MockVapiAssistantRegistryError extends Error {
    constructor(code, status = 409) {
        super(code);
        this.code = code;
        this.status = status;
    }
}
jest.mock('../backend/src/services/vapiAssistantRegistryService', () => ({
    VapiAssistantRegistryError: MockVapiAssistantRegistryError,
    resolveInboundAssistant: (...args) => mockResolveInboundAssistant(...args),
}));

const callStatusRouter = require('../backend/src/routes/vapiCallStatus');
const assistantRequestRouter = require('../backend/src/routes/vapiAssistantRequest');

const COMPANY = '00000000-0000-4000-8000-00000000000a';
const LIVE_ASSISTANT = '30e85a87-9d7e-4694-828e-1fea7d10f3ef';
const REAL_TOKEN = 'maskedCorrelationTokenForTheRegressionFixture';

const REAL_INBOUND_SIP_ASSISTANT_REQUEST = {
    "message": {
        "timestamp": 1787173368682,
        "type": "assistant-request",
        "call": {
            "id": "01a01bd5-7351-7cc6-aec0-349030348269",
            "assistantId": null,
            "customerId": null,
            "phoneNumberId": "d446b324-f016-48ba-b536-78c61652184d",
            "type": "inboundPhoneCall",
            "startedAt": null,
            "endedAt": null,
            "createdAt": "2026-08-19T21:02:48.657Z",
            "updatedAt": "2026-08-19T21:02:48.657Z",
            "orgId": "00000000-0000-4000-8000-0000000000b1",
            "status": "ringing",
            "assistantOverrides": {
                "variableValues": {
                    "cid": "masked-sbc-call-id@0.0.0.0",
                    "account-sid": "00000000-0000-4000-8000-0000000000a1",
                    "forwarded-for": "54.172.60.1",
                    "twilio-callsid": "CAmasked00000000000000000000000000",
                    "application-sid": "00000000-0000-4000-8000-0000000000a2",
                    "voip-carrier-sid": "00000000-0000-4000-8000-0000000000a3",
                    "twilio-accountsid": "ACmasked00000000000000000000000000",
                    "albusto-call-token": "maskedCorrelationTokenForTheRegressionFixture",
                    "originating-carrier": "Twilio"
                }
            },
            "assistantOverride": null,
            "squad": null,
            "squadId": null,
            "squadOverrides": null,
            "destination": null,
            "transport": {
                "callSid": "3080f40d-07af-4b31-a370-870e86ca3b35",
                "provider": "vapi.sip",
                "sbcCallSid": "masked-sbc-call-id@0.0.0.0"
            },
            "phoneCallProvider": "vapi",
            "phoneCallTransport": "sip"
        }
    }
};

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/vapi/call-status', callStatusRouter);
    return app;
}

function realBody() {
    return JSON.parse(JSON.stringify(REAL_INBOUND_SIP_ASSISTANT_REQUEST));
}

beforeEach(() => {
    jest.clearAllMocks();
    mockResolveCredential.mockResolvedValue({ id: 'cred-1', companyId: COMPANY });
    mockBindInboundCall.mockResolvedValue({
        companyId: COMPANY,
        providerCallId: REAL_INBOUND_SIP_ASSISTANT_REQUEST.message.call.id,
        sessionId: 'session-1',
        assistantId: LIVE_ASSISTANT,
        idempotent: false,
    });
    mockResolveInboundAssistant.mockResolvedValue({ expected_vapi_assistant_id: LIVE_ASSISTANT });
});

describe('a real inbound SIP assistant-request', () => {
    test('is answered with the assistant instead of 400', async () => {
        const response = await request(makeApp())
            .post('/api/vapi/call-status/assistant-request')
            .set('x-vapi-secret', 'secret')
            .send(realBody());

        expect(response.status).toBe(200);
        expect(response.body.assistantId).toBe(LIVE_ASSISTANT);
    });

    test('binds the call using the token Vapi hid in variableValues', async () => {
        await request(makeApp())
            .post('/api/vapi/call-status/assistant-request')
            .set('x-vapi-secret', 'secret')
            .send(realBody());

        expect(mockBindInboundCall).toHaveBeenCalledTimes(1);
        expect(mockBindInboundCall.mock.calls[0][0]).toMatchObject({
            companyId: COMPANY,
            correlationToken: REAL_TOKEN,
            source: 'assistant_request',
        });
        // Falling back to the unattributed answer would still speak to the caller
        // but would leave vapi_call_id null — the exact hole OB-62 exists to close.
        expect(mockRecordUnattributedInboundCall).not.toHaveBeenCalled();
    });

    test('provider-populated variableValues are not a selection claim', () => {
        const { message } = realBody();
        expect(assistantRequestRouter.hasProviderSelectionClaims(message)).toBe(false);
    });
});

describe('the guard still refuses a genuine selection claim', () => {
    test('an override that carries more than variableValues is refused', async () => {
        const body = realBody();
        body.message.call.assistantOverrides.model = { provider: 'openai', model: 'gpt-4o' };

        const response = await request(makeApp())
            .post('/api/vapi/call-status/assistant-request')
            .set('x-vapi-secret', 'secret')
            .send(body);

        expect(response.status).toBe(400);
        expect(response.body.code).toBe('VAPI_ASSISTANT_REQUEST_SELECTION_FORBIDDEN');
        expect(mockBindInboundCall).not.toHaveBeenCalled();
    });

    test('a caller-supplied assistantId is still refused', async () => {
        const body = realBody();
        body.message.call.assistantId = '00000000-0000-4000-8000-0000000000ff';

        const response = await request(makeApp())
            .post('/api/vapi/call-status/assistant-request')
            .set('x-vapi-secret', 'secret')
            .send(body);

        expect(response.status).toBe(400);
        expect(response.body.code).toBe('VAPI_ASSISTANT_REQUEST_SELECTION_FORBIDDEN');
    });

    test('a non-object override is refused', () => {
        expect(assistantRequestRouter.overridesClaimSelection('variableValues')).toBe(true);
        expect(assistantRequestRouter.overridesClaimSelection(null)).toBe(false);
        expect(assistantRequestRouter.overridesClaimSelection({ variableValues: {} })).toBe(false);
    });
});
