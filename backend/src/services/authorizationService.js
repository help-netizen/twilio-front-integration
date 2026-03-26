/**
 * Authorization Service — PF007
 * 
 * Core authorization logic:
 * - resolveAuthzContext: builds full authz context from CRM user
 * - resolveEffectivePermissions: merges role matrix + user overrides
 * - resolveEffectiveScopes: merges role scopes + user scope overrides
 * 
 * This is the single authoritative source for permission resolution.
 */

const membershipQueries = require('../db/membershipQueries');
const roleQueries = require('../db/roleQueries');
const companyQueries = require('../db/companyQueries');

/**
 * Canonical permission keys for tenant_admin that cannot be removed.
 * These form the mandatory admin baseline per PF007 §5.8.
 */
const MANDATORY_ADMIN_PERMISSIONS = [
    'tenant.company.view',
    'tenant.company.manage',
    'tenant.users.view',
    'tenant.users.manage',
    'tenant.roles.view',
    'tenant.roles.manage',
];

/**
 * Legacy role → new role_key mapping for compatibility period.
 */
const LEGACY_ROLE_MAPPING = {
    'company_admin': 'tenant_admin',
    'company_member': 'dispatcher',
};

/**
 * Build the full authorization context for a CRM user.
 * This is called on every authenticated request by keycloakAuth.authenticate().
 * 
 * @param {Object} crmUser - the crm_users row from userService.findOrCreateUser()
 * @returns {Promise<Object>} authz context for req.authz
 */
async function resolveAuthzContext(crmUser) {
    if (!crmUser) {
        return {
            scope: null,
            platform_role: 'none',
            company: null,
            membership: null,
            permissions: [],
            scopes: {},
        };
    }

    const platformRole = crmUser.platform_role || 'none';

    // Platform super_admin gets platform scope only
    if (platformRole === 'super_admin') {
        return {
            scope: 'platform',
            platform_role: 'super_admin',
            company: null,
            membership: null,
            permissions: [
                'platform.companies.view',
                'platform.companies.manage',
                'platform.super_admins.manage',
                'platform.audit.view',
            ],
            scopes: {},
        };
    }

    // Try to resolve tenant membership
    const membership = await membershipQueries.getActiveMembership(crmUser.id);

    if (!membership) {
        return {
            scope: null,
            platform_role: platformRole,
            company: null,
            membership: null,
            permissions: [],
            scopes: {},
        };
    }

    // Check if company is active
    if (membership.company_status !== 'active') {
        return {
            scope: 'tenant',
            platform_role: platformRole,
            company: {
                id: membership.company_id,
                name: membership.company_name,
                slug: membership.company_slug,
                status: membership.company_status,
                timezone: membership.company_timezone,
            },
            membership: formatMembership(membership),
            permissions: [],
            scopes: {},
            _suspended: true,
        };
    }

    // Resolve effective permissions through role matrix + user overrides
    const roleKey = membership.role_key || LEGACY_ROLE_MAPPING[membership.role] || 'dispatcher';
    const { permissions, scopes } = await resolveEffectivePermissionsAndScopes(
        membership.company_id,
        roleKey,
        membership.id
    );

    return {
        scope: 'tenant',
        platform_role: platformRole,
        company: {
            id: membership.company_id,
            name: membership.company_name,
            slug: membership.company_slug,
            status: membership.company_status,
            timezone: membership.company_timezone,
        },
        membership: formatMembership(membership),
        permissions,
        scopes,
    };
}

/**
 * Resolve effective permissions and scopes for a membership.
 * Merges: role matrix permissions + user permission overrides
 *         role scopes + user scope overrides
 */
async function resolveEffectivePermissionsAndScopes(companyId, roleKey, membershipId) {
    // Get the role config for this company + role
    const roleConfig = await roleQueries.getRoleConfig(companyId, roleKey);

    if (!roleConfig) {
        // Fallback: no config found, return empty
        return { permissions: [], scopes: {} };
    }

    // Get role-level permissions and scopes
    const rolePermissionKeys = await roleQueries.getAllowedPermissionKeys(roleConfig.id);
    const roleScopeMap = await roleQueries.getScopeMap(roleConfig.id);

    // Get user-level overrides
    const permOverrides = await membershipQueries.getPermissionOverrides(membershipId);
    const scopeOverrides = await membershipQueries.getScopeOverrides(membershipId);

    // Merge permissions: start with role matrix, apply user overrides
    const permissionSet = new Set(rolePermissionKeys);
    for (const override of permOverrides) {
        if (override.override_mode === 'allow') {
            permissionSet.add(override.permission_key);
        } else if (override.override_mode === 'deny') {
            permissionSet.delete(override.permission_key);
        }
    }

    // Enforce mandatory admin baseline for tenant_admin
    if (roleKey === 'tenant_admin') {
        for (const mandatoryKey of MANDATORY_ADMIN_PERMISSIONS) {
            permissionSet.add(mandatoryKey);
        }
    }

    // Merge scopes: start with role scopes, overlay user scope overrides
    const scopeMap = { ...roleScopeMap };
    for (const override of scopeOverrides) {
        scopeMap[override.scope_key] = override.scope_json;
    }

    return {
        permissions: Array.from(permissionSet).sort(),
        scopes: scopeMap,
    };
}

/**
 * Format a membership row for the authz context.
 */
function formatMembership(membership) {
    const roleKey = membership.role_key || LEGACY_ROLE_MAPPING[membership.role] || 'dispatcher';
    const roleNames = {
        tenant_admin: 'Tenant Admin',
        manager: 'Manager',
        dispatcher: 'Dispatcher',
        provider: 'Provider',
    };

    return {
        id: membership.id,
        role_key: roleKey,
        role_name: roleNames[roleKey] || roleKey,
        is_primary: membership.is_primary || false,
        status: membership.status,
    };
}

/**
 * Build a development mode authz context (for FEATURE_AUTH_ENABLED=false).
 * Gives the dev user full tenant_admin permissions.
 */
function buildDevAuthzContext() {
    return {
        scope: 'tenant',
        platform_role: 'none',
        company: {
            id: '00000000-0000-0000-0000-000000000001',
            name: 'Boston Masters',
            slug: 'boston-masters',
            status: 'active',
            timezone: 'America/New_York',
        },
        membership: {
            id: 'dev-membership',
            role_key: 'tenant_admin',
            role_name: 'Tenant Admin',
            is_primary: true,
            status: 'active',
        },
        permissions: [
            'tenant.company.view', 'tenant.company.manage',
            'tenant.users.view', 'tenant.users.manage',
            'tenant.roles.view', 'tenant.roles.manage',
            'tenant.integrations.manage', 'tenant.telephony.manage',
            'dashboard.view', 'pulse.view',
            'messages.view_internal', 'messages.view_client', 'messages.send',
            'contacts.view', 'contacts.edit',
            'leads.view', 'leads.create', 'leads.edit', 'leads.convert',
            'jobs.view', 'jobs.create', 'jobs.edit', 'jobs.assign',
            'jobs.close', 'jobs.done_pending_approval',
            'schedule.view', 'schedule.dispatch',
            'financial_data.view',
            'estimates.view', 'estimates.create', 'estimates.send',
            'invoices.view', 'invoices.create', 'invoices.send',
            'payments.view', 'payments.collect_online', 'payments.collect_offline', 'payments.refund',
            'reports.dashboard.view', 'reports.jobs.view', 'reports.leads.view',
            'reports.calls.view', 'reports.payments.view', 'reports.financial.view',
            'client_job_history.view',
            'provider.enabled', 'phone_calls.use', 'call_masking.use',
            'gps_tracking.view', 'gps_tracking.collect',
        ],
        scopes: {
            job_visibility: 'all',
            financial_scope: 'full',
            dashboard_scope: 'all_widgets',
            report_scope: 'all',
            job_close_scope: 'close_allowed',
        },
    };
}

module.exports = {
    resolveAuthzContext,
    resolveEffectivePermissionsAndScopes,
    buildDevAuthzContext,
    LEGACY_ROLE_MAPPING,
    MANDATORY_ADMIN_PERMISSIONS,
};
