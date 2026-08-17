'use strict';

const bootstrap = require('../backend/scripts/bootstrap-vapi-assistant-registry');

const COMPANY = '00000000-0000-0000-0000-000000000001';
const ENVIRONMENT = Object.freeze({
    VAPI_INBOUND_ASSISTANT_ID: '30e85a87-9d7e-4694-828e-1fea7d10f3ef',
    VAPI_LEAD_CALL_ASSISTANT_ID: 'ef874329-1111-4111-8111-111111111111',
    VAPI_OUTBOUND_ASSISTANT_ID: 'c1e2831b-e91f-46a9-86d8-6b40252bd29a',
    VAPI_API_KEY: 'test-platform-key',
});

test('requires company id and defaults to dry-run', () => {
    expect(bootstrap.parseArgs(['--company-id', COMPANY])).toEqual({
        companyId: COMPANY,
        apply: false,
        verifyProvider: false,
    });
    expect(bootstrap.parseArgs([`--company-id=${COMPANY}`, '--apply'])).toMatchObject({
        companyId: COMPANY,
        apply: true,
    });
    expect(() => bootstrap.parseArgs([])).toThrow(
        expect.objectContaining({ code: 'VAPI_REGISTRY_BOOTSTRAP_COMPANY_ID_REQUIRED' }),
    );
    expect(() => bootstrap.parseArgs([
        '--company-id', COMPANY, '--apply', '--dry-run',
    ])).toThrow(expect.objectContaining({ code: 'VAPI_REGISTRY_BOOTSTRAP_MODE_CONFLICT' }));
});

test('refuses to bootstrap when any assistant identifier is missing or invalid', () => {
    expect(() => bootstrap.readAssistantIds({
        VAPI_INBOUND_ASSISTANT_ID: ENVIRONMENT.VAPI_INBOUND_ASSISTANT_ID,
    })).toThrow(expect.objectContaining({
        code: 'VAPI_REGISTRY_BOOTSTRAP_ASSISTANT_IDS_REQUIRED',
        message: expect.stringContaining('VAPI_LEAD_CALL_ASSISTANT_ID'),
    }));
    expect(() => bootstrap.readAssistantIds({
        ...ENVIRONMENT,
        VAPI_OUTBOUND_ASSISTANT_ID: 'not-an-id',
    })).toThrow(expect.objectContaining({
        code: 'VAPI_REGISTRY_BOOTSTRAP_ASSISTANT_ID_INVALID',
    }));
    expect(() => bootstrap.readAssistantIds({
        ...ENVIRONMENT,
        VAPI_OUTBOUND_ASSISTANT_ID: ENVIRONMENT.VAPI_INBOUND_ASSISTANT_ID,
    })).toThrow(expect.objectContaining({
        code: 'VAPI_REGISTRY_BOOTSTRAP_ASSISTANT_IDS_NOT_DISTINCT',
    }));
});

test('optional provider verification performs read-only GETs for all three ids', async () => {
    const assistants = bootstrap.readAssistantIds(ENVIRONMENT);
    const http = {
        get: jest.fn(async (url) => ({ data: { id: decodeURIComponent(url.split('/').pop()) } })),
    };

    await expect(bootstrap.verifyProviderAssistants(assistants, ENVIRONMENT, { http }))
        .resolves.toBeUndefined();

    expect(http.get).toHaveBeenCalledTimes(3);
    for (const call of http.get.mock.calls) {
        expect(call[0]).toMatch(/^https:\/\/api\.vapi\.ai\/assistant\//);
        expect(call[1]).toMatchObject({
            headers: { Authorization: 'Bearer test-platform-key' },
        });
    }
});
