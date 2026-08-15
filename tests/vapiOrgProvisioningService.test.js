'use strict';

const COMPANY = '00000000-0000-4000-8000-00000000000a';

const serviceModule = require('../backend/src/services/vapiOrgProvisioningService');

function harness({ connection = null, activeCredential = null, responsePayload = null } = {}) {
    const writes = [];
    const client = {
        release: jest.fn(),
        query: jest.fn(async (sql, params = []) => {
            const text = String(sql).replace(/\s+/g, ' ').trim();
            if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
            if (text.includes('pg_advisory_xact_lock')) return { rows: [{}] };
            if (text.includes('FROM companies')) return { rows: [{ id: COMPANY, name: 'Tenant A' }] };
            if (text.includes('FROM provider_connections')) return { rows: connection ? [connection] : [] };
            if (text.includes('FROM api_integrations')) return { rows: activeCredential ? [activeCredential] : [] };
            if (text.startsWith('INSERT INTO provider_connections') || text.startsWith('UPDATE provider_connections')) {
                writes.push({ text, params });
                return { rows: [], rowCount: 1 };
            }
            throw new Error(`Unexpected query: ${text}`);
        }),
    };
    const fetchImpl = jest.fn(async () => ({
        ok: true,
        json: async () => responsePayload || {
            id: 'org_tenant_a_123',
            privateKey: 'vapi-organization-private-key-tenant-a',
        },
    }));
    const encrypt = jest.fn(() => 'encrypted-envelope');
    const validateSecrets = jest.fn();
    const credentialService = {
        SURFACES: { VAPI_TOOLS: 'vapi_tools' },
        ACCESS_SCOPES: { VAPI_TOOLS: 'vapi_tools:invoke' },
        provisionCredential: jest.fn(async () => ({
            id: 'credential-a',
            secret: 'generated-tools-secret',
            created: true,
        })),
    };
    const service = serviceModule.createService({
        database: { getClient: jest.fn(async () => client) },
        fetchImpl,
        encrypt,
        validateSecrets,
        credentialService,
    });
    return { service, client, fetchImpl, encrypt, validateSecrets, credentialService, writes };
}

beforeEach(() => {
    process.env.VAPI_API_KEY = 'master-platform-key';
});

afterEach(() => {
    delete process.env.VAPI_API_KEY;
});

test('creates org, validates its key, stores encrypted connection, and issues same-company tool credential', async () => {
    const h = harness();
    const result = await h.service.provision({ companyId: COMPANY, environment: 'prod' });

    expect(result).toMatchObject({
        companyId: COMPANY,
        providerOrgId: 'org_tenant_a_123',
        organizationCreated: true,
        credential: { id: 'credential-a', created: true },
    });
    expect(h.fetchImpl).toHaveBeenCalledWith(
        serviceModule.VAPI_ORG_URL,
        expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
                Authorization: 'Bearer master-platform-key',
                'Idempotency-Key': `albusto-vapi-org:${COMPANY}:prod`,
            }),
            body: JSON.stringify({ name: 'Tenant A' }),
        })
    );
    expect(h.validateSecrets).toHaveBeenCalledTimes(1);
    expect(h.encrypt).toHaveBeenCalledWith(JSON.stringify({
        api_key: 'vapi-organization-private-key-tenant-a',
    }));
    expect(h.credentialService.provisionCredential).toHaveBeenCalledWith(expect.objectContaining({
        companyId: COMPANY,
        surface: 'vapi_tools',
        scopes: ['vapi_tools:invoke'],
        client: h.client,
    }));
    expect(h.writes).toHaveLength(1);
    expect(JSON.stringify(h.writes)).not.toContain('vapi-organization-private-key-tenant-a');
    expect(h.client.query.mock.calls.map(call => call[0])).toContain('COMMIT');
    expect(h.client.release).toHaveBeenCalled();
});

test('repeat provisioning reuses the local org and active credential without POST /org', async () => {
    const h = harness({
        connection: {
            id: 'connection-existing',
            provider_org_id: 'org-existing',
            status: 'active',
            encrypted_credentials_json: 'encrypted-existing',
        },
        activeCredential: { id: 'credential-existing' },
    });

    const result = await h.service.provision({ companyId: COMPANY, environment: 'prod' });

    expect(result).toMatchObject({
        connectionId: 'connection-existing',
        providerOrgId: 'org-existing',
        organizationCreated: false,
        credential: { id: 'credential-existing', created: false, secret: null },
    });
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.encrypt).not.toHaveBeenCalled();
    expect(h.validateSecrets).not.toHaveBeenCalled();
    expect(h.credentialService.provisionCredential).not.toHaveBeenCalled();
    expect(h.writes).toHaveLength(0);
});

test('unexpected undocumented endpoint response rolls back without changing an existing connection', async () => {
    const h = harness({
        connection: {
            id: 'connection-legacy',
            provider_org_id: null,
            status: 'active',
            encrypted_credentials_json: 'legacy-value',
        },
        responsePayload: { id: 'org-created-but-key-shape-changed', apiKey: 'not-privateKey' },
    });

    await expect(h.service.provision({ companyId: COMPANY, environment: 'prod' }))
        .rejects.toMatchObject({ code: 'VAPI_ORG_RESPONSE_INVALID', status: 502 });

    expect(h.writes).toHaveLength(0);
    expect(h.credentialService.provisionCredential).not.toHaveBeenCalled();
    expect(h.client.query.mock.calls.map(call => call[0])).toContain('ROLLBACK');
    expect(h.client.query.mock.calls.map(call => call[0])).not.toContain('COMMIT');
});

test('provisioning requires an explicit company before database or network work', async () => {
    const h = harness();
    await expect(h.service.provision({ environment: 'prod' }))
        .rejects.toMatchObject({ code: 'VAPI_COMPANY_REQUIRED', status: 400 });
    expect(h.client.query).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled();
});

test.each([
    [null],
    [{}],
    [{ id: 'org-valid-id', privateKey: 'short' }],
    [{ id: 42, privateKey: 'vapi-organization-private-key-tenant-a' }],
])('response shape %# is rejected fail-closed', payload => {
    expect(() => serviceModule.validateCreateOrgResponse(payload))
        .toThrow(expect.objectContaining({ code: 'VAPI_ORG_RESPONSE_INVALID' }));
});
