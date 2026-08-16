'use strict';

process.env.BLANC_SERVER_PEPPER = 'machine-credential-test-pepper';

const mockDbQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockDbQuery }));

const { hashSecret } = require('../backend/src/middleware/integrationsAuth');
const service = require('../backend/src/services/machineCredentialService');

const COMPANY_A = '00000000-0000-4000-8000-00000000000a';
const COMPANY_B = '00000000-0000-4000-8000-00000000000b';
const SECRET_A = 'a'.repeat(40);
const SECRET_B = 'b'.repeat(40);

function credentialRow(overrides = {}) {
    return {
        id: 1,
        company_id: COMPANY_A,
        actor_user_id: null,
        scopes: ['vapi_tools:invoke'],
        expires_at: null,
        revoked_at: null,
        company_status: 'active',
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
});

afterAll(() => {
    delete process.env.BLANC_SERVER_PEPPER;
});

test('credential secret resolves to exactly its stored company', async () => {
    const byHash = new Map([
        [hashSecret(SECRET_A), credentialRow({ id: 11, company_id: COMPANY_A })],
        [hashSecret(SECRET_B), credentialRow({ id: 22, company_id: COMPANY_B })],
    ]);
    mockDbQuery.mockImplementation(async (sql, params) => {
        if (String(sql).includes('SELECT integration.id')) {
            const row = byHash.get(params[1]);
            return { rows: row ? [row] : [] };
        }
        if (String(sql).startsWith('UPDATE api_integrations')) return { rows: [{ id: params[0] }], rowCount: 1 };
        throw new Error('unexpected query');
    });

    const a = await service.resolveCredential(SECRET_A, {
        surface: service.SURFACES.VAPI_TOOLS,
        requiredScope: service.ACCESS_SCOPES.VAPI_TOOLS,
    });
    const b = await service.resolveCredential(SECRET_B, {
        surface: service.SURFACES.VAPI_TOOLS,
        requiredScope: service.ACCESS_SCOPES.VAPI_TOOLS,
    });

    expect(a).toMatchObject({ id: '11', companyId: COMPANY_A });
    expect(b).toMatchObject({ id: '22', companyId: COMPANY_B });
});

test.each([
    ['zero matches', [], 'MACHINE_CREDENTIAL_INVALID', 401],
    ['duplicate matches', [credentialRow(), credentialRow({ id: 2 })], 'MACHINE_CREDENTIAL_INVALID', 401],
    ['revoked', [credentialRow({ revoked_at: new Date() })], 'MACHINE_CREDENTIAL_REVOKED', 401],
    ['expired', [credentialRow({ expires_at: new Date(Date.now() - 1000) })], 'MACHINE_CREDENTIAL_EXPIRED', 401],
    ['wrong scope', [credentialRow({ scopes: ['other:scope'] })], 'MACHINE_CREDENTIAL_SCOPE_REQUIRED', 403],
])('%s is rejected before last_used update', async (_label, rows, code, status) => {
    mockDbQuery.mockResolvedValueOnce({ rows });

    await expect(service.resolveCredential(SECRET_A, {
        surface: service.SURFACES.VAPI_TOOLS,
        requiredScope: service.ACCESS_SCOPES.VAPI_TOOLS,
    })).rejects.toMatchObject({ code, status });

    expect(mockDbQuery).toHaveBeenCalledTimes(1);
});

test('database failure is a fail-closed 503', async () => {
    mockDbQuery.mockRejectedValue(new Error('database unavailable'));
    await expect(service.resolveCredential(SECRET_A, {
        surface: service.SURFACES.VAPI_TOOLS,
        requiredScope: service.ACCESS_SCOPES.VAPI_TOOLS,
    })).rejects.toMatchObject({ code: 'MACHINE_CREDENTIAL_UNAVAILABLE', status: 503 });
});

test('a credential revoked between lookup and conditional use is denied', async () => {
    mockDbQuery
        .mockResolvedValueOnce({ rows: [credentialRow()] })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(service.resolveCredential(SECRET_A, {
        surface: service.SURFACES.VAPI_TOOLS,
        requiredScope: service.ACCESS_SCOPES.VAPI_TOOLS,
    })).rejects.toMatchObject({ code: 'MACHINE_CREDENTIAL_INVALID', status: 401 });
});

test('provisioning requires explicit company and the surface access scope', async () => {
    await expect(service.provisionCredential({
        surface: service.SURFACES.VAPI_TOOLS,
        scopes: [service.ACCESS_SCOPES.VAPI_TOOLS],
    })).rejects.toMatchObject({ code: 'MACHINE_CREDENTIAL_COMPANY_REQUIRED' });

    await expect(service.provisionCredential({
        companyId: COMPANY_A,
        surface: service.SURFACES.VAPI_TOOLS,
        scopes: ['contacts.view'],
    })).rejects.toMatchObject({ code: 'MACHINE_CREDENTIAL_ACCESS_SCOPE_REQUIRED' });
    expect(mockDbQuery).not.toHaveBeenCalled();
});

test('Vapi status and assistant-request credentials are distinct typed surfaces', () => {
    expect(service.SURFACES.VAPI_CALL_STATUS).toBe('vapi_call_status');
    expect(service.ACCESS_SCOPES.VAPI_CALL_STATUS).toBe('vapi_call_status:invoke');
    expect(service.SURFACES.VAPI_ASSISTANT_REQUEST).toBe('vapi_assistant_request');
    expect(service.ACCESS_SCOPES.VAPI_ASSISTANT_REQUEST)
        .toBe('vapi_assistant_request:invoke');
    expect(service.SURFACES.VAPI_CALL_STATUS).not.toBe(
        service.SURFACES.VAPI_ASSISTANT_REQUEST,
    );
});

test('assistant-request surface resolves only a live credential with its exact scope', async () => {
    mockDbQuery
        .mockResolvedValueOnce({ rows: [credentialRow({
            id: 31,
            scopes: ['vapi_assistant_request:invoke'],
        })] })
        .mockResolvedValueOnce({ rows: [{ id: 31 }], rowCount: 1 });

    await expect(service.resolveCredential(SECRET_A, {
        surface: service.SURFACES.VAPI_ASSISTANT_REQUEST,
        requiredScope: service.ACCESS_SCOPES.VAPI_ASSISTANT_REQUEST,
    })).resolves.toMatchObject({
        id: '31',
        companyId: COMPANY_A,
        surface: 'vapi_assistant_request',
        scopes: ['vapi_assistant_request:invoke'],
    });

    expect(mockDbQuery.mock.calls[0][1][0]).toBe('vapi_assistant_request');
});
