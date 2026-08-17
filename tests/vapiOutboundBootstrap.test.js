'use strict';

jest.mock('../backend/src/db/connection', () => ({
    getClient: jest.fn(),
    pool: { end: jest.fn() },
}));

const bootstrap = require('../backend/scripts/bootstrap-vapi-outbound-resource');

const COMPANY = '30000000-0000-4000-8000-000000000001';

test('dry-run is default and company id is mandatory', () => {
    expect(bootstrap.parseArgs(['--company-id', COMPANY])).toEqual({
        companyId: COMPANY,
        apply: false,
    });
    expect(() => bootstrap.parseArgs([])).toThrow(expect.objectContaining({
        code: 'VAPI_OUTBOUND_BOOTSTRAP_COMPANY_ID_REQUIRED',
    }));
});

test.each([
    [{ VAPI_OUTBOUND_PHONE_NUMBER_ID: 'pn_registry' }, 'vapi_phone_number'],
    [{
        VAPI_OUTBOUND_TWILIO_NUMBER: '+16175006181',
        TWILIO_ACCOUNT_SID: 'ACtest',
        TWILIO_AUTH_TOKEN: 'test-token',
    }, 'transient_twilio'],
])('caller is read once by the operational step, never runtime fallback', (environment, resourceType) => {
    expect(bootstrap.readCallerResource(environment)).toMatchObject({ resourceType });
});

test('missing or ambiguous caller configuration aborts the operational step', () => {
    expect(() => bootstrap.readCallerResource({})).toThrow(expect.objectContaining({
        code: 'VAPI_OUTBOUND_BOOTSTRAP_CALLER_REQUIRED',
    }));
    expect(() => bootstrap.readCallerResource({
        VAPI_OUTBOUND_PHONE_NUMBER_ID: 'pn_registry',
        VAPI_OUTBOUND_TWILIO_NUMBER: '+16175006181',
    })).toThrow(expect.objectContaining({
        code: 'VAPI_OUTBOUND_BOOTSTRAP_CALLER_REQUIRED',
    }));
    expect(() => bootstrap.readCallerResource({
        VAPI_OUTBOUND_TWILIO_NUMBER: '+16175006181',
    })).toThrow(expect.objectContaining({
        code: 'VAPI_OUTBOUND_BOOTSTRAP_TWILIO_CREDENTIALS_REQUIRED',
    }));
});

test('inspectPlan scopes connection, both profiles, and caller ownership to company', async () => {
    const query = jest.fn()
        .mockResolvedValueOnce({
            rows: [{ id: 'connection-a', tenant_id: 'tenant-a', company_id: COMPANY }],
        })
        .mockResolvedValueOnce({
            rows: [
                {
                    id: 'lead-a',
                    company_id: COMPANY,
                    provider_connection_id: 'connection-a',
                    purpose: 'outbound_lead_call',
                    environment: 'prod',
                },
                {
                    id: 'parts-a',
                    company_id: COMPANY,
                    provider_connection_id: 'connection-a',
                    purpose: 'outbound_parts_call',
                    environment: 'prod',
                },
            ],
        })
        .mockResolvedValueOnce({ rows: [] });
    const caller = bootstrap.readCallerResource({
        VAPI_OUTBOUND_PHONE_NUMBER_ID: 'pn_registry',
    });

    await expect(bootstrap.inspectPlan({ query }, {
        companyId: COMPANY,
        caller,
    })).resolves.toMatchObject({ companyId: COMPANY, caller });

    expect(query.mock.calls[0][0]).toContain('WHERE company_id = $1');
    expect(query.mock.calls[1][0]).toContain('WHERE company_id = $1');
    expect(query.mock.calls[2][0]).toContain('company_id <> $3');
});

test('apply upserts one generic outbound resource with an explicit company predicate', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: 'resource-a' }], rowCount: 1 });
    await bootstrap.applyPlan({ query }, {
        companyId: COMPANY,
        connection: { id: 'connection-a', tenant_id: 'tenant-a' },
        caller: bootstrap.readCallerResource({
            VAPI_OUTBOUND_TWILIO_NUMBER: '+16175006181',
            TWILIO_ACCOUNT_SID: 'ACtest',
            TWILIO_AUTH_TOKEN: 'test-token',
        }),
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (company_id, purpose, environment)');
    expect(sql).toContain('WHERE company_id IS NOT NULL');
    expect(sql).toContain("'outbound_call'");
    expect(params).toContain(COMPANY);
    expect(params).toContain('+16175006181');
});
