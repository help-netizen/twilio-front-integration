'use strict';

const mockWithTransaction = jest.fn();
jest.mock('../backend/src/services/transactionService', () => ({
    withTransaction: (...args) => mockWithTransaction(...args),
}));

const identity = require('../backend/src/services/vapiCallIdentityService');

test('cross-company provider id collision emits a redacted alert after durable quarantine', async () => {
    mockWithTransaction.mockResolvedValue({
        ok: false,
        code: 'provider_call_collision',
        status: 409,
        sessionId: 'session-b',
        companyId: '00000000-0000-4000-8000-00000000000b',
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(identity.bindInboundCall({
        companyId: '00000000-0000-4000-8000-00000000000b',
        credentialId: '202',
        correlationToken: 'secret-token-never-log',
        providerCallId: 'provider-call-collision',
        source: 'assistant_request',
    })).rejects.toMatchObject({
        code: 'VAPI_IDENTITY_PROVIDER_CALL_COLLISION',
        status: 409,
    });

    expect(errorSpy).toHaveBeenCalledWith('[VAPI_IDENTITY_ALERT]', {
        code: 'provider_call_collision',
        companyId: '00000000-0000-4000-8000-00000000000b',
        sessionId: 'session-b',
        providerCallId: 'provider-call-collision',
    });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('secret-token-never-log');
    errorSpy.mockRestore();
});
