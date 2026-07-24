'use strict';

jest.mock('../backend/src/db/membershipQueries', () => ({
    getActiveMembership: jest.fn(),
    getActiveMembershipInCompany: jest.fn(),
    getPermissionOverrides: jest.fn(),
    getScopeOverrides: jest.fn(),
}));

jest.mock('../backend/src/db/roleQueries', () => ({
    getRoleConfig: jest.fn(),
    getAllowedPermissionKeys: jest.fn(),
    getScopeMap: jest.fn(),
}));

const membershipQueries = require('../backend/src/db/membershipQueries');
const roleQueries = require('../backend/src/db/roleQueries');
const authorizationService = require('../backend/src/services/authorizationService');

describe('AVATARS-001 Phase A live owner authorization seam', () => {
    const client = { query: jest.fn() };

    beforeEach(() => {
        jest.clearAllMocks();
        membershipQueries.getActiveMembershipInCompany.mockResolvedValue({
            id: 'membership-a',
            user_id: 'owner-a',
            company_id: 'company-a',
            role: 'company_member',
            role_key: 'provider',
            status: 'active',
            is_primary: false,
            company_name: 'Tenant A',
            company_slug: 'tenant-a',
            company_status: 'active',
            company_timezone: 'America/New_York',
            keycloak_sub: 'kc-owner-a',
            email: 'owner-a@example.test',
            full_name: 'Alex Owner',
        });
        roleQueries.getRoleConfig.mockResolvedValue({ id: 'role-provider' });
        roleQueries.getAllowedPermissionKeys.mockResolvedValue([
            'jobs.view',
            'schedule.view',
        ]);
        roleQueries.getScopeMap.mockResolvedValue({
            job_visibility: 'assigned_only',
            financial_scope: 'none',
        });
        membershipQueries.getPermissionOverrides.mockResolvedValue([
            { permission_key: 'schedule.view', override_mode: 'deny' },
            { permission_key: 'contacts.view', override_mode: 'allow' },
        ]);
        membershipQueries.getScopeOverrides.mockResolvedValue([
            { scope_key: 'financial_scope', scope_json: 'summary' },
        ]);
    });

    test('returns DB identity plus live role permissions and scopes through the supplied client', async () => {
        const result = await authorizationService.resolveCompanyUserAuthz(
            'company-a',
            'owner-a',
            { client }
        );

        expect(result).toEqual(expect.objectContaining({
            owner_user_id: 'owner-a',
            owner_display_name: 'Alex Owner',
            owner_keycloak_sub: 'kc-owner-a',
            role_key: 'provider',
            permissions: ['contacts.view', 'jobs.view'],
            scopes: {
                job_visibility: 'assigned_only',
                financial_scope: 'summary',
            },
        }));
        expect(result.membership).toMatchObject({
            id: 'membership-a',
            role_key: 'provider',
            status: 'active',
        });
        expect(membershipQueries.getActiveMembershipInCompany)
            .toHaveBeenCalledWith('owner-a', 'company-a', client);
        expect(roleQueries.getRoleConfig)
            .toHaveBeenCalledWith('company-a', 'provider', client);
        expect(roleQueries.getAllowedPermissionKeys)
            .toHaveBeenCalledWith('role-provider', client);
        expect(roleQueries.getScopeMap)
            .toHaveBeenCalledWith('role-provider', client);
        expect(membershipQueries.getPermissionOverrides)
            .toHaveBeenCalledWith('membership-a', client);
        expect(membershipQueries.getScopeOverrides)
            .toHaveBeenCalledWith('membership-a', client);
        expect(membershipQueries.getActiveMembership).not.toHaveBeenCalled();
    });

    test.each([
        ['foreign company', null],
        ['inactive membership', null],
    ])('%s fails closed instead of selecting a primary membership', async (_label, row) => {
        membershipQueries.getActiveMembershipInCompany.mockResolvedValueOnce(row);

        await expect(authorizationService.resolveCompanyUserAuthz(
            'company-foreign',
            'owner-a',
            { client }
        )).rejects.toMatchObject({
            code: 'COMPANY_USER_ACCESS_INACTIVE',
            httpStatus: 403,
        });
        expect(membershipQueries.getActiveMembership).not.toHaveBeenCalled();
        expect(roleQueries.getRoleConfig).not.toHaveBeenCalled();
    });

    test('missing explicit company or owner context fails closed', async () => {
        await expect(authorizationService.resolveCompanyUserAuthz(null, 'owner-a'))
            .rejects.toMatchObject({ code: 'COMPANY_USER_CONTEXT_REQUIRED' });
        await expect(authorizationService.resolveCompanyUserAuthz('company-a', null))
            .rejects.toMatchObject({ code: 'COMPANY_USER_CONTEXT_REQUIRED' });
    });

    test('unknown role context fails closed instead of inheriting Dispatcher', async () => {
        membershipQueries.getActiveMembershipInCompany.mockResolvedValueOnce({
            id: 'membership-a',
            user_id: 'owner-a',
            company_id: 'company-a',
            role: 'unknown_legacy_role',
            role_key: null,
            status: 'active',
            keycloak_sub: 'kc-owner-a',
        });

        await expect(authorizationService.resolveCompanyUserAuthz(
            'company-a',
            'owner-a',
            { client }
        )).rejects.toMatchObject({ code: 'COMPANY_USER_ROLE_REQUIRED' });
        expect(roleQueries.getRoleConfig).not.toHaveBeenCalled();
    });
});
