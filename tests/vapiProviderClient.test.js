'use strict';

const {
    VapiProviderClientError,
    createVapiProviderClient,
} = require('../backend/src/services/vapiProviderClient');

describe('VAPI-AGENCY-001 T4 provider read client', () => {
    test('GET /call preserves the raw decimal body and sends only platform authorization', async () => {
        const rawJson = '{"id":"call-a","cost":0.056500000000000001}';
        const http = { get: jest.fn().mockResolvedValue({ status: 200, data: rawJson }) };
        const client = createVapiProviderClient({
            http,
            apiKeyProvider: () => 'platform-secret',
        });

        await expect(client.getCall('call/a')).resolves.toBe(rawJson);
        expect(http.get).toHaveBeenCalledWith('/call/call%2Fa', expect.objectContaining({
            headers: { Authorization: 'Bearer platform-secret' },
            responseType: 'text',
            transformResponse: [expect.any(Function)],
        }));
    });

    test('an already JSON-parsed response is rejected before money can pass through float', async () => {
        const http = { get: jest.fn().mockResolvedValue({
            status: 200,
            data: { id: 'call-a', cost: 0.0565 },
        }) };
        const client = createVapiProviderClient({
            http,
            apiKeyProvider: () => 'platform-secret',
        });

        await expect(client.getCall('call-a')).rejects.toMatchObject({
            code: 'VAPI_PROVIDER_RAW_BODY_REQUIRED',
            retryable: false,
        });
    });

    test('list projection discards PII and preserves optional supplier cost as an exact lexeme', async () => {
        const http = { get: jest.fn().mockResolvedValue({
            status: 200,
            data: '[{"id":"call-a","createdAt":"2026-08-15T10:00:00.000Z",'
                + '"updatedAt":"2026-08-15T10:01:00.000Z",'
                + '"cost":0.056500000000000001,"transcript":"private",'
                + '"assistantId":"assistant-registry-a",'
                + '"metadata":{"albustoCallSessionId":"10000000-0000-4000-8000-000000000001",'
                + '"private":"discard-me"},'
                + '"customer":{"number":"+15555550100"},'
                + '"recordingUrl":"https://private.invalid/a"}]',
        }) };
        const client = createVapiProviderClient({
            http,
            apiKeyProvider: () => 'platform-secret',
        });

        await expect(client.listCalls({
            createdAtGe: '2026-08-15T00:00:00.000Z',
            createdAtLt: '2026-08-16T00:00:00.000Z',
            limit: 1000,
        })).resolves.toEqual([{
            id: 'call-a',
            createdAt: '2026-08-15T10:00:00.000Z',
            updatedAt: '2026-08-15T10:01:00.000Z',
            supplierCost: '0.056500000000000001',
            albustoCallSessionId: '10000000-0000-4000-8000-000000000001',
            assistantId: 'assistant-registry-a',
        }]);
        expect(http.get).toHaveBeenCalledWith('/call', expect.objectContaining({
            params: {
                createdAtGe: '2026-08-15T00:00:00.000Z',
                createdAtLt: '2026-08-16T00:00:00.000Z',
                limit: 1000,
            },
        }));
    });

    test('supports an updatedAt-only audit range for corrections to older calls', async () => {
        const http = { get: jest.fn().mockResolvedValue({ status: 200, data: '[]' }) };
        const client = createVapiProviderClient({
            http,
            apiKeyProvider: () => 'platform-secret',
        });

        await client.listCalls({
            updatedAtGe: '2026-08-15T00:00:00.000Z',
            updatedAtLt: '2026-08-16T00:00:00.000Z',
            limit: 1000,
        });

        expect(http.get).toHaveBeenCalledWith('/call', expect.objectContaining({
            params: {
                updatedAtGe: '2026-08-15T00:00:00.000Z',
                updatedAtLt: '2026-08-16T00:00:00.000Z',
                limit: 1000,
            },
        }));
    });

    test.each([
        [429, true],
        [503, true],
        [400, false],
    ])('maps provider HTTP %s without inventing a response sample', async (status, retryable) => {
        const http = { get: jest.fn().mockRejectedValue({ response: { status } }) };
        const client = createVapiProviderClient({
            http,
            apiKeyProvider: () => 'platform-secret',
        });

        await expect(client.getCall('call-a')).rejects.toEqual(expect.objectContaining({
            name: 'VapiProviderClientError',
            code: 'VAPI_PROVIDER_REQUEST_FAILED',
            status,
            retryable,
        }));
    });

    test('missing platform key fails closed before a request', async () => {
        const http = { get: jest.fn() };
        const client = createVapiProviderClient({ http, apiKeyProvider: () => '' });

        await expect(client.getCall('call-a')).rejects.toBeInstanceOf(VapiProviderClientError);
        expect(http.get).not.toHaveBeenCalled();
    });
});
