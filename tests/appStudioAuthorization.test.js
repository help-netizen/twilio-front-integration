'use strict';

const mockDbQuery = jest.fn();

jest.mock('../backend/src/db/connection', () => ({ query: mockDbQuery }));

const authorizationService = require('../backend/src/services/authorizationService');

const COMPANY_ID = '10000000-0000-4000-8000-000000000001';
const USER_ID = '20000000-0000-4000-8000-000000000001';

let primaryMembership;
let explicitMembership;

beforeEach(() => {
    jest.clearAllMocks();
    primaryMembership = {
        id: 'membership-primary',
        user_id: USER_ID,
        company_id: COMPANY_ID,
        role: 'company_member',
        role_key: 'dispatcher',
        status: 'active',
        is_primary: true,
        company_name: 'Tenant A',
        company_slug: 'tenant-a',
        company_status: 'active',
        company_timezone: 'America/New_York',
        company_app_studio_enabled: true,
    };
    explicitMembership = {
        ...primaryMembership,
        id: 'membership-explicit',
        is_primary: false,
        keycloak_sub: 'kc-owner-a',
        email: 'owner-a@example.test',
        full_name: 'Owner A',
    };
    mockDbQuery.mockImplementation(async sql => {
        const text = String(sql);
        if (text.includes('FROM company_memberships m') && text.includes('ORDER BY')) {
            return { rows: [primaryMembership] };
        }
        if (text.includes('FROM company_memberships m') && text.includes('JOIN crm_users u')) {
            return { rows: [explicitMembership] };
        }
        return { rows: [] };
    });
});

describe('APP-STUDIO-GATE-002 authorization company projection', () => {
    test('active tenant session carries app_studio_enabled from the membership query', async () => {
        const context = await authorizationService.resolveAuthzContext({
            id: USER_ID,
            platform_role: 'none',
        });

        expect(context.company).toMatchObject({
            id: COMPANY_ID,
            app_studio_enabled: true,
        });
        const membershipSql = String(mockDbQuery.mock.calls[0][0]);
        expect(membershipSql).toContain(
            'COALESCE(c.app_studio_enabled, false) AS company_app_studio_enabled'
        );
    });

    test('suspended tenant session still carries the company flag', async () => {
        primaryMembership.company_status = 'suspended';

        const context = await authorizationService.resolveAuthzContext({
            id: USER_ID,
            platform_role: 'none',
        });

        expect(context._suspended).toBe(true);
        expect(context.company.app_studio_enabled).toBe(true);
    });

    test('missing or null membership projection defaults to false', async () => {
        primaryMembership.company_app_studio_enabled = null;

        const context = await authorizationService.resolveAuthzContext({
            id: USER_ID,
            platform_role: 'none',
        });

        expect(context.company.app_studio_enabled).toBe(false);
    });

    test('explicit-company authorization carries the flag from its tenant-scoped query', async () => {
        const context = await authorizationService.resolveCompanyUserAuthz(
            COMPANY_ID,
            USER_ID
        );

        expect(context.company.app_studio_enabled).toBe(true);
        const membershipCall = mockDbQuery.mock.calls.find(
            ([sql]) => String(sql).includes('JOIN crm_users u')
        );
        expect(String(membershipCall[0])).toContain(
            'COALESCE(c.app_studio_enabled, false) AS company_app_studio_enabled'
        );
        expect(membershipCall[1]).toEqual([USER_ID, COMPANY_ID]);
    });

    test('development company context defaults App Studio to false', () => {
        const context = authorizationService.buildDevAuthzContext();
        expect(context.company.app_studio_enabled).toBe(false);
    });
});
