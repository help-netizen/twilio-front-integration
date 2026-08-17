'use strict';

const fs = require('fs');
const path = require('path');

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));

const registry = require('../backend/src/services/vapiAssistantRegistryService');

const COMPANY_A = '00000000-0000-4000-8000-00000000000a';
const COMPANY_B = '00000000-0000-4000-8000-00000000000b';

function profile(overrides = {}) {
    return {
        assistant_profile_id: 'profile-a',
        company_id: COMPANY_A,
        purpose: registry.PURPOSES.OUTBOUND_PARTS,
        environment: 'prod',
        vapi_assistant_id: 'assistant-a',
        provider_connection_id: 'connection-a',
        provider_account_key: 'vapi:platform',
        tools_credential_id: '11',
        call_status_credential_id: '12',
        ...overrides,
    };
}

function inbound(overrides = {}) {
    return {
        tenant_resource_id: 'resource-a',
        company_id: COMPANY_A,
        purpose: registry.PURPOSES.INBOUND_QUALIFICATION,
        environment: 'prod',
        sip_uri: 'sip:a@sip.vapi.ai',
        provider_connection_id: 'connection-a',
        assistant_request_credential_id: '13',
        assistant_profile_id: 'profile-inbound-a',
        expected_vapi_assistant_id: 'assistant-inbound-a',
        tools_credential_ready: true,
        call_status_credential_ready: true,
        ...overrides,
    };
}

function outbound(overrides = {}) {
    return {
        assistant_profile_id: 'profile-a',
        company_id: COMPANY_A,
        purpose: registry.PURPOSES.OUTBOUND_PARTS,
        environment: 'prod',
        expected_vapi_assistant_id: 'assistant-a',
        provider_connection_id: 'connection-a',
        provider_account_key: 'vapi:platform',
        tenant_resource_id: 'outbound-resource-a',
        resource_type: 'vapi_phone_number',
        vapi_phone_number_id: 'phone-a',
        twilio_phone_number: null,
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
});

test('T-own resolves one active profile through company, purpose and environment', async () => {
    mockQuery.mockResolvedValue({ rows: [profile()] });

    await expect(registry.resolveActiveProfile({
        companyId: COMPANY_A,
        purpose: registry.PURPOSES.OUTBOUND_PARTS,
        environment: 'prod',
    })).resolves.toMatchObject({
        company_id: COMPANY_A,
        vapi_assistant_id: 'assistant-a',
    });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('WHERE profile.company_id = $1');
    expect(sql).toContain('profile.purpose = $2');
    expect(sql).toContain('profile.environment = $3');
    expect(sql).toContain("profile.status = 'active'");
    expect(sql).toContain("tools_credential.machine_surface = 'vapi_tools'");
    expect(sql).toContain("status_credential.machine_surface = 'vapi_call_status'");
    expect(params).toEqual([
        COMPANY_A,
        registry.PURPOSES.OUTBOUND_PARTS,
        'prod',
        'vapi:platform',
    ]);
});

test('T-foreign/T-blast rejects a row outside the requested company even if provider id matches', async () => {
    mockQuery.mockResolvedValue({ rows: [profile({ company_id: COMPANY_B })] });

    await expect(registry.resolveActiveProfile({
        companyId: COMPANY_A,
        purpose: registry.PURPOSES.OUTBOUND_PARTS,
    })).rejects.toMatchObject({
        code: 'VAPI_REGISTRY_PROFILE_SCOPE_MISMATCH',
    });
});

test.each([
    ['missing', []],
    ['inactive/filter miss', []],
    ['ambiguous', [profile(), profile({ assistant_profile_id: 'profile-a-2' })]],
])('%s mapping fails closed', async (_label, rows) => {
    mockQuery.mockResolvedValue({ rows });
    await expect(registry.resolveActiveProfile({
        companyId: COMPANY_A,
        purpose: registry.PURPOSES.OUTBOUND_PARTS,
    })).rejects.toMatchObject({ code: 'VAPI_REGISTRY_PROFILE_UNAVAILABLE' });
});

test('inbound tuple requires company-owned assistant/resource/request credential, not accounting readiness', async () => {
    mockQuery.mockResolvedValue({ rows: [inbound()] });

    await expect(registry.resolveInboundTuple({
        companyId: COMPANY_A,
    })).resolves.toMatchObject({
        company_id: COMPANY_A,
        tenant_resource_id: 'resource-a',
        expected_vapi_assistant_id: 'assistant-inbound-a',
    });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('WHERE resource.company_id = $1');
    expect(sql).toContain("assistant_request_credential.machine_surface = 'vapi_assistant_request'");
    expect(sql).toContain("FROM api_integrations status_credential");
    expect(sql).not.toContain('JOIN api_integrations status_credential');
    expect(params[0]).toBe(COMPANY_A);
});

test('SAB-FIX5: revoked call-status credential is telemetry, never inbound admission', async () => {
    mockQuery.mockResolvedValue({ rows: [inbound({ call_status_credential_ready: false })] });

    await expect(registry.resolveInboundTuple({ companyId: COMPANY_A })).resolves.toMatchObject({
        company_id: COMPANY_A,
        expected_vapi_assistant_id: 'assistant-inbound-a',
        call_status_credential_ready: false,
    });
});

test('tokenless assistant selection is scoped by authenticated company and server registry', async () => {
    mockQuery.mockResolvedValue({ rows: [inbound()] });

    await expect(registry.resolveInboundAssistant({ companyId: COMPANY_A })).resolves.toMatchObject({
        company_id: COMPANY_A,
        expected_vapi_assistant_id: 'assistant-inbound-a',
    });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('WHERE resource.company_id = $1');
    expect(params[0]).toBe(COMPANY_A);
});

test('tokenless assistant selection can use the company resource safety snapshot without a profile', async () => {
    mockQuery.mockResolvedValue({ rows: [inbound({ assistant_profile_id: null })] });

    await expect(registry.resolveInboundAssistant({ companyId: COMPANY_A })).resolves.toMatchObject({
        company_id: COMPANY_A,
        expected_vapi_assistant_id: 'assistant-inbound-a',
    });
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('resource.fallback_vapi_assistant_id');
    expect(sql).toContain('LEFT JOIN vapi_assistant_profiles linked_profile');
    expect(sql).toContain('foreign_profile.company_id <> resource.company_id');
});

test.each([
    ['missing/inactive', []],
    ['ambiguous', [inbound(), inbound({ tenant_resource_id: 'resource-a-2' })]],
])('inbound %s tuple fails closed', async (_label, rows) => {
    mockQuery.mockResolvedValue({ rows });

    await expect(registry.resolveInboundTuple({
        companyId: COMPANY_A,
    })).rejects.toMatchObject({ code: 'VAPI_REGISTRY_INBOUND_TUPLE_UNAVAILABLE' });
});

test('inbound rejects a foreign tuple even if its SIP and assistant ids look valid', async () => {
    mockQuery.mockResolvedValue({ rows: [inbound({ company_id: COMPANY_B })] });

    await expect(registry.resolveInboundTuple({
        companyId: COMPANY_A,
    })).rejects.toMatchObject({ code: 'VAPI_REGISTRY_INBOUND_SCOPE_MISMATCH' });
});

test('outbound tuple resolves assistant and caller through the same company scope', async () => {
    mockQuery.mockResolvedValue({ rows: [outbound()] });

    await expect(registry.resolveOutboundTuple({
        companyId: COMPANY_A,
        purpose: registry.PURPOSES.OUTBOUND_PARTS,
    })).resolves.toMatchObject({
        company_id: COMPANY_A,
        expected_vapi_assistant_id: 'assistant-a',
        vapi_phone_number_id: 'phone-a',
    });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('WHERE profile.company_id = $1');
    expect(sql).toContain('resource.company_id = profile.company_id');
    expect(sql).toContain('resource.purpose = $5');
    expect(params).toEqual([
        COMPANY_A,
        registry.PURPOSES.OUTBOUND_PARTS,
        'prod',
        'vapi:platform',
        'outbound_call',
    ]);
});

test.each([
    ['missing/inactive', []],
    ['ambiguous', [outbound(), outbound({ tenant_resource_id: 'outbound-resource-a2' })]],
])('outbound %s tuple fails closed', async (_label, rows) => {
    mockQuery.mockResolvedValue({ rows });
    await expect(registry.resolveOutboundTuple({
        companyId: COMPANY_A,
        purpose: registry.PURPOSES.OUTBOUND_PARTS,
    })).rejects.toMatchObject({ code: 'VAPI_REGISTRY_OUTBOUND_TUPLE_UNAVAILABLE' });
});

test('outbound rejects a foreign assistant/number tuple even when provider ids look valid', async () => {
    mockQuery.mockResolvedValue({ rows: [outbound({ company_id: COMPANY_B })] });
    await expect(registry.resolveOutboundTuple({
        companyId: COMPANY_A,
        purpose: registry.PURPOSES.OUTBOUND_PARTS,
    })).rejects.toMatchObject({ code: 'VAPI_REGISTRY_OUTBOUND_SCOPE_MISMATCH' });
});

test.each([
    [undefined, registry.PURPOSES.OUTBOUND_PARTS],
    ['parts_visit', registry.PURPOSES.OUTBOUND_PARTS],
    ['lead_call', registry.PURPOSES.OUTBOUND_LEAD],
])('server scenario %p maps to purpose %s', (scenario, purpose) => {
    expect(registry.purposeForOutboundScenario(scenario)).toBe(purpose);
});

test('unknown external scenario cannot select a profile', () => {
    expect(() => registry.purposeForOutboundScenario('outbound_lead_call'))
        .toThrow(expect.objectContaining({
            code: 'VAPI_REGISTRY_OUTBOUND_SCENARIO_UNSUPPORTED',
        }));
});

test('rollout state is never a runtime admission condition', () => {
    for (const relativePath of [
        '../backend/src/services/callFlowRuntime.js',
        '../backend/src/services/vapiAssistantRegistryService.js',
        '../backend/src/services/vapiCallIdentityService.js',
    ]) {
        const source = fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
        expect(source).not.toContain('rollout_state');
    }
});
