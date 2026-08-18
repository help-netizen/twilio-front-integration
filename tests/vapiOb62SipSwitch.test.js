'use strict';

const {
    PHONE_NUMBER_ID,
    STATIC_ASSISTANT_ID,
    DEFAULT_ASSISTANT_REQUEST_URL,
    run,
} = require('../scripts/vapi-ob62-sip-switch');

function resource(overrides = {}) {
    return {
        id: PHONE_NUMBER_ID,
        name: 'Blanc AI Dev SIP Ingress',
        sipUri: 'sip:blanc-ai-dev@sip.vapi.ai',
        assistantId: STATIC_ASSISTANT_ID,
        server: null,
        isServerUrlSecretSet: false,
        updatedAt: '2026-08-18T12:00:00.000Z',
        ...overrides,
    };
}

function fakeProvider(readbacks) {
    return {
        get: jest.fn(async () => readbacks.shift()),
        patch: jest.fn(async () => resource()),
    };
}

test('switch is dry-run by default and never touches the provider or prints a secret', async () => {
    const provider = fakeProvider([]);
    const result = await run(['switch'], {
        provider,
        environment: {
            VAPI_API_KEY: 'provider-key',
            VAPI_ASSISTANT_REQUEST_SECRET: 'must-not-appear',
        },
    });

    expect(result).toEqual({
        mode: 'dry-run',
        operation: 'switch',
        phoneNumberId: PHONE_NUMBER_ID,
        body: {
            assistantId: null,
            server: {
                url: DEFAULT_ASSISTANT_REQUEST_URL,
                secret: '<redacted>',
                timeoutSeconds: 20,
            },
        },
    });
    expect(provider.get).not.toHaveBeenCalled();
    expect(provider.patch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('must-not-appear');
});

test('switch applies dynamic assistant selection and verifies write-only secret by flag', async () => {
    const provider = fakeProvider([
        resource(),
        resource({
            assistantId: null,
            server: { url: DEFAULT_ASSISTANT_REQUEST_URL, timeoutSeconds: 20 },
            isServerUrlSecretSet: true,
        }),
    ]);

    const result = await run(['switch', '--apply'], {
        provider,
        environment: {
            VAPI_API_KEY: 'provider-key',
            VAPI_ASSISTANT_REQUEST_SECRET: 'company-specific-secret',
        },
    });

    expect(provider.patch).toHaveBeenCalledWith({
        assistantId: null,
        server: {
            url: DEFAULT_ASSISTANT_REQUEST_URL,
            secret: 'company-specific-secret',
            timeoutSeconds: 20,
        },
    });
    expect(result.after).toEqual(expect.objectContaining({
        assistantId: null,
        serverUrl: DEFAULT_ASSISTANT_REQUEST_URL,
        isServerUrlSecretSet: true,
    }));
    expect(JSON.stringify(result)).not.toContain('company-specific-secret');
});

test('rollback is one operation that restores the static assistant and removes server routing', async () => {
    const provider = fakeProvider([
        resource({
            assistantId: null,
            server: { url: DEFAULT_ASSISTANT_REQUEST_URL, timeoutSeconds: 20 },
            isServerUrlSecretSet: true,
        }),
        resource(),
    ]);

    const result = await run(['rollback', '--apply'], {
        provider,
        environment: { VAPI_API_KEY: 'provider-key' },
    });

    expect(provider.patch).toHaveBeenCalledWith({
        assistantId: STATIC_ASSISTANT_ID,
        server: null,
    });
    expect(result.after).toEqual(expect.objectContaining({
        assistantId: STATIC_ASSISTANT_ID,
        serverUrl: null,
    }));
});

test('switch aborts when the target is already owned by an unexpected assistant', async () => {
    const provider = fakeProvider([resource({ assistantId: 'foreign-assistant-id' })]);

    await expect(run(['switch', '--apply'], {
        provider,
        environment: {
            VAPI_API_KEY: 'provider-key',
            VAPI_ASSISTANT_REQUEST_SECRET: 'company-specific-secret',
        },
    })).rejects.toMatchObject({ code: 'OB62_UNEXPECTED_STATIC_ASSISTANT' });
    expect(provider.patch).not.toHaveBeenCalled();
});
