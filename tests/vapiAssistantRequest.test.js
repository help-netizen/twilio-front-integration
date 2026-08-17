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

const COMPANY_A = '00000000-0000-4000-8000-00000000000a';
const COMPANY_B = '00000000-0000-4000-8000-00000000000b';

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/vapi/call-status', callStatusRouter);
    return app;
}

function payload(overrides = {}) {
    return {
        message: {
            type: 'assistant-request',
            call: {
                id: 'provider-call-a',
                orgId: 'provider-platform-org',
                type: 'inboundPhoneCall',
                status: 'ringing',
                sipHeaders: {
                    'X-Albusto-Call-Token': 'opaque-token-a',
                },
            },
            ...overrides,
        },
    };
}

function post(body = payload(), secret = 'credential-a') {
    const pending = request(makeApp())
        .post('/api/vapi/call-status/assistant-request');
    if (secret !== null) pending.set('x-vapi-secret', secret);
    return pending.send(body);
}

beforeEach(() => {
    jest.clearAllMocks();
    mockResolveCredential.mockImplementation(async (secret, options) => {
        expect(options).toEqual({
            surface: 'vapi_assistant_request',
            requiredScope: 'vapi_assistant_request:invoke',
        });
        if (!secret) throw new MockMachineCredentialError('MACHINE_CREDENTIAL_REQUIRED', 401);
        if (secret === 'revoked') {
            throw new MockMachineCredentialError('MACHINE_CREDENTIAL_REVOKED', 401);
        }
        if (secret === 'credential-a') {
            return { id: '101', companyId: COMPANY_A };
        }
        if (secret === 'credential-b') {
            return { id: '202', companyId: COMPANY_B };
        }
        throw new MockMachineCredentialError('MACHINE_CREDENTIAL_INVALID', 401);
    });
    mockBindInboundCall.mockResolvedValue({
        assistantId: 'assistant-registry-a',
        idempotent: false,
    });
    mockRecordUnattributedInboundCall.mockResolvedValue(undefined);
    mockResolveInboundAssistant.mockImplementation(async ({ companyId }) => ({
        expected_vapi_assistant_id: companyId === COMPANY_A
            ? 'assistant-registry-a'
            : 'assistant-registry-b',
    }));
});

describe('VAPI-AGENCY-001 T2 assistant-request machine boundary', () => {
    test('T-own binds provider call before returning only the stored assistant id', async () => {
        const body = payload({
            companyId: COMPANY_B,
            profileId: 'foreign-profile',
        });
        body.message.call.companyId = COMPANY_B;
        body.message.call.sipHeaders['x-blanc-company-id'] = COMPANY_B;
        body.message.call.sipHeaders['x-blanc-assistant-profile'] = 'foreign-profile';

        const response = await post(body);

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ assistantId: 'assistant-registry-a' });
        expect(mockBindInboundCall).toHaveBeenCalledWith({
            companyId: COMPANY_A,
            credentialId: '101',
            correlationToken: 'opaque-token-a',
            providerCallId: 'provider-call-a',
            source: 'assistant_request',
        });
        expect(JSON.stringify(mockBindInboundCall.mock.calls)).not.toContain('foreign-profile');
    });

    test('T-foreign credential cannot bind another company token and answers only its own assistant', async () => {
        mockBindInboundCall.mockRejectedValue(
            new MockVapiIdentityError('VAPI_IDENTITY_TOKEN_NOT_FOUND', 404),
        );

        const response = await post(payload(), 'credential-b');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ assistantId: 'assistant-registry-b' });
        expect(mockBindInboundCall).toHaveBeenCalledWith(expect.objectContaining({
            companyId: COMPANY_B,
            credentialId: '202',
        }));
        expect(mockRecordUnattributedInboundCall).toHaveBeenCalledWith({
            companyId: COMPANY_B,
            providerCallId: 'provider-call-a',
            reason: 'assistant_request_bind_failed',
        });
    });

    test.each([
        ['missing', null, 'MACHINE_CREDENTIAL_REQUIRED'],
        ['wrong', 'not-a-credential', 'MACHINE_CREDENTIAL_INVALID'],
        ['revoked', 'revoked', 'MACHINE_CREDENTIAL_REVOKED'],
    ])('%s credential fails before identity lookup', async (_label, secret, code) => {
        const response = await post(payload(), secret);

        expect(response.status).toBe(401);
        expect(response.body.code).toBe(code);
        expect(mockBindInboundCall).not.toHaveBeenCalled();
    });

    test('duplicate delivery is idempotent at the handler contract', async () => {
        mockBindInboundCall
            .mockResolvedValueOnce({ assistantId: 'assistant-registry-a', idempotent: false })
            .mockResolvedValueOnce({ assistantId: 'assistant-registry-a', idempotent: true });

        const first = await post();
        const duplicate = await post();

        expect(first.status).toBe(200);
        expect(duplicate.status).toBe(200);
        expect(first.body).toEqual({ assistantId: 'assistant-registry-a' });
        expect(duplicate.body).toEqual(first.body);
        expect(mockBindInboundCall).toHaveBeenCalledTimes(2);
    });

    test('provider id collision remains unattributed but does not drop the caller', async () => {
        mockBindInboundCall.mockRejectedValue(
            new MockVapiIdentityError('VAPI_IDENTITY_PROVIDER_CALL_COLLISION', 409),
        );

        const response = await post();

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ assistantId: 'assistant-registry-a' });
        expect(mockRecordUnattributedInboundCall).toHaveBeenCalledWith({
            companyId: COMPANY_A,
            providerCallId: 'provider-call-a',
            reason: 'assistant_request_bind_failed',
        });
    });

    test.each([
        ['assistantId', 'provider-assistant'],
        ['assistantOverrides', { variableValues: { companyId: COMPANY_B } }],
        ['destination', { type: 'number', number: '+15550000000' }],
        ['model', { provider: 'caller-controlled' }],
    ])('rejects caller-controlled %s before bind', async (field, value) => {
        const response = await post(payload({ [field]: value }));

        expect(response.status).toBe(400);
        expect(response.body.code).toBe('VAPI_ASSISTANT_REQUEST_SELECTION_FORBIDDEN');
        expect(mockBindInboundCall).not.toHaveBeenCalled();
    });

    test('rejects a non-null phone-number assistant claim before bind', async () => {
        const body = payload();
        body.message.phoneNumber = { assistantId: 'provider-assistant' };

        const response = await post(body);

        expect(response.status).toBe(400);
        expect(response.body.code).toBe('VAPI_ASSISTANT_REQUEST_SELECTION_FORBIDDEN');
        expect(mockBindInboundCall).not.toHaveBeenCalled();
    });

    test('SAB-FIX4: missing token answers from credential company and records unattributed call', async () => {
        const missing = payload();
        delete missing.message.call.sipHeaders;
        const missingResponse = await post(missing);

        expect(missingResponse.status).toBe(200);
        expect(missingResponse.body).toEqual({ assistantId: 'assistant-registry-a' });
        expect(mockResolveInboundAssistant).toHaveBeenCalledWith({ companyId: COMPANY_A });
        expect(mockRecordUnattributedInboundCall).toHaveBeenCalledWith({
            companyId: COMPANY_A,
            providerCallId: 'provider-call-a',
            reason: 'assistant_request_missing_token',
        });
        expect(mockBindInboundCall).not.toHaveBeenCalled();
    });

    test('tokenless fallback is tenant-distinct because machine credentials are distinct', async () => {
        const bodyA = payload();
        const bodyB = payload();
        delete bodyA.message.call.sipHeaders;
        delete bodyB.message.call.sipHeaders;
        bodyB.message.call.id = 'provider-call-b';

        const responseA = await post(bodyA, 'credential-a');
        const responseB = await post(bodyB, 'credential-b');

        expect(responseA.body).toEqual({ assistantId: 'assistant-registry-a' });
        expect(responseB.body).toEqual({ assistantId: 'assistant-registry-b' });
        expect(mockResolveInboundAssistant.mock.calls.map(([input]) => input.companyId).sort())
            .toEqual([COMPANY_A, COMPANY_B].sort());
    });

    test('tokenless answering survives an accounting-alert write failure', async () => {
        const body = payload();
        delete body.message.call.sipHeaders;
        mockRecordUnattributedInboundCall.mockRejectedValue(new Error('database unavailable'));
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        const response = await post(body);

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ assistantId: 'assistant-registry-a' });
        expect(errorSpy).toHaveBeenCalledWith(
            '[vapiAssistantRequest] unattributed call alert unavailable',
            expect.objectContaining({
                companyId: COMPANY_A,
                providerCallId: 'provider-call-a',
                reason: 'assistant_request_missing_token',
            }),
        );
        errorSpy.mockRestore();
    });

    test('SAB-FIX18: token bind failure degrades to the company assistant and durable alert', async () => {
        mockBindInboundCall.mockRejectedValue(new Error('identity database unavailable'));
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        const response = await post();

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ assistantId: 'assistant-registry-a' });
        expect(mockResolveInboundAssistant).toHaveBeenCalledWith({ companyId: COMPANY_A });
        expect(mockRecordUnattributedInboundCall).toHaveBeenCalledWith({
            companyId: COMPANY_A,
            providerCallId: 'provider-call-a',
            reason: 'assistant_request_bind_failed',
        });
        errorSpy.mockRestore();
    });

    test('ambiguous opaque token still fails closed', async () => {
        const ambiguous = payload();
        ambiguous.message.call.headers = { 'x-albusto-call-token': 'other-token' };
        const ambiguousResponse = await post(ambiguous);
        expect(ambiguousResponse.status).toBe(400);
        expect(ambiguousResponse.body.code).toBe('VAPI_IDENTITY_TOKEN_AMBIGUOUS');
        expect(mockBindInboundCall).not.toHaveBeenCalled();
        expect(mockResolveInboundAssistant).not.toHaveBeenCalled();
    });

    test('unknown required provider discriminators fail closed, extra fields are tolerated', async () => {
        const unknown = payload();
        unknown.message.call.type = 'provider-added-call-kind';
        const rejected = await post(unknown);
        expect(rejected.status).toBe(400);
        expect(rejected.body.code).toBe('VAPI_ASSISTANT_REQUEST_CONTRACT_INVALID');

        const extra = payload({ futureMessageField: { version: 2 } });
        extra.message.call.futureCallField = true;
        const accepted = await post(extra);
        expect(accepted.status).toBe(200);
        expect(accepted.body).toEqual({ assistantId: 'assistant-registry-a' });
    });
});
