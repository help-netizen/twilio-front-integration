'use strict';

const {
    createVapiAgencyProviderClient,
} = require('../backend/src/services/vapiAgencyProviderClient');

const ASSISTANT_ID = 'assistant-00000001';
const PHONE_ID = 'phone-00000001';

function clientWithResponses(responses) {
    const request = jest.fn();
    for (const response of responses) request.mockResolvedValueOnce({ data: response });
    return {
        request,
        client: createVapiAgencyProviderClient({
            http: { request },
            apiKeyProvider: () => 'platform-private-key',
        }),
    };
}

test('assistant create, patch and read use only the platform assistant endpoints', async () => {
    const payload = { name: 'Server template' };
    const { client, request } = clientWithResponses([
        { id: ASSISTANT_ID },
        { id: ASSISTANT_ID },
        { id: ASSISTANT_ID, updatedAt: '2026-08-17T12:00:00.000Z' },
    ]);
    await client.createAssistant(payload);
    await client.updateAssistant(ASSISTANT_ID, payload);
    await client.getAssistant(ASSISTANT_ID);
    expect(request.mock.calls.map(([config]) => [config.method, config.url])).toEqual([
        ['post', '/assistant'],
        ['patch', `/assistant/${ASSISTANT_ID}`],
        ['get', `/assistant/${ASSISTANT_ID}`],
    ]);
    expect(request.mock.calls.flatMap(([config]) => config.url)).not.toContain('/org');
});

test('SIP create, patch and read use phone-number endpoints and preserve null assistant binding', async () => {
    const payload = {
        provider: 'vapi',
        sipUri: 'sip:tenant@sip.vapi.ai',
        assistantId: null,
    };
    const { client, request } = clientWithResponses([
        { id: PHONE_ID },
        { id: PHONE_ID },
        { id: PHONE_ID, updatedAt: '2026-08-17T12:00:00.000Z' },
    ]);
    await client.createPhoneNumber(payload);
    await client.updatePhoneNumber(PHONE_ID, payload);
    await client.getPhoneNumber(PHONE_ID);
    expect(request.mock.calls[0][0]).toMatchObject({
        method: 'post',
        url: '/phone-number',
        data: expect.objectContaining({ assistantId: null }),
    });
    expect(request.mock.calls[1][0].url).toBe(`/phone-number/${PHONE_ID}`);
    expect(request.mock.calls[2][0].url).toBe(`/phone-number/${PHONE_ID}`);
});

test('unexpected list and mutation response shapes fail closed', async () => {
    const invalidList = clientWithResponses([{ results: [] }]).client;
    await expect(invalidList.listAssistants()).rejects.toMatchObject({
        code: 'VAPI_AGENCY_ASSISTANT_LIST_INVALID',
    });

    const wrongId = clientWithResponses([{ id: 'assistant-00000002' }]).client;
    await expect(wrongId.updateAssistant(ASSISTANT_ID, {})).rejects.toMatchObject({
        code: 'VAPI_AGENCY_ASSISTANT_PATCH_ID_MISMATCH',
    });
});

test('list projections retain only identifiers needed for idempotent discovery', async () => {
    const { client } = clientWithResponses([
        [{
            id: ASSISTANT_ID,
            metadata: { albustoCompanyId: 'company-a' },
            server: { secret: 'must-not-leave-provider-adapter' },
            model: { messages: [{ content: 'private transcript-like prompt' }] },
        }],
        [{
            id: PHONE_ID,
            sipUri: 'sip:tenant@sip.vapi.ai',
            number: '+16175550100',
            server: { secret: 'must-not-leave-provider-adapter' },
        }],
    ]);
    await expect(client.listAssistants()).resolves.toEqual([{
        id: ASSISTANT_ID,
        metadata: { albustoCompanyId: 'company-a' },
    }]);
    await expect(client.listPhoneNumbers()).resolves.toEqual([{
        id: PHONE_ID,
        sipUri: 'sip:tenant@sip.vapi.ai',
    }]);
});
